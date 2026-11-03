import path from 'node:path';
import fs from 'node:fs/promises';
import lbug from '@ladybugdb/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VectorStore, type VectorStoreOptions } from '../../src/core/lbug/vector-store.js';
import { openLbugConnection, closeLbugConnection } from '../../src/core/lbug/lbug-config.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { EmbeddingGraphSource } from '../../src/core/lbug/embedding-source.js';
import { runEmbeddingJob } from '../../src/core/embeddings/embedding-job-runner.js';
import {
  createEmbeddingWorkManifest,
  loadEmbeddingWorkManifest,
} from '../../src/core/embeddings/embedding-work-manifest.js';
import { EmbeddingJobJournal } from '../../src/storage/embedding-job-journal.js';
import { HttpEmbeddingError } from '../../src/core/embeddings/http-client.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

let temporary: TestDBHandle | undefined;
let store: VectorStore;
const chunk = (chunkIndex: number) => ({
  chunkIndex,
  startLine: 1,
  endLine: 2,
  embedding: [0.1, 0.2, 0.3, 0.4],
});
async function setup() {
  temporary = await createTempDir();
  vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
  const options: VectorStoreOptions = {
    directory: temporary.dbPath,
    identity: 'a'.repeat(64),
    dimensions: 4,
    bufferPoolBytes: 64 * 1024 * 1024,
    threads: 1,
    batchBytes: 64 * 1024,
    mode: 'create',
  };
  store = await VectorStore.open(options);
  return options;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await store?.close();
  store = undefined;
  await temporary?.cleanup();
  temporary = undefined;
  vi.unstubAllEnvs();
});

async function runnerFixture(count: number, content = 'const value = "漢😀";') {
  const options = await setup();
  const node = (id: string): EmbeddableNode => ({
    id,
    name: id.split(':').at(-1),
    label: 'Const',
    filePath: 'source.ts',
    content,
    startLine: 1,
    endLine: 1,
  });
  const fetch = vi.fn(async (_label: string, ids: readonly string[]) => ids.map(node));
  const source = {
    async *scan(label: string) {
      if (label !== 'Const') return;
      for (let i = 0; i < count; i++)
        yield {
          id: `Const:source.ts:n${String(i).padStart(5, '0')}`,
          contentBytes: Buffer.byteLength(content),
          metadataBytes: 1024,
        };
    },
    fetch,
  };
  const manifest = await createEmbeddingWorkManifest(options.directory, 'source', source);
  let journal = await EmbeddingJobJournal.create(options.directory, options.identity, manifest);
  const initializeProvider = vi.fn(async () => {});
  const provider = vi.fn(async (texts: string[]) =>
    texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4])),
  );
  const run = (extra = {}) =>
    runEmbeddingJob({
      directory: options.directory,
      manifest,
      source,
      journal,
      store,
      queueBytes: 32 * 1024 * 1024,
      config: { subBatchSize: 8, maxInputChars: 1024 },
      provider,
      initializeProvider,
      ...extra,
    });
  const reopen = async (recover = false) => {
    await store.close();
    store = await VectorStore.open({ ...options, mode: 'resume' });
    const selection = await loadEmbeddingWorkManifest(options.directory, 'source');
    journal = await (recover ? EmbeddingJobJournal.recover : EmbeddingJobJournal.open).call(
      EmbeddingJobJournal,
      options.directory,
      options.identity,
      selection,
    );
  };
  return {
    options,
    source,
    manifest,
    get journal() {
      return journal;
    },
    initializeProvider,
    provider,
    run,
    reopen,
  };
}

