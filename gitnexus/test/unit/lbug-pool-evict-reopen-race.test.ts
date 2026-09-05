import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

// Regression test: closeOne() used to close the evicted repo's shared Database
// with a fire-and-forget `db.close().catch(() => {})` (no await), and evictLRU
// (plus the "idle & changed" reopen path in initLbug) proceeded to open the
// next repo's connection immediately after, without waiting for that close —
// and the checkpoint it triggers — to finish. On the real LadybugDB engine
// this surfaces as: "Runtime exception: Cannot open database in read-only
// mode while checkpoint is in progress. Please retry later." on the very next
// read against ANY repo, not just the one being evicted.
//
// The native engine isn't mockable down to that exact error, so this test
// instead asserts the ordering guarantee the fix provides: the evicted repo's
// close() must fully resolve before the caller that triggered the eviction
// (initLbug for a new, distinct repo) itself resolves. Mock setup mirrors
// lbug-pool-pinning.test.ts (same native/adapter/sidecar-recovery mocks),
// driving the real initLbug -> evictLRU -> closeOne path.

const { loadFTSExtensionMock, loadVectorExtensionMock } = vi.hoisted(() => ({
  loadFTSExtensionMock: vi.fn(),
  loadVectorExtensionMock: vi.fn().mockResolvedValue(false),
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(function (this: any) {
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
  loadVectorExtension: loadVectorExtensionMock,
}));

vi.mock('../../src/core/lbug/lbug-config.js', () => ({
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
  guardWalQuarantine: vi.fn().mockResolvedValue(undefined),
  isMissingFsError: vi.fn(() => false),
  isMissingShadowSidecarError: vi.fn(() => false),
  isReadOnlyShadowReplayError: vi.fn(() => false),
  quarantineWalForMissingShadow: vi.fn().mockResolvedValue(''),
  quarantineSidecarsForDirtyRecovery: vi
    .fn()
    .mockResolvedValue({ moved: [], removed: [], failed: [] }),
  renameFailureMessage: vi.fn((p: string) => `rename failed for ${p}`),
  statIfExists: vi.fn().mockResolvedValue(null),
}));

const { initLbug, closeLbug, isLbugReady, unpinRepo } =
  await import('../../src/core/lbug/pool-adapter.js');
const { createLbugDatabase } = await import('../../src/core/lbug/lbug-config.js');

describe('pool-adapter evict-then-reopen race (fire-and-forget close fix)', () => {
  let tmpDir: string;
  const touched = new Set<string>();

  const dbPathFor = (repoId: string): string => {
    const p = path.join(tmpDir, `${repoId}.lbug`);
    writeFileSync(p, '');
    return p;
  };

  const init = async (repoId: string): Promise<void> => {
    touched.add(repoId);
    await initLbug(repoId, dbPathFor(repoId));
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gn-evict-race-test-'));
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

  it("evictLRU awaits the evicted repo's close() before the triggering initLbug settles", async () => {
    // MAX_POOL_SIZE is 5; repo-1 is the first (and, once repo-6 inits, the
    // LRU-oldest unpinned) entry, so it is the eviction victim below.
    // Give repo-1's shared Database a close() gated on a real (short) delay,
    // simulating a slow checkpoint, and record the relative order of "close
    // finished" vs. "the repo-6 init that triggered the eviction finished".
    const order: string[] = [];

    vi.mocked(createLbugDatabase).mockImplementationOnce(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('repo1-close-end');
      }),
    }));

    for (let i = 1; i <= 5; i++) await init(`repo-${i}`);

    await init('repo-6');
    order.push('repo6-init-done');

    // With the fix: evictLRU awaits closeOne's close(), so the 20ms-delayed
    // close of the evicted repo-1 must finish BEFORE initLbug('repo-6', ...)
    // itself resolves — 'repo1-close-end' precedes 'repo6-init-done'.
    // Without the fix (fire-and-forget close), repo-6's own (near-instant,
    // mock-driven) init finishes well before the unrelated 20ms delay elapses,
    // so the order is reversed.
    expect(order).toEqual(['repo1-close-end', 'repo6-init-done']);
    expect(isLbugReady('repo-1')).toBe(false);
    expect(isLbugReady('repo-6')).toBe(true);
  });

  it('closeLbug(repoId) awaits the underlying close() before its own promise resolves', async () => {
    // Regression guard for a second-order effect of making closeOne async:
    // closeLbug must still await it, or its promise can resolve before the
    // real (here, delayed-mock) close() has actually finished. Gate the
    // mock's close() on a real short delay, like the first test, so an
    // implementation that drops the await is caught regardless of how fast
    // the mock itself would otherwise resolve.
    const order: string[] = [];

    vi.mocked(createLbugDatabase).mockImplementationOnce(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('close-end');
      }),
    }));

    await init('repo-solo');
    expect(isLbugReady('repo-solo')).toBe(true);

    await closeLbug('repo-solo');
    order.push('closeLbug-done');

    expect(order).toEqual(['close-end', 'closeLbug-done']);
    expect(isLbugReady('repo-solo')).toBe(false);
  });
});
