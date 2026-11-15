import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EmbeddingByteBudget } from '../../src/core/analysis-resource-budget.js';
import {
  createEmbeddingWorkManifest,
  fetchEmbeddingWorkUnit,
  loadEmbeddingWorkManifest,
  readEmbeddingWorkUnits,
  type EmbeddingManifestSource,
  type EmbeddingWorkKey,
} from '../../src/core/embeddings/embedding-work-manifest.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';
import {
  readEmbeddingJobRecord,
  writeEmbeddingJobRecord,
} from '../../src/storage/embedding-job.js';

const directories: string[] = [];
const temporary = async (): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-work-manifest-'));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function synthetic(
  count: number,
  contentBytes = 1024,
): EmbeddingManifestSource & { scans: number; fetches: number; largestFetch: number } {
  return {
    scans: 0,
    fetches: 0,
    largestFetch: 0,
    async *scan(label: string): AsyncGenerator<EmbeddingWorkKey> {
      this.scans++;
      if (label !== 'Function') return;
      for (let i = 0; i < count; i++)
        yield {
          id: `Function:f.ts:fn${String(i).padStart(8, '0')}`,
          contentBytes,
          metadataBytes: 1024,
        };
    },
    async fetch(label: string, ids: readonly string[]): Promise<EmbeddableNode[]> {
      this.fetches++;
      this.largestFetch = Math.max(this.largestFetch, ids.length);
      return ids
        .map((id) => ({
          id,
          name: id,
          label,
          filePath: 'f.ts',
          content: 'x'.repeat(contentBytes),
          startLine: 1,
          endLine: 1,
        }))
        .reverse();
    },
  };
}

