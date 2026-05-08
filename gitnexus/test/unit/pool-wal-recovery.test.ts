/**
 * Tests for WAL corruption recovery in the connection pool (#1402).
 *
 * Mocks createLbugDatabase and fs to verify quarantine + retry behavior
 * without needing a real LadybugDB instance or corrupted WAL file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { stderrWriteMock } = vi.hoisted(() => ({
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
    }),
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  loadFTSExtension: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/core/lbug/lbug-config.js', () => ({
  createLbugDatabase: vi.fn(),
  LBUG_MAX_DB_SIZE: 1024,
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

describe('WAL corruption recovery in doInitLbug (#1402)', () => {
  beforeEach(() => {
    (createLbugDatabase as any).mockReset();
    (fs.stat as any).mockReset();
    (fs.rename as any).mockReset();
    mockInit.mockReset();
    mockClose.mockReset();
    mockInit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    (fs.stat as any).mockResolvedValue({});
    (fs.rename as any).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeLbug().catch(() => {});
    vi.clearAllMocks();
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
