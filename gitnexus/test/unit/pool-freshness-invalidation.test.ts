/**
 * Unit tests for the read-pool staleness identity mechanism (pool invalidation).
 *
 * When `analyze` rebuilds or mutates the on-disk index under a live MCP read
 * pool, `initLbug` must detect the change and re-open onto the new file instead
 * of serving the stale (POSIX: unlinked-but-open) inode. Detection rests on the
 * filesystem identity `{ino, mtimeMs, size}` diverging. These tests pin that the
 * identity actually diverges on the two real rebuild shapes — a whole-file
 * replace (new inode) and an in-place grow (size change) — and that a stat
 * failure is treated as "unchanged" so a reader keeps its valid open inode
 * through the brief unlink window of a full rebuild.
 *
 * The end-to-end initLbug reopen (native DB open on a swapped file) is covered
 * by the reader-during-rebuild integration test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Defensive: keep native search/embedding adapters from loading at import time.
vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { statDbIdentity, dbIdentityChanged } from '../../src/core/lbug/pool-adapter.js';

describe('pool freshness identity (pool invalidation)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-pool-fresh-'));
    dbPath = path.join(dir, 'lbug');
    await fs.writeFile(dbPath, 'v1-index-bytes', 'utf-8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports an unchanged file as not changed (reader reuses the pool)', async () => {
    const a = await statDbIdentity(dbPath);
    const b = await statDbIdentity(dbPath);
    expect(a).not.toBeNull();
    expect(dbIdentityChanged(a, b)).toBe(false);
  });

  it('detects a whole-file replace — the full-rebuild / atomic-swap shape', async () => {
    const before = await statDbIdentity(dbPath);
    // unlink + recreate at the same path = new inode (what a full rebuild's
    // unlink+recreate, or a temp-build atomic rename-over, produces).
    await fs.rm(dbPath);
    await fs.writeFile(dbPath, 'v2-rebuilt-index-bytes-different-length', 'utf-8');
    const after = await statDbIdentity(dbPath);
    expect(dbIdentityChanged(before, after)).toBe(true);
  });

  it('detects an in-place grow — the incremental writeback shape', async () => {
    const before = await statDbIdentity(dbPath);
    await fs.appendFile(dbPath, '-more-rows-appended', 'utf-8'); // same inode, larger size
    const after = await statDbIdentity(dbPath);
    expect(dbIdentityChanged(before, after)).toBe(true);
  });

  it('treats a missing file as unchanged (keep the still-valid open inode)', async () => {
    const before = await statDbIdentity(dbPath);
    await fs.rm(dbPath); // brief unlink window of a full rebuild
    const missing = await statDbIdentity(dbPath);
    expect(missing).toBeNull();
    // Not "changed": the reader keeps serving its open inode until the NEW file
    // appears with a different identity — avoids churning into a failed reopen.
    expect(dbIdentityChanged(before, missing)).toBe(false);
  });

  it('compares each identity field (pure decision)', () => {
    const base = { ino: 10, mtimeMs: 1000, size: 500 };
    expect(dbIdentityChanged(base, { ...base })).toBe(false);
    expect(dbIdentityChanged(base, { ...base, ino: 11 })).toBe(true);
    expect(dbIdentityChanged(base, { ...base, mtimeMs: 1001 })).toBe(true);
    expect(dbIdentityChanged(base, { ...base, size: 501 })).toBe(true);
    // Unknown identity on either side is never "changed".
    expect(dbIdentityChanged(null, base)).toBe(false);
    expect(dbIdentityChanged(base, null)).toBe(false);
  });
});