describe('bounded durable embedding runner', () => {
  it('copies compatible complete vectors into a new generation without re-embedding', async () => {
    const fixture = await runnerFixture(3, 'const value = "漢😀";'.repeat(300));
    const first = await fixture.run();
    const previous = store;
    const directory = path.join(fixture.options.directory, 'next-generation');
    await fs.mkdir(directory);
    const manifest = await createEmbeddingWorkManifest(directory, 'new-source', fixture.source);
    const identity = 'b'.repeat(64);
    const journal = await EmbeddingJobJournal.create(directory, identity, manifest);
    store = await VectorStore.open({ ...fixture.options, directory, identity });
    const shiftedSource = {
      ...fixture.source,
      fetch: async (label: string, ids: readonly string[]) =>
        (await fixture.source.fetch(label, ids)).map((node) => ({
          ...node,
          startLine: 50,
          endLine: 50,
        })),
    };
    const provider = vi.fn(async () => {
      throw new Error('Reuse must not call provider');
    });
    try {
      const result = await runEmbeddingJob({
        directory,
        manifest,
        source: shiftedSource,
        journal,
        store,
        reuse: previous,
        provider,
        config: { maxInputChars: 1024 },
        queueBytes: 32 * 1024 * 1024,
      });
      expect(result.state).toMatchObject({
        reusedNodes: 3,
        completedNodes: 0,
        chunks: first.state.chunks,
      });
      expect(provider).not.toHaveBeenCalled();
      const copied = await store.completedNodes(['Const:source.ts:n00000']);
      const receipt = copied.get('Const:source.ts:n00000');
      expect(receipt).toMatchObject({ sourceStartLine: 50, sourceEndLine: 50 });
      expect((await store.readChunks(receipt, 0, 1))[0]).toMatchObject({
        startLine: 50,
        endLine: 50,
      });
    } finally {
      await previous.close();
    }
  });

  it.each(['before', 'after'] as const)(
    'replaces an interrupted chunk group after a %s-write failure',
    async (when) => {
      const fixture = await runnerFixture(65);
      const append = store.appendBatch.bind(store);
      let calls = 0;
      vi.spyOn(store, 'appendBatch').mockImplementation(async (rows) => {
        if (++calls === 9) {
          if (when === 'after') await append(rows);
          throw new Error('simulated write failure');
        }
        await append(rows);
      });
      await expect(fixture.run()).rejects.toThrow('write failure');
      expect(fixture.journal.snapshot()).toMatchObject({
        completedNodes: 64,
        active: { start: { unit: 1 } },
      });
      await fixture.reopen();
      fixture.provider.mockClear();
      expect((await fixture.run()).state).toMatchObject({
        completedNodes: 65,
        chunks: 65,
        failedUnits: 0,
      });
      const paid = fixture.provider.mock.calls.flatMap(([texts]) => texts);
      expect(paid).toHaveLength(1);
      expect(paid[0]).toContain('n00064');
    },
  );

  it('preserves a corrupt journal and reconstructs complete native coverage without provider calls', async () => {
    const fixture = await runnerFixture(65);
    await fixture.run();
    const recordPath = path.join(fixture.options.directory, 'job.json');
    const damaged = '{"checksum":"bad","payload":{}}';
    await fs.writeFile(recordPath, damaged);
    await fixture.reopen(true);
    fixture.provider.mockClear();
    fixture.source.fetch.mockClear();
    const result = await fixture.run();
    expect(result.state).toMatchObject({
      reusedNodes: 65,
      chunks: 65,
      failedUnits: 0,
      phase: 'indexing',
    });
    expect(fixture.provider).not.toHaveBeenCalled();
    expect(fixture.source.fetch).not.toHaveBeenCalled();
    const saved = (await fs.readdir(fixture.options.directory)).filter((name) =>
      name.startsWith('job.json.preserved-'),
    );
    expect(saved).toHaveLength(1);
    expect(await fs.readFile(path.join(fixture.options.directory, saved[0]), 'utf8')).toBe(damaged);
  });

  it('scans only keys and byte bounds, then fetches a bounded PK unit from an immutable graph', async () => {
    const options = await setup();
    const graphPath = path.join(options.directory, 'source-graph');
    const handle = await openLbugConnection(lbug, graphPath, {
      bufferPoolBytes: 64 * 1024 * 1024,
      threads: 1,
    });
    const query = async (sql: string) => {
      const result = await handle.conn.query(sql);
      for (const part of Array.isArray(result) ? result : [result]) part.close();
    };
    try {
      await query(
        'CREATE NODE TABLE File(id STRING, name STRING, filePath STRING, content STRING, PRIMARY KEY(id))',
      );
      await query(
        'CREATE NODE TABLE Function(id STRING, name STRING, filePath STRING, content STRING, description STRING, startLine INT64, endLine INT64, isExported BOOL, PRIMARY KEY(id))',
      );
      await query(
        "CREATE (:Function {id:'Function:a:漢', name:'漢', filePath:'a.ts', content:'漢😀\ntext', startLine:2, endLine:3, isExported:true})",
      );
      await query("CREATE (:File {id:'File:a', name:'a', filePath:'a.md', content:'漢😀\ntext'})");
      await query(
        "CREATE (:File {id:'File:blank', name:'blank', filePath:'blank.md', content:'\u00a0\u3000\ufeff'})",
      );
      await query(
        "CREATE (:File {id:'File:binary', name:'binary', filePath:'binary.dat', content:'[Binary file - content not stored]'})",
      );
      await query('CHECKPOINT');
    } finally {
      await closeLbugConnection(handle);
    }
    const source = await EmbeddingGraphSource.open(graphPath, 64 * 1024 * 1024, 1);
    try {
      const keys = [];
      for await (const key of source.scan('Function')) keys.push(key);
      expect(keys).toEqual([
        { id: 'Function:a:漢', contentBytes: 12, metadataBytes: expect.any(Number) },
      ]);
      const nodes = await source.fetch('Function', [keys[0].id]);
      expect(nodes[0]).toMatchObject({
        id: 'Function:a:漢',
        content: '漢😀\ntext',
        startLine: 2,
        endLine: 3,
        isExported: true,
      });
      expect(keys[0].metadataBytes).toBeGreaterThanOrEqual(
        Buffer.byteLength(JSON.stringify({ ...nodes[0], content: undefined })),
      );
      const files = [];
      for await (const key of source.scan('File')) files.push(key.id);
      expect(files).toEqual(['File:a']);
      expect((await source.fetch('File', files))[0]).toMatchObject({ startLine: 1, endLine: 2 });
      await expect(source.fetch('Function', Array(65).fill('id'))).rejects.toThrow('unit');
      await expect(source.scan('Unknown').next()).rejects.toThrow('label');
    } finally {
      await source.close();
    }
  });

  it('recovers native durability before cursor acknowledgement without repeating paid inputs', async () => {
    const fixture = await runnerFixture(130);
    const acknowledge = fixture.journal.acknowledge.bind(fixture.journal);
    let acks = 0;
    vi.spyOn(fixture.journal, 'acknowledge').mockImplementation(async (result) => {
      if (++acks === 2) throw new Error('simulated cursor write failure');
      await acknowledge(result);
    });
    await expect(fixture.run()).rejects.toThrow('cursor write');
    expect(fixture.journal.snapshot()).toMatchObject({
      completedNodes: 64,
      active: { start: { unit: 1 } },
    });
    await fixture.reopen();
    fixture.provider.mockClear();
    fixture.source.fetch.mockClear();
    const result = await fixture.run({
      queueBytes: 8 * 1024 * 1024,
      config: { subBatchSize: 2, maxInputChars: 1024 },
    });
    expect(fixture.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(2);
    expect(fixture.source.fetch.mock.calls.flatMap(([, ids]) => ids)).toHaveLength(2);
    expect(result.state).toMatchObject({
      phase: 'indexing',
      completedNodes: 66,
      reusedNodes: 64,
      failedUnits: 0,
      chunks: 130,
    });
    // A crash after seal but before publication requires no model/source work.
    await fixture.reopen();
    fixture.provider.mockClear();
    fixture.source.fetch.mockClear();
    expect((await fixture.run()).indexKind).toBe('exact');
    expect(fixture.provider).not.toHaveBeenCalled();
    expect(fixture.source.fetch).not.toHaveBeenCalled();
  });

  it('keeps one rejected input retryable while preserving every healthy sibling', async () => {
    const fixture = await runnerFixture(12);
    fixture.provider.mockImplementation(async (texts) => {
      if (texts.some((text) => text.includes('n00003')))
        throw new HttpEmbeddingError('bad input', { status: 400 });
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
    });
    const first = await fixture.run();
    expect(first.indexKind).toBeUndefined();
    expect(first.state).toMatchObject({ failedUnits: 1, phase: 'embedding', active: null });
    expect(
      (
        await store.completedNodes(
          Array.from({ length: 12 }, (_, i) => `Const:source.ts:n${String(i).padStart(5, '0')}`),
        )
      ).size,
    ).toBe(11);
    await fixture.reopen();
    fixture.provider.mockClear();
    fixture.provider.mockImplementation(async (texts) =>
      texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4])),
    );
    fixture.source.fetch.mockClear();
    const result = await fixture.run();
    expect(fixture.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(1);
    expect(fixture.source.fetch.mock.calls[0][1]).toEqual(['Const:source.ts:n00003']);
    expect(result.state).toMatchObject({
      failedUnits: 0,
      completedNodes: 1,
      reusedNodes: 11,
      chunks: 12,
    });
  });

  it('bounds one oversized node by bytes and preserves all generated Unicode input', async () => {
    const content = '漢😀abcdef'.repeat(60000);
    const fixture = await runnerFixture(1, content);
    let chars = 0;
    let requests = 0;
    // Do not retain the fixture's requests: test the actual production queue.
    const provider = async (texts: string[]) => {
      requests++;
      expect(texts.length).toBeLessThanOrEqual(8);
      expect(texts.every((text) => text.length <= 1024)).toBe(true);
      expect(texts.every((text) => !/[\uD800-\uDBFF]$/.test(text))).toBe(true);
      chars += texts.reduce((n, text) => n + text.length, 0);
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
    };
    const result = await fixture.run({ provider });
    expect(chars).toBeGreaterThan(content.length);
    expect(chars).toBeLessThan(content.length + 100);
    expect(requests).toBeGreaterThan(50);
    expect(result.peakQueueBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(result.state.completedNodes).toBe(1);
  });

  it('rejects impossible admission before intent, provider initialization, or vector mutation', async () => {
    const fixture = await runnerFixture(1, 'x'.repeat(100000));
    const begin = vi.spyOn(store, 'beginNodes');
    await expect(fixture.run({ queueBytes: 1024 * 1024 })).rejects.toThrow(
      'larger resource budget',
    );
    expect(fixture.initializeProvider).not.toHaveBeenCalled();
    expect(fixture.provider).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(fixture.journal.snapshot().active).toBeNull();
  });

  it('does not bisect endpoint outages and stops at the existing consecutive-failure ceiling', async () => {
    const fixture = await runnerFixture(100);
    fixture.provider.mockRejectedValue(new HttpEmbeddingError('unavailable', { status: 503 }));
    await expect(fixture.run()).rejects.toThrow('unavailable');
    expect(fixture.provider).toHaveBeenCalledTimes(5);
    expect(fixture.journal.snapshot()).toMatchObject({
      failedUnits: 1,
      completedNodes: 0,
      active: null,
    });
  });

  it('leaves a durable active unit on cancellation and never writes a late provider response', async () => {
    const fixture = await runnerFixture(20);
    const controller = new AbortController();
    const append = vi.spyOn(store, 'appendBatch');
    fixture.provider.mockImplementation(async (texts) => {
      controller.abort();
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
    });
    await expect(fixture.run({ signal: controller.signal })).rejects.toThrow();
    expect(fixture.provider).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
    expect(fixture.journal.snapshot().active).not.toBeNull();
  });
});

