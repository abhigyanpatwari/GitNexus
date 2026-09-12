import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

const { loadFTSExtensionMock, loadVectorExtensionMock, createLbugDatabaseMock } = vi.hoisted(
  () => ({
    loadFTSExtensionMock: vi.fn(),
    loadVectorExtensionMock: vi.fn().mockResolvedValue(false),
    createLbugDatabaseMock: vi.fn(),
  }),
);

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

vi.mock('../../src/core/lbug/lbug-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/lbug-config.js')>();
  return {
    ...actual,
    createLbugDatabase: createLbugDatabaseMock,
    toNativeSafePath: vi.fn((p: string) => p),
    isWalCorruptionError: vi.fn(() => false),
    WAL_RECOVERY_SUGGESTION: '',
  };
});

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
const { STORAGE_VERSION_MISMATCH_SUGGESTION } = await import('../../src/core/lbug/lbug-config.js');

const NATIVE_STORAGE_VERSION_MISMATCH =
  'Runtime exception: Trying to read a database file with a different version. Database file version: 43, Current build storage version: 42';

function goodDb() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('pool-adapter storage-version fail-fast and lock-retry backoff', () => {
  let tmpDir: string;
  const touched = new Set<string>();

  const dbPathFor = (repoId: string): string => {
    const p = path.join(tmpDir, `${repoId}.lbug`);
    writeFileSync(p, '');
    return p;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gn-pool-sv-lock-'));
    loadFTSExtensionMock.mockResolvedValue(true);
    createLbugDatabaseMock.mockReset();
    createLbugDatabaseMock.mockImplementation(() => goodDb());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeLbug().catch(() => {});
    for (const id of touched) unpinRepo(id);
    touched.clear();
    loadFTSExtensionMock.mockReset();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fail-fasts a storage-version mismatch with the rebuild hint and does not lock-retry', async () => {
    const repoId = 'version-mismatch';
    touched.add(repoId);
    createLbugDatabaseMock.mockImplementation(() => {
      throw new Error(NATIVE_STORAGE_VERSION_MISMATCH);
    });

    await expect(initLbug(repoId, dbPathFor(repoId))).rejects.toThrow(
      STORAGE_VERSION_MISMATCH_SUGGESTION,
    );
    expect(createLbugDatabaseMock).toHaveBeenCalledTimes(1);
  });

  it('does not hold withPoolLock across lock-retry sleep — another repo can init during backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const lockedId = 'locked';
    const otherId = 'other';
    touched.add(lockedId);
    touched.add(otherId);
    const lockedPath = dbPathFor(lockedId);
    const otherPath = dbPathFor(otherId);

    createLbugDatabaseMock.mockImplementation((_mod: unknown, dbPath: string) => {
      if (
        String(dbPath).includes(`${path.sep}locked.lbug`) ||
        String(dbPath).endsWith('locked.lbug')
      ) {
        throw new Error('Could not set lock on file : /tmp/locked.lbug');
      }
      return goodDb();
    });

    const lockedInit = initLbug(lockedId, lockedPath);
    await vi.waitFor(() => {
      expect(createLbugDatabaseMock).toHaveBeenCalledTimes(1);
    });

    const otherInit = initLbug(otherId, otherPath);
    await expect(otherInit).resolves.toBe(true);
    expect(isLbugReady(otherId)).toBe(true);
    expect(createLbugDatabaseMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => {
      expect(createLbugDatabaseMock).toHaveBeenCalledTimes(3);
    });
    await vi.advanceTimersByTimeAsync(4000);
    await expect(lockedInit).rejects.toThrow(/LadybugDB unavailable for locked/);
    expect(createLbugDatabaseMock).toHaveBeenCalledTimes(4);
  });
});
