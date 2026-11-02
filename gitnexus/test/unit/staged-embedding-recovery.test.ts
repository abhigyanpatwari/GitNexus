import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCachedEmbeddingsBuilder,
  disposeEmbeddingSpill,
  finalizeCachedEmbeddingsSnapshot,
  ingestCachedEmbeddingRow,
  materializeCachedEmbeddings,
  type CachedEmbeddingsSnapshot,
} from '../../src/core/embeddings/embedding-restore-spill.js';
import {
  mergeRecoveredEmbeddings,
  validateRecoveredNodeGroups,
} from '../../src/core/embeddings/staged-embedding-recovery.js';

describe('staged embedding recovery', () => {
  const snapshots: CachedEmbeddingsSnapshot[] = [];
  let tmp: string | undefined;
  afterEach(() => {
    for (const snapshot of snapshots) disposeEmbeddingSpill(snapshot.spill);
    snapshots.length = 0;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function snapshot(
    rows: { nodeId: string; chunkIndex: number; contentHash?: string; embedding?: number[] }[],
  ) {
    tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-stage-test-'));
    const builder = createCachedEmbeddingsBuilder({ inMemoryRowLimit: 0, spillDir: tmp });
    for (const row of rows) {
      ingestCachedEmbeddingRow(
        builder,
        { startLine: 1, endLine: 2, embedding: [1, 2], ...row },
        true,
      );
    }
    const result = finalizeCachedEmbeddingsSnapshot(builder);
    snapshots.push(result);
    return result;
  }

  it('accepts only complete groups with one content hash and unique contiguous chunk ordinals', () => {
    const cached = snapshot([
      { nodeId: 'complete', chunkIndex: 1, contentHash: 'same' },
      { nodeId: 'complete', chunkIndex: 0, contentHash: 'same' },
      { nodeId: 'gap', chunkIndex: 1, contentHash: 'same' },
      { nodeId: 'duplicate', chunkIndex: 0, contentHash: 'same' },
      { nodeId: 'duplicate', chunkIndex: 0, contentHash: 'same' },
      { nodeId: 'mixed', chunkIndex: 0, contentHash: 'old' },
      { nodeId: 'mixed', chunkIndex: 1, contentHash: 'new' },
      { nodeId: 'no-hash', chunkIndex: 0 },
      { nodeId: 'unsafe', chunkIndex: 0, contentHash: 'same' },
    ]);
    expect([...validateRecoveredNodeGroups(cached.rows, new Set(['unsafe']))]).toEqual([
      'complete',
    ]);
  });

  it('replaces an entire published node group and keeps unrelated rows without retaining vector arrays', () => {
    const live = snapshot([
      { nodeId: 'changed', chunkIndex: 0, contentHash: 'old' },
      { nodeId: 'changed', chunkIndex: 1, contentHash: 'old' },
      { nodeId: 'other', chunkIndex: 0, contentHash: 'other' },
    ]);
    const recovered = snapshot([
      { nodeId: 'changed', chunkIndex: 0, contentHash: 'new', embedding: [7, 8] },
    ]);
    const merged = mergeRecoveredEmbeddings(live, recovered);
    snapshots.push(merged);
    expect(merged.embeddings).toEqual([]);
    expect(merged.rows).toHaveLength(2);
    expect(materializeCachedEmbeddings(merged, merged.rows)).toEqual([
      expect.objectContaining({ nodeId: 'other', contentHash: 'other' }),
      expect.objectContaining({
        nodeId: 'changed',
        chunkIndex: 0,
        contentHash: 'new',
        embedding: [7, 8],
      }),
    ]);
    expect(fs.existsSync(live.spill.path)).toBe(true);
    expect(fs.existsSync(recovered.spill.path)).toBe(true);
  });

  it('does not accept missing vector bytes during a merge', () => {
    const cached = snapshot([{ nodeId: 'complete', chunkIndex: 0, contentHash: 'same' }]);
    fs.truncateSync(cached.spill.path, 12);
    expect(() => mergeRecoveredEmbeddings(snapshot([]), cached)).toThrow(
      /short embedding spill read/,
    );
  });
});