describe('separate durable vector artifacts', () => {
  it('writes a multi-node unit and verifies a large node in bounded batches', async () => {
    const options = await setup();
    const nodes = [0, 1].map((i) => ({ nodeId: `Function:a:node${i}`, contentHash: 'hash' }));
    await store.beginNodes(nodes);
    for (let start = 0; start < 600; start += 128) {
      const rows = Array.from({ length: Math.min(128, 600 - start) }, (_, i) => ({
        ...nodes[start + i < 300 ? 0 : 1],
        ...chunk((start + i) % 300),
      }));
      await store.appendBatch(rows);
    }
    const receipts = await store.finishNodes(nodes.map((node) => ({ ...node, chunks: 300 })));
    await store.checkpointUnit(receipts);
    await store.close();
    store = await VectorStore.open({ ...options, mode: 'resume' });
    for (const receipt of receipts)
      expect(await store.reusable(receipt.nodeId, receipt.contentHash)).toEqual(receipt);
    expect(await store.seal(2, 600)).toBe('exact');
  });

  it('publishes an empty artifact without loading a model or ANN extension', async () => {
    const options = await setup();
    expect(await store.seal(0, 0)).toBe('exact');
    await store.close();
    store = await VectorStore.open({ ...options, mode: 'read' });
  });

  it('replays incomplete groups and removes surplus old chunks without damaging completed groups', async () => {
    const options = await setup();
    await store.beginNode('Function:a:complete', 'hash');
    await store.append('Function:a:complete', 'hash', [chunk(0)]);
    const complete = await store.finishNode('Function:a:complete', 'hash', 1);
    await store.checkpointUnit([complete]);
    await store.beginNode('Function:a:active', 'old');
    await store.append('Function:a:active', 'old', [chunk(0), chunk(1), chunk(2)]);
    await store.close();
    store = await VectorStore.open({ ...options, mode: 'resume' });
    expect(await store.reusable('Function:a:active', 'old')).toBeNull();
    expect(await store.reusable('Function:a:complete', 'hash')).toEqual(complete);
    await store.beginNode('Function:a:active', 'new');
    await store.append('Function:a:active', 'new', [chunk(0)]);
    const active = await store.finishNode('Function:a:active', 'new', 1);
    await store.checkpointUnit([active]);
    expect(await store.seal(2, 2)).toBe('exact');
    await store.close();
    store = await VectorStore.open({ ...options, mode: 'read' });
    expect(await store.reusable('Function:a:active', 'new')).toEqual(active);
    await expect(store.beginNode('Function:a:active', 'other')).rejects.toThrow('immutable');
  });

  it('rejects invalid batches before mutation and never acknowledges a partial node', async () => {
    await setup();
    await store.beginNode('Function:a:node', 'hash');
    for (const invalid of [
      chunk(1),
      { ...chunk(0), embedding: [NaN, 0, 0, 0] },
      { ...chunk(0), embedding: [0, 0] },
      { ...chunk(0), endLine: 0 },
    ]) {
      await expect(store.append('Function:a:node', 'hash', [invalid])).rejects.toThrow();
    }
    await store.append('Function:a:node', 'hash', [chunk(0)]);
    await expect(
      store.checkpointUnit([
        { nodeId: 'Function:a:node', contentHash: 'hash', chunks: 1, complete: true },
      ]),
    ).rejects.toThrow('incomplete');
    await expect(store.finishNode('Function:a:node', 'hash', 2)).rejects.toThrow('coverage');
    await expect(store.seal(1, 1)).rejects.toThrow('incomplete');
    const receipt = await store.finishNode('Function:a:node', 'hash', 1);
    await store.checkpointUnit([receipt]);
  });

  it('refuses identity mismatch, missing chunks, and unpublished readers', async () => {
    const options = await setup();
    await store.beginNode('Function:a:node', 'hash');
    await store.append('Function:a:node', 'hash', [chunk(0), chunk(1)]);
    const receipt = await store.finishNode('Function:a:node', 'hash', 2);
    await store.checkpointUnit([receipt]);
    await store.close();
    store = undefined;
    await expect(VectorStore.open({ ...options, mode: 'read' })).rejects.toThrow('not complete');
    await expect(
      VectorStore.open({ ...options, mode: 'resume', identity: 'b'.repeat(64) }),
    ).rejects.toThrow('identity');
    const handle = await openLbugConnection(lbug, path.join(options.directory, 'vectors'), {
      bufferPoolBytes: options.bufferPoolBytes,
      threads: 1,
    });
    try {
      const result = await handle.conn.query(
        "MATCH (e:CodeEmbedding {id:'Function:a:node:1'}) DELETE e",
      );
      for (const part of Array.isArray(result) ? result : [result]) part.close();
    } finally {
      await closeLbugConnection(handle);
    }
    store = await VectorStore.open({ ...options, mode: 'resume' });
    await expect(store.reusable('Function:a:node', 'hash')).rejects.toThrow('missing chunks');
  });

  it('keeps a separately published graph readable while the vector writer is open', async () => {
    const options = await setup();
    const graphPath = path.join(options.directory, 'graph');
    let graph = await openLbugConnection(lbug, graphPath, {
      bufferPoolBytes: 64 * 1024 * 1024,
      threads: 1,
    });
    const run = async (sql: string) => {
      const result = await graph.conn.query(sql);
      const parts = Array.isArray(result) ? result : [result];
      try {
        return await parts[0].getAll();
      } finally {
        parts.forEach((part) => part.close());
      }
    };
    await run('CREATE NODE TABLE Function(id STRING, PRIMARY KEY(id))');
    await run("CREATE (:Function {id:'Function:a:node'})");
    await run('CHECKPOINT');
    await closeLbugConnection(graph);
    graph = await openLbugConnection(lbug, graphPath, {
      readOnly: true,
      bufferPoolBytes: 64 * 1024 * 1024,
      threads: 1,
    });
    try {
      await store.beginNode('Function:a:node', 'hash');
      await store.append('Function:a:node', 'hash', [chunk(0)]);
      expect(await run('MATCH (n:Function) RETURN n.id AS id')).toEqual([
        { id: 'Function:a:node' },
      ]);
    } finally {
      await closeLbugConnection(graph);
    }
  });

  it('does not replace an existing artifact or accept an unbounded reservation', async () => {
    const options = await setup();
    await expect(VectorStore.open(options)).rejects.toThrow('exists');
    await expect(VectorStore.open({ ...options, bufferPoolBytes: 0 })).rejects.toThrow(
      'reservation',
    );
    expect((await fs.stat(path.join(options.directory, 'vectors'))).isFile()).toBe(true);
  });
});
