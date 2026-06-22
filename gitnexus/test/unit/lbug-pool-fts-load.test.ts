import { afterEach, describe, expect, it, vi } from 'vitest';

const { loadFTSExtensionMock } = vi.hoisted(() => ({
  loadFTSExtensionMock: vi.fn(),
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
  isReadOnlyDbError: vi.fn(() => false),
  loadFTSExtension: loadFTSExtensionMock,
}));

vi.mock('../../src/core/lbug/lbug-config.js', () => ({
  createLbugDatabase: vi.fn(),
  toNativeSafePath: vi.fn((p: string) => p),
  isWalCorruptionError: vi.fn(() => false),
  WAL_RECOVERY_SUGGESTION: '',
}));

const { closeLbug, initLbugWithDb } = await import('../../src/core/lbug/pool-adapter.js');

describe('read-pool FTS loading', () => {
  afterEach(async () => {
    await closeLbug().catch(() => {});
    loadFTSExtensionMock.mockReset();
  });

  it('loads FTS with load-only policy and caches a successful load', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    const db = {} as any;

    await initLbugWithDb('repo-a', db, '/tmp/shared-fts-db');
    await initLbugWithDb('repo-b', db, '/tmp/shared-fts-db');

    expect(loadFTSExtensionMock).toHaveBeenCalledTimes(1);
    expect(loadFTSExtensionMock).toHaveBeenCalledWith(expect.anything(), { policy: 'load-only' });
  });

  it('does not fake a successful load when FTS is unavailable', async () => {
    loadFTSExtensionMock.mockResolvedValue(false);
    const db = {} as any;

    await initLbugWithDb('repo-a', db, '/tmp/shared-fts-db');
    await initLbugWithDb('repo-b', db, '/tmp/shared-fts-db');

    expect(loadFTSExtensionMock).toHaveBeenCalledTimes(2);
    expect(loadFTSExtensionMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      policy: 'load-only',
    });
    expect(loadFTSExtensionMock).toHaveBeenNthCalledWith(2, expect.anything(), {
      policy: 'load-only',
    });
  });
});
