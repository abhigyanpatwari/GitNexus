import { describe, it, expect, vi, beforeEach } from 'vitest';

// tri-review NEW-7: `lastObservedIndexedAt`/`lastObservedFtsStatus` used to be
// advanced BEFORE `initLbug` was awaited, unlike `lastObservedDbIdentity`
// (which is only advanced once `initLbug` confirms the pool rolled over). If
// `initLbug` threw, the watermark had already been latched to the new value —
// permanently hiding a failed reinit from every later staleness check, since
// a subsequent comparison against that same watermark would see no change.
// This isolates the fix: a poolKey with `identityChanged` always false (a
// nonexistent lbugPath — no backstop from the file-identity signal) must
// still retry after a transient `initLbug` failure.

const initLbugMock = vi.fn();
vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>();
  return {
    ...actual,
    initLbug: (...args: any[]) => initLbugMock(...args),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

const loadMetaMock = vi.fn();
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    loadMeta: (...args: any[]) => loadMetaMock(...args),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend';

describe('ensureInitialized reinit watermark (tri-review NEW-7)', () => {
  const poolKey = '/tmp/nonexistent-repo/.gitnexus/lbug';
  const repoHandle = { id: 'r1', name: 'r1', lbugPath: poolKey, indexedAt: 'v0' } as any;
  let backend: any;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new LocalBackend() as any;
    // Seed the "warm, already initialized" precondition ensureInitialized
    // requires to reach the staleness-check branch at all.
    backend.initializedRepos.add(poolKey);
    backend.lastStalenessCheck.set(poolKey, 0); // force past the 5s throttle
  });

  it('does not latch the fts-status watermark when initLbug throws, so the next staleness check retries', async () => {
    loadMetaMock.mockResolvedValue({
      indexedAt: 'v1',
      capabilities: { fts: { status: 'available' } },
    });
    initLbugMock.mockRejectedValueOnce(new Error('lock timeout'));

    await expect(backend.ensureInitialized(repoHandle)).rejects.toThrow('lock timeout');

    // The failed reinit must NOT have advanced either watermark — a nonexistent
    // lbugPath means dbIdentity never changes, so there is no other signal to
    // fall back on for a retry.
    expect(backend.lastObservedPoolState.get(poolKey)?.ftsStatus).toBeUndefined();
    expect(backend.lastObservedPoolState.get(poolKey)?.indexedAt).toBeUndefined();

    // Second staleness check (throttle reset again) with initLbug now succeeding.
    backend.lastStalenessCheck.set(poolKey, 0);
    initLbugMock.mockResolvedValueOnce(false); // "no real reopen needed" — still a completed call

    await expect(backend.ensureInitialized(repoHandle)).resolves.toBeUndefined();

    // The retry succeeded and the watermark is now current — proving the
    // failed first attempt did not permanently suppress detection.
    expect(backend.lastObservedPoolState.get(poolKey)?.ftsStatus).toBe('available');
    expect(backend.lastObservedPoolState.get(poolKey)?.indexedAt).toBe('v1');
    expect(initLbugMock).toHaveBeenCalledTimes(2);
  });
});

describe('ensureInitialized ftsCapsChanged trigger, isolated from identityChanged (tri-review Residual-4)', () => {
  // The only existing coverage for this reinit trigger is the integration
  // test in fts-repair-warm-session.test.ts, where a REAL --repair-fts run
  // also mutates the lbug file — so identityChanged is confounded with
  // ftsCapsChanged there, and it's impossible to tell from that test alone
  // whether ftsCapsChanged is actually load-bearing. This isolates it: a
  // nonexistent lbugPath means statDbIdentity always resolves null, so
  // identityChanged is provably false on every check — the ONLY way a reinit
  // can fire here is via ftsCapsChanged (indexedAt is held constant too, so
  // stampChanged is also false).
  const poolKey = '/tmp/nonexistent-repo-caps-only/.gitnexus/lbug';
  const repoHandle = { id: 'r2', name: 'r2', lbugPath: poolKey, indexedAt: 'same' } as any;
  let backend: any;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new LocalBackend() as any;
    backend.initializedRepos.add(poolKey);
    backend.lastStalenessCheck.set(poolKey, 0);
  });

  it('fires a reinit on a capabilities.fts.status change alone, with indexedAt and dbIdentity both unchanged', async () => {
    // Seed a baseline observed state: same indexedAt the next loadMeta will
    // report, a DIFFERENT ftsStatus, and dbIdentity null (matches what
    // statDbIdentity will keep returning for this nonexistent path).
    backend.lastObservedPoolState.set(poolKey, {
      indexedAt: 'same',
      ftsStatus: 'unavailable',
      dbIdentity: null,
    });

    loadMetaMock.mockResolvedValue({
      indexedAt: 'same', // unchanged — stampChanged must be false
      capabilities: { fts: { status: 'available' } }, // changed — the only live signal
    });
    initLbugMock.mockResolvedValueOnce(true);

    await backend.ensureInitialized(repoHandle);

    // A reinit only happens inside the `if (stampChanged || identityChanged
    // || ftsCapsChanged)` branch — initLbug being called at all here proves
    // ftsCapsChanged fired, since the other two provably could not have.
    expect(initLbugMock).toHaveBeenCalledTimes(1);
    expect(backend.lastObservedPoolState.get(poolKey)?.ftsStatus).toBe('available');
  });

  it('does NOT fire a reinit when nothing observable changed (negative control)', async () => {
    backend.lastObservedPoolState.set(poolKey, {
      indexedAt: 'same',
      ftsStatus: 'available',
      dbIdentity: null,
    });

    loadMetaMock.mockResolvedValue({
      indexedAt: 'same',
      capabilities: { fts: { status: 'available' } }, // same as observed
    });

    await backend.ensureInitialized(repoHandle);

    expect(initLbugMock).not.toHaveBeenCalled();
  });
});