describe('durable embedding selection', () => {
  it('resumes by cursor without rescanning or refetching completed nodes', async () => {
    const directory = await temporary();
    const source = synthetic(130);
    const receipt = await createEmbeddingWorkManifest(directory, 'graph-a', source);
    expect(receipt.totalNodes).toBe(130);
    expect(receipt.totalUnits).toBe(3);
    const budget = new EmbeddingByteBudget(512 * 1024);
    const units = readEmbeddingWorkUnits(directory, receipt);
    const first = await units.next();
    if (first.done) throw new Error('Missing first unit');
    const fetched = await fetchEmbeddingWorkUnit(source, first.value.unit, budget);
    expect(fetched.nodes[0].id).toBe(first.value.unit.nodes[0].id);
    fetched.release();
    await units.return(undefined);
    const scans = source.scans;
    const reloaded = await loadEmbeddingWorkManifest(directory, 'graph-a');
    const remaining: number[] = [];
    for await (const item of readEmbeddingWorkUnits(directory, reloaded, first.value.next)) {
      remaining.push(item.unit.ordinal);
      const loaded = await fetchEmbeddingWorkUnit(source, item.unit, budget);
      expect(loaded.nodes.some((node) => node.id === first.value.unit.nodes[0].id)).toBe(false);
      loaded.release();
    }
    expect(remaining).toEqual([1, 2]);
    expect(source.scans).toBe(scans);
    expect(source.fetches).toBe(3);
    expect(budget.usedBytes).toBe(0);
  });

  it('bounds fetched payloads independently of a lazily generated corpus size', async () => {
    const peaks: number[] = [];
    for (const count of [10_000, 100_000, 1_000_000]) {
      const directory = await temporary();
      const source = synthetic(count);
      const receipt = await createEmbeddingWorkManifest(directory, 'graph-a', source);
      const budget = new EmbeddingByteBudget(512 * 1024);
      let read = 0;
      for await (const { unit } of readEmbeddingWorkUnits(directory, receipt)) {
        const fetched = await fetchEmbeddingWorkUnit(source, unit, budget);
        read += fetched.nodes.length;
        fetched.release();
      }
      expect(read).toBe(count);
      expect(source.largestFetch).toBe(64);
      expect(budget.usedBytes).toBe(0);
      peaks.push(budget.peakBytes);
    }
    expect(peaks).toEqual([256 * 1024, 256 * 1024, 256 * 1024]);
  }, 30_000);

  it('gives an oversized node its own stable unit and admits it explicitly', async () => {
    const directory = await temporary();
    const source = synthetic(2, 2 * 1024 * 1024);
    const receipt = await createEmbeddingWorkManifest(directory, 'graph-a', source);
    expect(receipt.totalUnits).toBe(2);
    for await (const { unit } of readEmbeddingWorkUnits(directory, receipt)) {
      const before = source.fetches;
      await expect(
        fetchEmbeddingWorkUnit(source, unit, new EmbeddingByteBudget(1024)),
      ).rejects.toThrow('requires');
      expect(source.fetches).toBe(before);
      const fetched = await fetchEmbeddingWorkUnit(
        source,
        unit,
        new EmbeddingByteBudget(5 * 1024 * 1024),
      );
      expect(fetched.nodes[0].content.length).toBe(2 * 1024 * 1024);
      fetched.release();
    }
  });

  it('rejects cross-label duplicate identities before publishing a selection', async () => {
    const directory = await temporary();
    const source = synthetic(0);
    source.scan = async function* (label) {
      if (label === 'Function' || label === 'Class')
        yield { id: 'shared-id', contentBytes: 1, metadataBytes: 1024 };
    };
    await expect(createEmbeddingWorkManifest(directory, 'graph-a', source)).rejects.toThrow(
      'duplicate graph node identity',
    );
    expect(source.fetches).toBe(0);
    await expect(fs.stat(path.join(directory, 'manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not substitute File fallback when a symbol scan fails', async () => {
    const directory = await temporary();
    const labels: string[] = [];
    const source = synthetic(0);
    source.scan = async function* (label) {
      labels.push(label);
      throw new Error('graph read failed');
    };
    await expect(createEmbeddingWorkManifest(directory, 'graph-a', source)).rejects.toThrow(
      'graph read failed',
    );
    expect(labels).not.toContain('File');
  });

  it('selects File only after every symbol label is empty', async () => {
    const directory = await temporary();
    const source = synthetic(0);
    source.scan = async function* (label) {
      if (label === 'File') yield { id: 'File:README.md', contentBytes: 12, metadataBytes: 1024 };
    };
    const receipt = await createEmbeddingWorkManifest(directory, 'graph-a', source);
    for await (const result of readEmbeddingWorkUnits(directory, receipt)) {
      expect(result.unit.label).toBe('File');
      break;
    }
    expect(receipt.totalNodes).toBe(1);
  });

  it('rejects source drift and releases its reserved capacity on a failed fetch', async () => {
    const directory = await temporary();
    const source = synthetic(1);
    const receipt = await createEmbeddingWorkManifest(directory, 'graph-a', source);
    const iterator = readEmbeddingWorkUnits(directory, receipt);
    const first = await iterator.next();
    if (first.done) throw new Error('Missing unit');
    await iterator.return(undefined);
    const budget = new EmbeddingByteBudget(4096);
    source.fetch = async () => [];
    await expect(fetchEmbeddingWorkUnit(source, first.value.unit, budget)).rejects.toThrow(
      'missing or duplicate',
    );
    expect(budget.usedBytes).toBe(0);
    source.fetch = async () => [
      {
        id: first.value.unit.nodes[0].id,
        label: 'Function',
        name: 'f',
        filePath: 'f.ts',
        content: 'changed',
      },
    ];
    await expect(fetchEmbeddingWorkUnit(source, first.value.unit, budget)).rejects.toThrow(
      'graph changed',
    );
    expect(budget.usedBytes).toBe(0);
  });

  it('preserves and rejects corrupt or foreign selections', async () => {
    const directory = await temporary();
    await createEmbeddingWorkManifest(directory, 'graph-a', synthetic(1));
    await expect(loadEmbeddingWorkManifest(directory, 'graph-b')).rejects.toThrow('identity');
    await fs.appendFile(path.join(directory, 'manifest.jsonl'), '{}\n');
    await expect(loadEmbeddingWorkManifest(directory, 'graph-a')).rejects.toThrow('size mismatch');
    expect((await fs.stat(path.join(directory, 'manifest.jsonl'))).size).toBeGreaterThan(0);
  });

  it('rejects a misaligned durable cursor', async () => {
    const directory = await temporary();
    const receipt = await createEmbeddingWorkManifest(directory, 'graph-a', synthetic(65));
    await expect(
      readEmbeddingWorkUnits(directory, receipt, { unit: 1, offset: 0 }).next(),
    ).rejects.toThrow('Invalid embedding work unit');
  });
});

describe('compact embedding receipts', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses symlink receipts and job directories',
    async () => {
      const directory = await temporary();
      const outside = await temporary();
      await writeEmbeddingJobRecord(outside, 'job.json', { cursor: 1 });
      await fs.symlink(path.join(outside, 'job.json'), path.join(directory, 'job.json'));
      await expect(readEmbeddingJobRecord(directory, 'job.json')).rejects.toThrow('regular file');
      await fs.symlink(outside, path.join(directory, 'linked-job'));
      await expect(
        readEmbeddingJobRecord(path.join(directory, 'linked-job'), 'job.json'),
      ).rejects.toThrow('owned directory');
    },
  );

  it('checks the checksum and bounds record sizes', async () => {
    const directory = await temporary();
    await writeEmbeddingJobRecord(directory, 'job.json', { cursor: 3 });
    expect(await readEmbeddingJobRecord(directory, 'job.json')).toEqual({ cursor: 3 });
    const file = path.join(directory, 'job.json');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('"cursor":3', '"cursor":4'));
    await expect(readEmbeddingJobRecord(directory, 'job.json')).rejects.toThrow('checksum');
    await expect(writeEmbeddingJobRecord(directory, '../job.json', {})).rejects.toThrow('name');
    await expect(
      writeEmbeddingJobRecord(directory, 'job.json', { padding: 'x'.repeat(40_000) }),
    ).rejects.toThrow('size limit');
    await fs.writeFile(file, 'x'.repeat(40_000));
    await expect(readEmbeddingJobRecord(directory, 'job.json')).rejects.toThrow('size limit');
  });
});
