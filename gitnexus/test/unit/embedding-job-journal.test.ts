import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingJobJournal,
  type EmbeddingUnitIntent,
} from '../../src/storage/embedding-job-journal.js';
import {
  readEmbeddingJobRecord,
  writeEmbeddingJobRecord,
} from '../../src/storage/embedding-job.js';
import type { EmbeddingManifestReceipt } from '../../src/core/embeddings/embedding-work-manifest.js';
import { embeddingJobIdentity } from '../../src/core/embeddings/embedding-job-identity.js';

const identity = 'a'.repeat(64);
const manifest: EmbeddingManifestReceipt = {
  version: 1,
  digest: 'b'.repeat(64),
  sourceIdentity: 'c'.repeat(64),
  bytes: 30,
  totalNodes: 6,
  totalUnits: 3,
  maximumUnitBytes: 100,
};
const unit = (n: number, origin: 'manifest' | 'failed' = 'manifest'): EmbeddingUnitIntent => ({
  start: { unit: n, offset: n * 10 },
  next: { unit: n + 1, offset: (n + 1) * 10 },
  nodes: 2,
  origin,
});
const directories: string[] = [];
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}
async function job() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-embedding-journal-'));
  directories.push(directory);
  return EmbeddingJobJournal.create(directory, identity, manifest);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { force: true, recursive: true });
});

