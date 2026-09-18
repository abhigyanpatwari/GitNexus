import { existsSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abortCachedEmbeddingsBuilder,
  cacheRowCount,
  createCachedEmbeddingsBuilder,
  DEFAULT_EMBEDDING_CACHE_IN_MEMORY_ROW_LIMIT,
  discardLiveEmbeddingSpills,
  discardScopedEmbeddingSpills,
  disposeEmbeddingSpill,
  EmbeddingSpillReader,
  finalizeCachedEmbeddingsSnapshot,
  ingestCachedEmbeddingRow,
  materializeCachedEmbeddings,
  normalizeCachedEmbeddings,
  readSpillVectors,
  resolveEmbeddingCacheInMemoryRowLimit,
  snapshotEmbeddingDims,
  withEmbeddingSpillScope,
} from '../../src/core/embeddings/embedding-restore-spill.js';

const DIMS = 8;

function vector(fill: number): number[] {
  return Array.from({ length: DIMS }, () => fill);
}

function row(id: string, fill: number, hash = `hash-${id}`) {
  return {
    nodeId: id,
    chunkIndex: 0,
    startLine: 1,
    endLine: 2,
    embedding: vector(fill),
    contentHash: hash,
  };
}

describe('embedding-restore-spill (#3306)', () => {
  const spills: Array<{ path: string }> = [];
  afterEach(() => {
    for (const spill of spills) disposeEmbeddingSpill(spill);
    spills.length = 0;
  });

  it('keeps small tables in RAM and does not leave a spill file', () => {
    const builder = createCachedEmbeddingsBuilder({
      inMemoryRowLimit: 4,
      spillDir: os.tmpdir(),
    });
    ingestCachedEmbeddingRow(builder, row('n1', 0.25), true);
    ingestCachedEmbeddingRow(builder, row('n2', 0.5), true);
    const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
    expect(snapshot.spill).toBeUndefined();
    expect(existsSync(builder.writer.path)).toBe(false);
    expect(snapshot.embeddings).toHaveLength(2);
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.embeddings[0]?.embedding[0]).toBeCloseTo(0.25);
    expect(cacheRowCount(snapshot)).toBe(2);
    expect(snapshotEmbeddingDims(snapshot)).toBe(DIMS);
  });

  it('spills vectors once the in-memory limit is exceeded and materializes a subset', () => {
    const builder = createCachedEmbeddingsBuilder({
      inMemoryRowLimit: 2,
      spillDir: os.tmpdir(),
    });
    for (let i = 0; i < 5; i++) {
      ingestCachedEmbeddingRow(builder, row(`n${i}`, i + 1), true);
    }
    const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
    if (snapshot.spill) spills.push(snapshot.spill);
    expect(snapshot.embeddings).toEqual([]);
    expect(snapshot.spill?.rowCount).toBe(5);
    expect(existsSync(snapshot.spill!.path)).toBe(true);
    expect(snapshot.embeddingNodeIds.size).toBe(5);

    const subset = materializeCachedEmbeddings(snapshot, snapshot.rows.slice(1, 3));
    expect(subset).toHaveLength(2);
    expect(subset[0]?.nodeId).toBe('n1');
    expect(subset[0]?.embedding[0]).toBeCloseTo(2);
    expect(subset[1]?.embedding[0]).toBeCloseTo(3);
  });

  it('always spills when the in-memory limit is 0 (no Number[] table in RAM)', () => {
    const builder = createCachedEmbeddingsBuilder({
      inMemoryRowLimit: 0,
      spillDir: os.tmpdir(),
    });
    ingestCachedEmbeddingRow(builder, row('only', 0.75), true);
    const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
    if (snapshot.spill) spills.push(snapshot.spill);
    expect(snapshot.embeddings).toEqual([]);
    expect(snapshot.rows).toHaveLength(1);
    expect(materializeCachedEmbeddings(snapshot, snapshot.rows)[0]?.embedding[0]).toBeCloseTo(0.75);
  });

  it('aborts an unfinished builder without leaking a spill file', () => {
    const builder = createCachedEmbeddingsBuilder({
      inMemoryRowLimit: 0,
      spillDir: os.tmpdir(),
    });
    ingestCachedEmbeddingRow(builder, row('n1', 1), true);
    expect(existsSync(builder.writer.path)).toBe(true);
    abortCachedEmbeddingsBuilder(builder);
    expect(existsSync(builder.writer.path)).toBe(false);
  });

  it('normalizes mock {embeddings} payloads so Phase 3.5 can restore without a spill', () => {
    const snapshot = normalizeCachedEmbeddings({
      embeddingNodeIds: new Set(['Function:a:foo']),
      embeddings: [
        {
          nodeId: 'Function:a:foo',
          chunkIndex: 0,
          startLine: 0,
          endLine: 3,
          embedding: vector(0.1),
          contentHash: 'stub',
        },
      ],
    });
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.vectorIndex).toBe(0);
    const restored = materializeCachedEmbeddings(snapshot, snapshot.rows);
    expect(restored[0]?.contentHash).toBe('stub');
    expect(restored[0]?.embedding).toHaveLength(DIMS);
  });

  it('defaults the in-memory row limit to 2048 and honors GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT', () => {
    expect(DEFAULT_EMBEDDING_CACHE_IN_MEMORY_ROW_LIMIT).toBe(2048);
    vi.stubEnv('GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT', '');
    expect(resolveEmbeddingCacheInMemoryRowLimit()).toBe(2048);
    vi.stubEnv('GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT', '0');
    expect(resolveEmbeddingCacheInMemoryRowLimit()).toBe(0);
    vi.stubEnv('GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT', '12');
    expect(resolveEmbeddingCacheInMemoryRowLimit()).toBe(12);
    vi.stubEnv('GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT', 'nope');
    expect(resolveEmbeddingCacheInMemoryRowLimit()).toBe(2048);
    vi.unstubAllEnvs();
    expect(resolveEmbeddingCacheInMemoryRowLimit(7)).toBe(7);
    expect(resolveEmbeddingCacheInMemoryRowLimit(-1)).toBe(2048);
  });

  it('spills above the default 2048-row limit with header-plus-body size 12 + N * D * 4', () => {
    const n = DEFAULT_EMBEDDING_CACHE_IN_MEMORY_ROW_LIMIT + 1;
    const builder = createCachedEmbeddingsBuilder({ spillDir: os.tmpdir() });
    for (let i = 0; i < n; i++) {
      ingestCachedEmbeddingRow(builder, row(`n${i}`, 1), true);
    }
    const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
    if (snapshot.spill) spills.push(snapshot.spill);
    expect(snapshot.embeddings).toEqual([]);
    expect(snapshot.spill?.rowCount).toBe(n);
    expect(statSync(snapshot.spill!.path).size).toBe(12 + n * DIMS * 4);
  });

  it('rejects a dim mismatch once spilling and rejects a short or bad-magic header', () => {
    const builder = createCachedEmbeddingsBuilder({
      inMemoryRowLimit: 0,
      spillDir: os.tmpdir(),
    });
    ingestCachedEmbeddingRow(builder, row('a', 1), true);
    expect(() =>
      ingestCachedEmbeddingRow(builder, { ...row('b', 2), embedding: [1, 2, 3] }, true),
    ).toThrow(/dim mismatch/);
    abortCachedEmbeddingsBuilder(builder);

    const shortPath = path.join(os.tmpdir(), `gitnexus-embed-restore-short-${process.pid}.bin`);
    writeFileSync(shortPath, Buffer.from('NOPE'));
    spills.push({ path: shortPath });
    expect(() => readSpillVectors({ path: shortPath, dims: DIMS, rowCount: 1 }, [0])).toThrow(
      /invalid embedding spill header/,
    );

    const badMagic = Buffer.alloc(12);
    badMagic.write('NOPE', 0, 4, 'ascii');
    badMagic.writeUInt8(1, 4);
    badMagic.writeUInt32LE(DIMS, 5);
    const badPath = path.join(os.tmpdir(), `gitnexus-embed-restore-bad-${process.pid}.bin`);
    writeFileSync(badPath, badMagic);
    spills.push({ path: badPath });
    expect(() => readSpillVectors({ path: badPath, dims: DIMS, rowCount: 1 }, [0])).toThrow(
      /invalid embedding spill header/,
    );
  });

  it('reuses an open spill reader across materialize batches', () => {
    const builder = createCachedEmbeddingsBuilder({
      inMemoryRowLimit: 0,
      spillDir: os.tmpdir(),
    });
    for (let i = 0; i < 4; i++) {
      ingestCachedEmbeddingRow(builder, row(`n${i}`, i + 1), true);
    }
    const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
    if (snapshot.spill) spills.push(snapshot.spill);
    const reader = new EmbeddingSpillReader(snapshot.spill!);
    try {
      const first = materializeCachedEmbeddings(snapshot, snapshot.rows.slice(0, 2), reader);
      const second = materializeCachedEmbeddings(snapshot, snapshot.rows.slice(2, 4), reader);
      expect(first[0]?.embedding[0]).toBeCloseTo(1);
      expect(second[1]?.embedding[0]).toBeCloseTo(4);
    } finally {
      reader.close();
    }
  });

  it('scoped discard unlinks only spills created in that analyze run', async () => {
    const other = createCachedEmbeddingsBuilder({
      inMemoryRowLimit: 0,
      spillDir: os.tmpdir(),
    });
    ingestCachedEmbeddingRow(other, row('other', 1), true);
    const otherSnapshot = finalizeCachedEmbeddingsSnapshot(other);
    if (otherSnapshot.spill) spills.push(otherSnapshot.spill);
    expect(existsSync(otherSnapshot.spill!.path)).toBe(true);

    await withEmbeddingSpillScope(async () => {
      const builder = createCachedEmbeddingsBuilder({
        inMemoryRowLimit: 0,
        spillDir: os.tmpdir(),
      });
      ingestCachedEmbeddingRow(builder, row('scoped', 2), true);
      const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
      expect(existsSync(snapshot.spill!.path)).toBe(true);
      discardScopedEmbeddingSpills();
      expect(existsSync(snapshot.spill!.path)).toBe(false);
      expect(existsSync(otherSnapshot.spill!.path)).toBe(true);
    });
  });

  it('unlinks a finished spill that was not disposed', () => {
    const builder = createCachedEmbeddingsBuilder({
      inMemoryRowLimit: 0,
      spillDir: os.tmpdir(),
    });
    ingestCachedEmbeddingRow(builder, row('n1', 1), true);
    const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
    expect(snapshot.spill).toBeDefined();
    expect(existsSync(snapshot.spill!.path)).toBe(true);
    discardLiveEmbeddingSpills();
    expect(existsSync(snapshot.spill!.path)).toBe(false);
  });

  it('throws when materializing a meta row with no matching vector', () => {
    const snapshot = normalizeCachedEmbeddings({
      embeddings: [
        {
          nodeId: 'Function:a:foo',
          chunkIndex: 0,
          startLine: 0,
          endLine: 3,
          embedding: vector(0.1),
          contentHash: 'stub',
        },
      ],
    });
    expect(() =>
      materializeCachedEmbeddings(snapshot, [
        {
          nodeId: 'Function:missing:bar',
          chunkIndex: 0,
          startLine: 0,
          endLine: 1,
          contentHash: 'x',
          vectorIndex: 99,
        },
      ]),
    ).toThrow(/missing cached embedding Function:missing:bar:0/);
  });
});
