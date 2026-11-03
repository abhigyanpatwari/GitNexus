import path from 'node:path';
import fs from 'node:fs/promises';
import lbug from '@ladybugdb/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VectorStore, type VectorStoreOptions } from '../../src/core/lbug/vector-store.js';
import { openLbugConnection, closeLbugConnection } from '../../src/core/lbug/lbug-config.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

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
  await store?.close();
  store = undefined;
  await temporary?.cleanup();
  temporary = undefined;
  vi.unstubAllEnvs();
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
