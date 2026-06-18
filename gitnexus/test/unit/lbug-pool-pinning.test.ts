import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

// Drive the REAL initLbug path (which calls evictLRU) rather than
// initLbugWithDb (which bypasses eviction entirely). The native LadybugDB
// open/connect/FTS stack is mocked exactly as in lbug-pool-fts-load.test.ts,
// plus sidecar-recovery so openReadOnlyDatabase's preflight is a no-op. fs is
// NOT mocked — each repo uses a real temp file so the fs.stat existence check
// in doInitLbug succeeds naturally.
//
// Covers issue #2189: a group sync larger than MAX_POOL_SIZE must keep every
// repo resident through deferred manifest/workspace resolution. Pinning makes
// that resident set survive automatic (LRU + idle) eviction.

const { loadFTSExtensionMock } = vi.hoisted(() => ({
  loadFTSExtensionMock: vi.fn(),
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(function (this: any) {
      // probeDatabaseForShadowReplay() runs a probe query during the
      // read-only open; the result must expose getAll()/close().
      this.query = vi.fn().mockResolvedValue({
        getAll: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      });
      this.close = vi.fn().mockResolvedValue(undefined);
    }),
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  isReadOnlyDbError: vi.fn(() => false),
  loadFTSExtension: loadFTSExtensionMock,
}));

vi.mock('../../src/core/lbug/lbug-config.js', () => ({
  // A fresh fake Database per call so distinct dbPaths get distinct entries
  // and closeOne's db.close() resolves per repo.
  createLbugDatabase: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  toNativeSafePath: vi.fn((p: string) => p),
  isWalCorruptionError: vi.fn(() => false),
  WAL_RECOVERY_SUGGESTION: '',
}));

vi.mock('../../src/core/lbug/sidecar-recovery.js', () => ({
  preflightLbugSidecars: vi.fn().mockResolvedValue(undefined),
  isMissingFsError: vi.fn(() => false),
  isMissingShadowSidecarError: vi.fn(() => false),
  isReadOnlyShadowReplayError: vi.fn(() => false),
  quarantineWalForMissingShadow: vi.fn().mockResolvedValue(''),
  renameFailureMessage: vi.fn((p: string) => `rename failed for ${p}`),
  statIfExists: vi.fn().mockResolvedValue(null),
}));

const { initLbug, closeLbug, isLbugReady, pinRepo, unpinRepo } =
  await import('../../src/core/lbug/pool-adapter.js');
const { initWikiDb, closeWikiDb, pinWikiDb } = await import('../../src/core/wiki/graph-queries.js');

