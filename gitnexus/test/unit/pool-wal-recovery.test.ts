/**
 * Tests for WAL corruption recovery in the connection pool (#1402).
 *
 * Mocks createLbugDatabase and fs to verify quarantine + retry behavior
 * without needing a real LadybugDB instance or corrupted WAL file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connectionQueryMock, stderrWriteMock } = vi.hoisted(() => ({
  connectionQueryMock: vi.fn(),
  stderrWriteMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn().mockResolvedValue({}),
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(function (this: any) {
      this.close = vi.fn().mockResolvedValue(undefined);
      this.query = connectionQueryMock;
    }),
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  loadFTSExtension: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/core/lbug/lbug-config.js', () => ({
  createLbugDatabase: vi.fn(),
  toNativeSafePath: vi.fn((p: string) => p),
  LBUG_MAX_DB_SIZE: 1024,
  WAL_RECOVERY_SUGGESTION:
    'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
  isWalCorruptionError: vi.fn((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return /corrupt(ed)?\s+wal|invalid\s+wal\s+record/i.test(msg);
  }),
}));

vi.mock('../../src/mcp/stdio-capture.js', () => ({
  realStdoutWrite: vi.fn(),
  realStderrWrite: stderrWriteMock,
  setActiveStdoutWrite: vi.fn(),
  getActiveStdoutWrite: vi.fn(() => vi.fn()),
}));

import fs from 'fs/promises';
import { createLbugDatabase } from '../../src/core/lbug/lbug-config.js';

const { closeLbug } = await import('../../src/core/lbug/pool-adapter.js');

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

function makeMockDb() {
  return { init: mockInit, close: mockClose, _isClosed: false } as any;
}

// Path-aware default sidecar state for the pool tests: `.shadow` absent,
// `.wal` tiny-present, bare dbPath present → `tiny-orphan-wal`, the state the
// missing-shadow recovery/permission tests model. This keeps `guardWalQuarantine`
// (which now runs before the pool rename — issue #2382 review, Finding B) in its
// "proceed" branch so the existing rename behavior is preserved. Refusal tests
// override this per-case to drive `wal-with-shadow` / large `orphan-wal`.
const ENOENT_STAT = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
function statTinyOrphanWal(p: string): { size: number } {
  if (p.endsWith('.shadow')) throw ENOENT_STAT;
  if (p.endsWith('.wal')) return { size: 128 };
  return { size: 0 };
}

describe('WAL corruption recovery in doInitLbug (#1402)', () => {
  beforeEach(() => {
    // Preflight (which also classifies via inspectLbugSidecars) would quarantine
    // a tiny orphan WAL before the probe even runs, dissolving the
    // probe-fails-then-recover premise these tests are built on. Disable it so
    // only the reactive path (which the guard gates) exercises the sidecars.
    vi.stubEnv('GITNEXUS_DISABLE_LBUG_SIDECAR_PREFLIGHT', '1');
    (createLbugDatabase as any).mockReset();
    (fs.stat as any).mockReset();
    (fs.rename as any).mockReset();
    mockInit.mockReset();
    mockClose.mockReset();
    connectionQueryMock.mockReset();
    connectionQueryMock.mockResolvedValue({
      getAll: vi.fn().mockResolvedValue([]),
      close: vi.fn(),
    });
    mockInit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    (fs.stat as any).mockImplementation(async (p: string) => statTinyOrphanWal(p));
    (fs.rename as any).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeLbug().catch(() => {});
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('retries with WAL quarantine on corrupted WAL init error', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-wal-recovery/lbug';

    const badDb = makeMockDb();
    const goodDb = makeMockDb();
    badDb.init = vi.fn().mockRejectedValueOnce(new Error('Corrupted wal file'));
    (createLbugDatabase as any).mockReturnValueOnce(badDb).mockReturnValueOnce(goodDb);

    await initLbug('test-repo-init', dbPath);

    expect(badDb.init).toHaveBeenCalledTimes(1);
    expect(createLbugDatabase).toHaveBeenCalledTimes(2);
    expect(createLbugDatabase).toHaveBeenCalledWith(
      expect.anything(),
      dbPath,
      expect.objectContaining({
        readOnly: true,
        throwOnWalReplayFailure: false,
      }),
    );
    expect(fs.rename).toHaveBeenCalledWith(
      dbPath + '.wal',
      expect.stringContaining('.wal.corrupt.'),
    );
    expect(stderrWriteMock).toHaveBeenCalledWith(
      expect.stringContaining('WAL quarantined for test-repo-init'),
    );
  });

  it('replays shadow pages with a temporary writable open before pooling read-only DBs', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-shadow-replay/lbug';

    const readOnlyDb1 = makeMockDb();
    const writableDb = makeMockDb();
    const readOnlyDb2 = makeMockDb();
    connectionQueryMock
      .mockRejectedValueOnce(
        new Error(
          "Runtime exception: Couldn't replay shadow pages under read-only mode. Please re-open the database with read-write mode to replay shadow pages.",
        ),
      )
      .mockResolvedValue({
        getAll: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      });
    (createLbugDatabase as any)
      .mockReturnValueOnce(readOnlyDb1)
      .mockReturnValueOnce(writableDb)
      .mockReturnValueOnce(readOnlyDb2);

    await initLbug('test-repo-shadow-replay', dbPath);

    expect(createLbugDatabase).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      dbPath,
      expect.objectContaining({ readOnly: true, throwOnWalReplayFailure: false }),
    );
    expect(createLbugDatabase).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      dbPath,
      expect.objectContaining({ throwOnWalReplayFailure: false }),
    );
    expect(createLbugDatabase).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      dbPath,
      expect.objectContaining({ readOnly: true, throwOnWalReplayFailure: false }),
    );
    expect(readOnlyDb1.close).toHaveBeenCalled();
    expect(writableDb.close).toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('quarantines WAL and reopens read-only when the Ladybug shadow sidecar is missing', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-shadow-missing/lbug';

    const readOnlyDb1 = makeMockDb();
    const readOnlyDb2 = makeMockDb();
    connectionQueryMock
      .mockRejectedValueOnce(
        new Error(`IO exception: Cannot open file ${dbPath}.shadow: No such file or directory`),
      )
      .mockResolvedValue({
        getAll: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      });
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1).mockReturnValueOnce(readOnlyDb2);

    await initLbug('test-repo-shadow-missing', dbPath);

    expect(createLbugDatabase).toHaveBeenCalledTimes(2);
    expect(readOnlyDb1.close).toHaveBeenCalled();
    expect(fs.rename).toHaveBeenCalledWith(
      dbPath + '.wal',
      expect.stringContaining('.wal.missing-shadow.'),
    );
  });

  it('recognizes the Windows Error 2 shadow form and recovers (issue #2382, MCP pool)', async () => {
    // Same missing-shadow recovery as above, but with the Windows native error
    // format. Before the fix isMissingShadowSidecarError matched only the POSIX
    // phrasing, so this string rethrew raw through the MCP/wiki/augmentation
    // pool the same way it did on serve (R4 — one central matcher, all consumers).
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-shadow-missing-win/lbug';

    const readOnlyDb1 = makeMockDb();
    const readOnlyDb2 = makeMockDb();
    connectionQueryMock
      .mockRejectedValueOnce(
        new Error(
          `IO exception: Cannot open file. path: ${dbPath}.shadow - Error 2: The system cannot find the file specified.`,
        ),
      )
      .mockResolvedValue({
        getAll: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      });
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1).mockReturnValueOnce(readOnlyDb2);

    await initLbug('test-repo-shadow-missing-win', dbPath);

    expect(createLbugDatabase).toHaveBeenCalledTimes(2);
    expect(readOnlyDb1.close).toHaveBeenCalled();
    expect(fs.rename).toHaveBeenCalledWith(
      dbPath + '.wal',
      expect.stringContaining('.wal.missing-shadow.'),
    );
  });

  it('does not quarantine on lock error (preserves existing lock retry)', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
      callback();
      return 0 as any;
    });
    const dbPath = '/tmp/test-wal-recovery/lbug';

    (createLbugDatabase as any).mockImplementation(() => {
      throw new Error('Could not set lock on file');
    });

    try {
      await expect(initLbug('test-repo-lock', dbPath)).rejects.toThrow();
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('throws with analyze suggestion after retry also fails', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-wal-recovery/lbug';

    (createLbugDatabase as any)
      .mockImplementationOnce(() => {
        throw new Error('Corrupted wal file');
      })
      .mockImplementationOnce(() => {
        throw new Error('Still broken');
      });

    await expect(initLbug('test-repo-fail', dbPath)).rejects.toThrow(/gitnexus analyze/);
    expect(createLbugDatabase).toHaveBeenCalledTimes(2);
  });

  it('does not reuse poisoned state after WAL failure', async () => {
    const { initLbug, isLbugReady: ready } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-wal-recovery/lbug';

    (createLbugDatabase as any)
      .mockImplementationOnce(() => {
        throw new Error('Corrupted wal file');
      })
      .mockImplementationOnce(() => {
        throw new Error('Still broken');
      });

    await expect(initLbug('test-repo-nocache', dbPath)).rejects.toThrow();

    expect(ready('test-repo-nocache')).toBe(false);
  });

  it('handles quarantine gracefully when .wal file does not exist', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-wal-recovery/lbug';

    (fs.rename as any).mockRejectedValueOnce(new Error('ENOENT: no such file'));

    (createLbugDatabase as any).mockImplementationOnce(() => {
      throw new Error('Corrupted wal file');
    });

    await expect(initLbug('test-repo-enoent', dbPath)).rejects.toThrow(/gitnexus analyze/);
  });
});

describe('Pool-adapter missing-shadow quarantine: TOCTOU + permission classification (PR #1747 review)', () => {
  beforeEach(() => {
    // See the sibling describe: disable preflight and default to a
    // `tiny-orphan-wal` state so guardWalQuarantine (now gating the pool rename)
    // proceeds, preserving the pre-guard rename/permission behavior these tests
    // assert. Refusal cases override `fs.stat` per-case.
    vi.stubEnv('GITNEXUS_DISABLE_LBUG_SIDECAR_PREFLIGHT', '1');
    (createLbugDatabase as any).mockReset();
    (fs.stat as any).mockReset();
    (fs.rename as any).mockReset();
    mockInit.mockReset();
    mockClose.mockReset();
    connectionQueryMock.mockReset();
    connectionQueryMock.mockResolvedValue({
      getAll: vi.fn().mockResolvedValue([]),
      close: vi.fn(),
    });
    mockInit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    (fs.stat as any).mockImplementation(async (p: string) => statTinyOrphanWal(p));
    (fs.rename as any).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeLbug().catch(() => {});
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  const enoent = (): NodeJS.ErrnoException => {
    const e = new Error('ENOENT: peer already moved it') as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    return e;
  };
  const fsErr = (code: string): NodeJS.ErrnoException => {
    const e = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };
  const shadowError = (dbPath: string): Error =>
    new Error(`IO exception: Cannot open file ${dbPath}.shadow: No such file or directory`);

  /**
   * Make fs.stat ENOENT for the .wal path only — simulates "peer process
   * already quarantined the WAL". Other paths (the main dbPath, .shadow)
   * resolve normally so doInitLbug's existence check and preflight don't trip.
   */
  const stubWalGoneAfterRename = (walPath: string): void => {
    (fs.stat as any).mockImplementation((p: string) => {
      if (p === walPath) return Promise.reject(enoent());
      return Promise.resolve({ size: 128 });
    });
  };

  it('treats ENOENT on rename as peer-handled when WAL is confirmed gone (openReadOnlyDatabase)', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-pool-enoent-race/lbug';

    stubWalGoneAfterRename(`${dbPath}.wal`);
    (fs.rename as any).mockRejectedValueOnce(enoent());

    const readOnlyDb1 = makeMockDb();
    const readOnlyDb2 = makeMockDb();
    connectionQueryMock.mockRejectedValueOnce(shadowError(dbPath)).mockResolvedValue({
      getAll: vi.fn().mockResolvedValue([]),
      close: vi.fn(),
    });
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1).mockReturnValueOnce(readOnlyDb2);

    await initLbug('test-repo-pool-enoent', dbPath);

    expect(createLbugDatabase).toHaveBeenCalledTimes(2);
    expect(readOnlyDb1.close).toHaveBeenCalled();
    expect(fs.rename).toHaveBeenCalledWith(
      `${dbPath}.wal`,
      expect.stringContaining('.wal.missing-shadow.'),
    );
  });

  it('classifies EACCES on rename with permission-specific message (openReadOnlyDatabase)', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-pool-eacces/lbug';

    (fs.rename as any).mockRejectedValueOnce(fsErr('EACCES'));

    const readOnlyDb1 = makeMockDb();
    connectionQueryMock.mockRejectedValueOnce(shadowError(dbPath));
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1);

    await expect(initLbug('test-repo-pool-eacces', dbPath)).rejects.toThrow(
      /EACCES.*permission|permission.*EACCES|file-lock.*EACCES|EACCES.*file-lock/s,
    );
  });

  it('classifies EPERM on rename with permission-specific message', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-pool-eperm/lbug';

    (fs.rename as any).mockRejectedValueOnce(fsErr('EPERM'));

    const readOnlyDb1 = makeMockDb();
    connectionQueryMock.mockRejectedValueOnce(shadowError(dbPath));
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1);

    await expect(initLbug('test-repo-pool-eperm', dbPath)).rejects.toThrow(/EPERM/);
  });

  it('classifies EBUSY on rename with permission-specific message (common on Windows under AV)', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-pool-ebusy/lbug';

    (fs.rename as any).mockRejectedValueOnce(fsErr('EBUSY'));

    const readOnlyDb1 = makeMockDb();
    connectionQueryMock.mockRejectedValueOnce(shadowError(dbPath));
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1);

    await expect(initLbug('test-repo-pool-ebusy', dbPath)).rejects.toThrow(/EBUSY/);
  });

  it('falls through to shadowSidecarRecoveryMessage for ENOSPC on rename', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-pool-enospc/lbug';

    (fs.rename as any).mockRejectedValueOnce(fsErr('ENOSPC'));

    const readOnlyDb1 = makeMockDb();
    connectionQueryMock.mockRejectedValueOnce(shadowError(dbPath));
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1);

    await expect(initLbug('test-repo-pool-enospc', dbPath)).rejects.toThrow(/Rebuild the index/);
  });

  it('defensive: ENOENT on rename but WAL still present → classified error (not silent peer-handled)', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-pool-defensive/lbug';

    // Note: NOT calling stubWalGoneAfterRename — fs.stat defaults to resolve.
    (fs.rename as any).mockRejectedValueOnce(enoent());

    const readOnlyDb1 = makeMockDb();
    connectionQueryMock.mockRejectedValueOnce(shadowError(dbPath));
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1);

    // ENOENT → defensive branch sees WAL still present → throws classified error.
    // Since ENOENT does not match permission codes, classifier falls through to
    // shadowSidecarRecoveryMessage.
    await expect(initLbug('test-repo-pool-defensive', dbPath)).rejects.toThrow(/Rebuild the index/);
  });

  // ─── Present-shadow / large-WAL refusal on the pool path (issue #2382 Finding B) ───
  // The broadened matcher now routes Windows Error 2 into the pool quarantine
  // path; guardWalQuarantine must refuse (throw, no rename) when the shadow is
  // present or the orphan WAL is large — parity with serve's refuseLargeWalQuarantine.
  const windowsError2 = (dbPath: string): Error =>
    new Error(
      `IO exception: Cannot open file. path: ${dbPath}.shadow - Error 2: The system cannot find the file specified.`,
    );

  it('refuses to quarantine when the .shadow is present on disk (pool data-loss guard — Finding B)', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-pool-present-shadow/lbug';

    // Both sidecars present → wal-with-shadow → guard refuses before any rename.
    (fs.stat as any).mockImplementation(async () => ({ size: 128 }));

    const readOnlyDb1 = makeMockDb();
    connectionQueryMock.mockRejectedValueOnce(windowsError2(dbPath));
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1);

    // Present shadow → the guard throws the present-but-unreachable message
    // (S2), which propagates cleanly to the MCP caller — not a silent rename.
    await expect(initLbug('test-repo-pool-present-shadow', dbPath)).rejects.toThrow(
      /present but unreachable/,
    );
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('refuses to quarantine a large orphan WAL on the pool path (Finding B)', async () => {
    const { initLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const dbPath = '/tmp/test-pool-large-wal/lbug';

    // Large orphan WAL (> TINY_ORPHAN_WAL_BYTES), shadow absent → orphan-wal → refuse.
    (fs.stat as any).mockImplementation(async (p: string) => {
      if (p.endsWith('.shadow')) throw ENOENT_STAT;
      if (p.endsWith('.wal')) return { size: 8192 };
      return { size: 0 };
    });

    const readOnlyDb1 = makeMockDb();
    connectionQueryMock.mockRejectedValueOnce(windowsError2(dbPath));
    (createLbugDatabase as any).mockReturnValueOnce(readOnlyDb1);

    await expect(initLbug('test-repo-pool-large-wal', dbPath)).rejects.toThrow(/Rebuild the index/);
    expect(fs.rename).not.toHaveBeenCalled();
  });
});