describe('durable embedding scheduling', () => {
  it('keeps the journal usable after validation fails before any write', async () => {
    const journal = await job();
    await expect(journal.indexing()).rejects.toThrow('accounting');
    await journal.begin(unit(0));
    await expect(journal.acknowledge({ reusedNodes: 3, chunks: 2 })).rejects.toThrow(
      'acknowledgement',
    );
    await journal.acknowledge({ reusedNodes: 2, chunks: 2 });
    await expect(journal.fail('provider')).rejects.toThrow('Invalid embedding failure');
    await journal.begin(unit(1));
    expect(journal.snapshot()).toMatchObject({ reusedUnits: 1, active: unit(1) });
  });

  it('requires reopening after a failed-unit write succeeds but its receipt fails', async () => {
    const journal = await job();
    await journal.begin(unit(0));
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (path.basename(String(to)) === 'failed-0000000000000000.json')
        throw new Error('injected failure after failed-unit rename');
    });
    await expect(journal.fail('provider')).rejects.toThrow('injected');
    await expect(journal.acknowledge({ reusedNodes: 0, chunks: 2 })).rejects.toThrow(
      'durability uncertain',
    );
  });

  it('refuses foreign failed-unit identity instead of resetting another job', async () => {
    const journal = await job();
    await journal.begin(unit(0));
    await journal.fail('provider');
    const name = 'failed-0000000000000000.json';
    const record = (await readEmbeddingJobRecord(journal.directory, name)) as Record<
      string,
      unknown
    >;
    await writeEmbeddingJobRecord(journal.directory, name, { ...record, identity: 'f'.repeat(64) });
    const before = await fs.readFile(path.join(journal.directory, 'job.json'), 'utf8');
    await expect(
      EmbeddingJobJournal.recover(journal.directory, identity, manifest),
    ).rejects.toThrow('identity mismatch');
    expect(await fs.readFile(path.join(journal.directory, 'job.json'), 'utf8')).toBe(before);
    expect((await fs.readdir(journal.directory)).some((name) => name.includes('.preserved-'))).toBe(
      false,
    );
  });

  it('propagates failure-record access errors without resetting valid accounting', async () => {
    const journal = await job();
    const before = await fs.readFile(path.join(journal.directory, 'job.json'), 'utf8');
    vi.spyOn(fs, 'opendir').mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { code: 'EACCES' }),
    );
    await expect(
      EmbeddingJobJournal.recover(journal.directory, identity, manifest),
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(await fs.readFile(path.join(journal.directory, 'job.json'), 'utf8')).toBe(before);
  });

  it('retains an active retry whose old failed record was already removed', async () => {
    let journal = await job();
    await journal.begin(unit(0));
    await journal.fail('provider');
    await journal.begin(unit(0, 'failed'));
    await fs.unlink(path.join(journal.directory, 'failed-0000000000000000.json'));
    journal = await EmbeddingJobJournal.recover(journal.directory, identity, manifest);
    expect(journal.snapshot()).toMatchObject({ failedUnits: 0, active: unit(0, 'failed') });
    await journal.acknowledge({ reusedNodes: 2, chunks: 2 });
    expect(journal.snapshot()).toMatchObject({ reusedUnits: 1, active: null });
  });
  it('resumes only the active unit and keeps acknowledged counts', async () => {
    let journal = await job();
    await journal.begin(unit(0));
    await journal.acknowledge({ reusedNodes: 0, chunks: 3 });
    await journal.begin(unit(1));
    journal = await EmbeddingJobJournal.open(journal.directory, identity, manifest);
    expect(journal.snapshot()).toMatchObject({
      completedUnits: 1,
      completedNodes: 2,
      cursor: { unit: 1, offset: 10 },
      active: unit(1),
      chunks: 3,
    });
    await journal.acknowledge({ reusedNodes: 2, chunks: 4 });
    await journal.begin(unit(2));
    await journal.acknowledge({ reusedNodes: 1, chunks: 2 });
    await journal.indexing();
    await journal.ready();
    expect(
      (await EmbeddingJobJournal.open(journal.directory, identity, manifest)).snapshot(),
    ).toMatchObject({
      phase: 'ready',
      completedUnits: 2,
      reusedUnits: 1,
      completedNodes: 3,
      reusedNodes: 3,
      chunks: 9,
      active: null,
    });
  });

  it('keeps failures retryable across arbitrarily many invocations', async () => {
    let journal = await job();
    await journal.begin(unit(0));
    await journal.fail('provider');
    expect(await collect(journal.failed())).toEqual([]);
    for (let attempt = 0; attempt < 5; attempt++) {
      journal = await EmbeddingJobJournal.open(journal.directory, identity, manifest);
      expect(await collect(journal.failed())).toEqual([unit(0, 'failed')]);
      await journal.begin(unit(0, 'failed'));
      expect(journal.snapshot()).toMatchObject({
        failedUnits: 0,
        failedNodes: 0,
        active: unit(0, 'failed'),
      });
      await journal.fail('provider');
      expect(journal.snapshot()).toMatchObject({
        failedUnits: 1,
        failedNodes: 2,
        cursor: { unit: 1, offset: 10 },
      });
      expect(await collect(journal.failed())).toEqual([]);
    }
    journal = await EmbeddingJobJournal.open(journal.directory, identity, manifest);
    await journal.begin(unit(0, 'failed'));
    await journal.acknowledge({ reusedNodes: 0, chunks: 2 });
    expect(await collect(journal.failed())).toEqual([]);
    expect(journal.snapshot()).toMatchObject({ completedUnits: 1, failedUnits: 0 });
  });

  it('replays the active failed unit after its record was removed but before cursor acknowledgement', async () => {
    let journal = await job();
    await journal.begin(unit(0));
    await journal.fail('provider');
    journal = await EmbeddingJobJournal.open(journal.directory, identity, manifest);
    await journal.begin(unit(0, 'failed'));
    await fs.unlink(path.join(journal.directory, 'failed-0000000000000000.json'));
    journal = await EmbeddingJobJournal.open(journal.directory, identity, manifest);
    expect(journal.snapshot().active).toEqual(unit(0, 'failed'));
    await journal.acknowledge({ reusedNodes: 2, chunks: 2 });
    expect(journal.snapshot()).toMatchObject({ failedUnits: 0, reusedUnits: 1 });
  });

  it('reconciles an uncertain acknowledgement by reopening instead of counting twice', async () => {
    let journal = await job();
    await journal.begin(unit(0));
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to).endsWith('/job.json')) throw new Error('injected failure after rename');
    });
    await expect(journal.acknowledge({ reusedNodes: 0, chunks: 2 })).rejects.toThrow('injected');
    await expect(journal.begin(unit(1))).rejects.toThrow('durability uncertain');
    vi.restoreAllMocks();
    journal = await EmbeddingJobJournal.open(journal.directory, identity, manifest);
    expect(journal.snapshot()).toMatchObject({
      completedUnits: 1,
      completedNodes: 2,
      active: null,
      cursor: { unit: 1, offset: 10 },
    });
    await journal.begin(unit(1));
  });

  it('rejects concurrent mutation instead of queuing unbounded intents', async () => {
    const journal = await job();
    const first = journal.begin(unit(0));
    await expect(journal.begin(unit(0))).rejects.toThrow('Concurrent');
    await first;
    expect(journal.snapshot().active).toEqual(unit(0));
  });

  it.each(['identity', 'manifest', 'checksum', 'accounting', 'cursor'])(
    'retains artifacts on corrupt %s',
    async (kind) => {
      const journal = await job();
      await fs.writeFile(path.join(journal.directory, 'vectors'), 'retained');
      if (kind === 'checksum')
        await fs.writeFile(
          path.join(journal.directory, 'job.json'),
          '{"checksum":"bad","payload":{}}',
        );
      if (kind === 'accounting')
        await writeEmbeddingJobRecord(journal.directory, 'job.json', {
          ...journal.snapshot(),
          completedUnits: 1,
        });
      if (kind === 'cursor')
        await writeEmbeddingJobRecord(journal.directory, 'job.json', {
          ...journal.snapshot(),
          cursor: { unit: 0, offset: 9 },
        });
      await expect(
        EmbeddingJobJournal.open(
          journal.directory,
          kind === 'identity' ? 'f'.repeat(64) : identity,
          kind === 'manifest' ? { ...manifest, digest: 'd'.repeat(64) } : manifest,
        ),
      ).rejects.toThrow();
      expect(await fs.readFile(path.join(journal.directory, 'vectors'), 'utf8')).toBe('retained');
    },
  );

  it('cannot publish incomplete coverage or mutate the live state through a snapshot', async () => {
    const journal = await job();
    journal.snapshot().cursor.unit = 100;
    expect(journal.snapshot().cursor.unit).toBe(0);
    await expect(journal.indexing()).rejects.toThrow('accounting');
    expect(await readEmbeddingJobRecord(journal.directory, 'job.json')).toMatchObject({
      phase: 'embedding',
    });
  });

  it('validates failure filenames without accepting traversal', async () => {
    const journal = await job();
    await expect(
      writeEmbeddingJobRecord(journal.directory, '../failed-0000000000000000.json', {}),
    ).rejects.toThrow('name');
    await expect(writeEmbeddingJobRecord(journal.directory, 'failed-0.json', {})).rejects.toThrow(
      'name',
    );
  });
});