describe('pool-adapter repo pinning (issue #2189)', () => {
  let tmpDir: string;
  // Track every repoId touched so afterEach can fully reset module-global state.
  const touched = new Set<string>();

  const dbPathFor = (repoId: string): string => {
    const p = path.join(tmpDir, `${repoId}.lbug`);
    writeFileSync(p, ''); // real file so fs.stat() in doInitLbug succeeds
    return p;
  };

  const init = async (repoId: string): Promise<void> => {
    touched.add(repoId);
    await initLbug(repoId, dbPathFor(repoId));
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gn-pin-test-'));
    loadFTSExtensionMock.mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeLbug().catch(() => {});
    for (const id of touched) unpinRepo(id);
    touched.clear();
    loadFTSExtensionMock.mockReset();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // MAX_POOL_SIZE is 5; the 6th init triggers evictLRU.
  it('characterization: WITHOUT pinning, the earliest repo is LRU-evicted past the cap', async () => {
    for (let i = 1; i <= 6; i++) await init(`repo-${i}`);

    // repo-1 had the oldest lastUsed and nothing was checked out, so it is the
    // eviction victim — exactly the stale-executor scenario from #2189.
    expect(isLbugReady('repo-1')).toBe(false);
    // The most recently initialized repo survives.
    expect(isLbugReady('repo-6')).toBe(true);
  });

  it('FIX: pinning each repo keeps all of them resident past the cap', async () => {
    for (let i = 1; i <= 6; i++) {
      await init(`repo-${i}`);
      pinRepo(`repo-${i}`);
    }

    for (let i = 1; i <= 6; i++) {
      expect(isLbugReady(`repo-${i}`)).toBe(true);
    }
  });

  it('explicit close beats the pin AND clears it (no cross-operation leak)', async () => {
    pinRepo('repo-x');
    await init('repo-x');
    expect(isLbugReady('repo-x')).toBe(true);

    // Explicit teardown closes a pinned repo without needing an unpin first.
    await closeLbug('repo-x');
    expect(isLbugReady('repo-x')).toBe(false);

    // The pin must have been cleared on close: re-init repo-x FIRST (oldest
    // lastUsed) and fill past the cap. If the pin had leaked, repo-x would be
    // un-evictable; instead it is evicted as the LRU victim.
    await init('repo-x');
    for (let i = 1; i <= 5; i++) await init(`fresh-${i}`);
    expect(isLbugReady('repo-x')).toBe(false);
  });

  it('idle-timeout sweep skips pinned repos but still evicts idle unpinned ones', async () => {
    vi.useFakeTimers();

    await init('pinned-idle');
    pinRepo('pinned-idle');
    await init('unpinned-idle');

    expect(isLbugReady('pinned-idle')).toBe(true);
    expect(isLbugReady('unpinned-idle')).toBe(true);

    // The idle timer runs every 60s and closes entries idle past
    // IDLE_TIMEOUT_MS (5 min) with no checked-out connections. advance past
    // both thresholds, flushing microtasks between fires.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 60 * 1000);

    expect(isLbugReady('pinned-idle')).toBe(true);
    expect(isLbugReady('unpinned-idle')).toBe(false);
  });

  it('wiki DB pin wrapper keeps __wiki__ resident past idle cleanup', async () => {
    vi.useFakeTimers();

    const releaseWikiPin = pinWikiDb();
    await initWikiDb(dbPathFor('wiki-wrapper'));
    expect(isLbugReady('__wiki__')).toBe(true);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 60 * 1000);
    expect(isLbugReady('__wiki__')).toBe(true);

    releaseWikiPin();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 60 * 1000);
    expect(isLbugReady('__wiki__')).toBe(false);

    await closeWikiDb();
  });

  it('unpinRepo re-enables eviction for that repo', async () => {
    // Pin five repos and fill the pool; a sixth init evicts nothing (all pinned).
    for (let i = 1; i <= 5; i++) {
      await init(`p-${i}`);
      pinRepo(`p-${i}`);
    }
    await init('p-6'); // unpinned; pool now holds 6 (soft-cap exceeded)
    for (let i = 1; i <= 6; i++) expect(isLbugReady(`p-${i}`)).toBe(true);

    // Unpin the oldest, then init a 7th repo — the now-unpinned p-1 is the LRU
    // victim.
    unpinRepo('p-1');
    await init('p-7');
    expect(isLbugReady('p-1')).toBe(false);
    expect(isLbugReady('p-7')).toBe(true);
  });

  it('reference-counts leases: two pins need two unpins before eviction (Finding 1)', async () => {
    // Fill the pool to capacity, all leased.
    for (let i = 1; i <= 4; i++) {
      await init(`rc-${i}`);
      pinRepo(`rc-${i}`);
    }
    await init('rc-shared');
    pinRepo('rc-shared'); // lease 1
    pinRepo('rc-shared'); // lease 2 (two holders)

    // Release ONE lease — a holder remains, so rc-shared stays exempt even
    // under eviction pressure.
    unpinRepo('rc-shared');
    await init('rc-extra'); // evictLRU finds no unpinned victim → pool grows
    expect(isLbugReady('rc-shared')).toBe(true);

    // Release the LAST lease — now rc-shared (oldest unpinned) is evictable.
    unpinRepo('rc-shared');
    await init('rc-extra2');
    expect(isLbugReady('rc-shared')).toBe(false);
  });

  it('unpinRepo floors at zero and tolerates unknown repoIds', () => {
    expect(() => {
      unpinRepo('never-touched'); // unknown repoId → no-op
      pinRepo('floor-x');
      unpinRepo('floor-x'); // count 0 → key deleted
      unpinRepo('floor-x'); // already gone → no-op, never a negative count
    }).not.toThrow();
  });

  it('pinRepo returns a disposer that releases exactly once and composes with refcount', async () => {
    for (let i = 1; i <= 4; i++) {
      await init(`d-${i}`);
      pinRepo(`d-${i}`);
    }
    await init('d-shared');
    const release1 = pinRepo('d-shared'); // lease 1
    const release2 = pinRepo('d-shared'); // lease 2

    release1();
    release1(); // double-call is a no-op — must NOT decrement lease 2

    // lease 2 still held → d-shared survives eviction pressure.
    await init('d-extra');
    expect(isLbugReady('d-shared')).toBe(true);

    // Release the last lease via its own disposer → now evictable.
    release2();
    await init('d-extra2');
    expect(isLbugReady('d-shared')).toBe(false);
  });
});
