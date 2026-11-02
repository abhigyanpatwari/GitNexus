/**
 * Real-DB coverage for #3306: loadCachedEmbeddings must stream CodeEmbedding
 * rows instead of getAll()+map(Number) of the whole table, and must be able
 * to spill vectors so incremental analyze does not keep every embedding in
 * the V8 heap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import { batchInsertEmbeddings } from '../../src/core/embeddings/embedding-pipeline.js';
import {
  disposeEmbeddingSpill,
  materializeCachedEmbeddings,
} from '../../src/core/embeddings/embedding-restore-spill.js';

describe('loadCachedEmbeddings streaming (#3306)', () => {
  let tmp: TestDBHandle | undefined;

  afterEach(async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    try {
      await adapter.closeLbug();
    } catch {
      /* already closed */
    }
    await tmp?.cleanup();
    tmp = undefined;
  });

  async function seedDb(rowCount: number) {
    tmp = await createTempDir('gitnexus-lbug-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(dbPath);
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      nodeId: `Function:src/f${i}.ts:fn${i}:1`,
      chunkIndex: 0,
      startLine: 1,
      endLine: 3,
      embedding: Array.from({ length: EMBEDDING_DIMS }, (__, d) => (d === 0 ? i + 1 : 0)),
      contentHash: `hash-${i}`,
    }));
    await batchInsertEmbeddings(adapter.executeWithReusedStatement, rows);
    return { adapter, rows };
  }

  it('materializes a small table in RAM (skip-fts / mock-compatible shape)', async () => {
    const { adapter, rows } = await seedDb(3);
    const cached = await adapter.loadCachedEmbeddings();
    expect(cached.spill).toBeUndefined();
    expect(cached.embeddings).toHaveLength(3);
    expect(cached.rows).toHaveLength(3);
    expect(cached.embeddingNodeIds.size).toBe(3);
    expect(cached.embeddings.map((e) => e.nodeId).sort()).toEqual(rows.map((r) => r.nodeId).sort());
    expect(cached.embeddings.find((e) => e.nodeId === rows[1]!.nodeId)?.embedding[0]).toBe(2);
  });

  it('streams into a spill file when the in-memory limit is 0 and restores a subset', async () => {
    const { adapter, rows } = await seedDb(12);
    const cached = await adapter.loadCachedEmbeddings({ inMemoryRowLimit: 0 });
    try {
      expect(cached.embeddings).toEqual([]);
      expect(cached.spill?.rowCount).toBe(12);
      expect(cached.rows).toHaveLength(12);
      const wanted = new Set([rows[0]!.nodeId, rows[5]!.nodeId, rows[10]!.nodeId]);
      const subset = materializeCachedEmbeddings(
        cached,
        cached.rows.filter((meta) => wanted.has(meta.nodeId)),
      );
      expect(subset).toHaveLength(3);
      const byId = new Map(subset.map((row) => [row.nodeId, row]));
      expect(byId.get(rows[0]!.nodeId)?.embedding[0]).toBe(1);
      expect(byId.get(rows[5]!.nodeId)?.embedding[0]).toBe(6);
      expect(byId.get(rows[10]!.nodeId)?.embedding[0]).toBe(11);
      expect(byId.get(rows[0]!.nodeId)?.contentHash).toBe(rows[0]!.contentHash);
    } finally {
      disposeEmbeddingSpill(cached.spill);
    }
  });

  it('flips from RAM to spill once a non-zero in-memory limit is crossed', async () => {
    const { adapter, rows } = await seedDb(8);
    const cached = await adapter.loadCachedEmbeddings({ inMemoryRowLimit: 4 });
    try {
      expect(cached.embeddings).toEqual([]);
      expect(cached.spill?.rowCount).toBe(8);
      expect(cached.rows).toHaveLength(8);
      expect(fs.statSync(cached.spill!.path).size).toBe(12 + 8 * EMBEDDING_DIMS * 4);
      const wanted = new Set([rows[2]!.nodeId, rows[3]!.nodeId]);
      const subset = materializeCachedEmbeddings(
        cached,
        cached.rows.filter((meta) => wanted.has(meta.nodeId)),
      );
      expect(subset).toHaveLength(2);
      const byId = new Map(subset.map((row) => [row.nodeId, row]));
      expect(byId.get(rows[2]!.nodeId)?.embedding[0]).toBe(3);
      expect(byId.get(rows[3]!.nodeId)?.embedding[0]).toBe(4);
    } finally {
      disposeEmbeddingSpill(cached.spill);
    }
  });

  it('surfaces a spill write failure instead of adopting an empty snapshot', async () => {
    const { adapter } = await seedDb(3);
    const spillDir = path.join(tmp!.dbPath, 'not-a-directory');
    fs.writeFileSync(spillDir, 'x');
    await expect(adapter.loadCachedEmbeddings({ inMemoryRowLimit: 0, spillDir })).rejects.toThrow(
      /ENOTDIR|not a directory|ENOSPC|EACCES/i,
    );
  });
});