describe('embedding job identity', () => {
  const graph = {
    generation: 'generation',
    coveredContent: 'dirty-coverage',
    revision: 'revision',
    analyzer: 'analyzer',
    parser: 'parser',
    schema: 'schema',
    vectorSchema: 'vectors-v2',
  };
  const vector = { provider: 'local', model: 'model', dimensions: 384 };
  const config = {
    chunkSize: 2000,
    overlap: 100,
    maxSnippetLength: 2000,
    maxDescriptionLength: 500,
    maxInputChars: 8192,
  };
  it('excludes scheduling options and unrelated credential fields', () => {
    const expanded = {
      ...config,
      batchSize: 1,
      threads: 1,
      resourceBudget: 1024,
      apiKey: 'secret',
    };
    expect(embeddingJobIdentity(graph, vector, 'v7', expanded)).toEqual(
      embeddingJobIdentity(graph, vector, 'v7', config),
    );
  });
  it('invalidates on each coverage and input dimension', () => {
    const base = embeddingJobIdentity(graph, vector, 'v7', config);
    for (const key of Object.keys(graph))
      expect(
        embeddingJobIdentity({ ...graph, [key]: 'changed' }, vector, 'v7', config).identity,
      ).not.toBe(base.identity);
    for (const key of Object.keys(config))
      expect(
        embeddingJobIdentity(graph, vector, 'v7', {
          ...config,
          [key]: config[key as keyof typeof config] + 1,
        }).identity,
      ).not.toBe(base.identity);
    expect(
      embeddingJobIdentity(graph, { ...vector, dimensions: 768 }, 'v7', config).identity,
    ).not.toBe(base.identity);
    expect(
      embeddingJobIdentity(graph, { ...vector, model: 'other' }, 'v7', config).identity,
    ).not.toBe(base.identity);
    expect(() =>
      embeddingJobIdentity(
        graph,
        { ...vector, provider: 'https://user:secret@example.com' },
        'v7',
        config,
      ),
    ).toThrow();
  });
});
