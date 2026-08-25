import { afterEach, describe, expect, it, vi } from 'vitest';

const { loadFTSExtensionMock, loadVectorExtensionMock } = vi.hoisted(() => ({
  loadFTSExtensionMock: vi.fn(),
  loadVectorExtensionMock: vi.fn(),
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
  loadVectorExtension: loadVectorExtensionMock,
}));

vi.mock('../../src/core/lbug/lbug-config.js', () => ({
  createLbugDatabase: vi.fn(),
  toNativeSafePath: vi.fn((p: string) => p),
  isWalCorruptionError: vi.fn(() => false),
  WAL_RECOVERY_SUGGESTION: '',
}));

const { closeLbug, ensureVectorExtension, initLbugWithDb } =
  await import('../../src/core/lbug/pool-adapter.js');

describe('read-pool FTS loading', () => {
  afterEach(async () => {
    await closeLbug().catch(() => {});
    loadFTSExtensionMock.mockReset();
    loadVectorExtensionMock.mockReset();
    loadVectorExtensionMock.mockResolvedValue(false);
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

  it('does not probe VECTOR while initializing exact-read pools (#3021)', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockResolvedValue(true);
    const db = {} as any;

    await initLbugWithDb('repo-a', db, '/tmp/shared-vec-db');
    await initLbugWithDb('repo-b', db, '/tmp/shared-vec-db');

    expect(loadVectorExtensionMock).not.toHaveBeenCalled();
  });

  it('loads VECTOR lazily once for concurrent semantic reads on a shared Database', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockResolvedValue(true);
    const db = {} as any;

    await initLbugWithDb('repo-a', db, '/tmp/shared-vec-db');
    await initLbugWithDb('repo-b', db, '/tmp/shared-vec-db');

    await expect(
      Promise.all([ensureVectorExtension('repo-a'), ensureVectorExtension('repo-b')]),
    ).resolves.toEqual([true, true]);

    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(1);
    expect(loadVectorExtensionMock).toHaveBeenCalledWith(expect.anything(), {
      policy: 'load-only',
    });
  });

  it('caches an unavailable VECTOR result until the shared Database is reopened', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockResolvedValue(false);
    const db = {} as any;

    await initLbugWithDb('repo-a', db, '/tmp/shared-vec-db');
    await expect(ensureVectorExtension('repo-a')).resolves.toBe(false);
    await expect(ensureVectorExtension('repo-a')).resolves.toBe(false);

    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(1);

    await closeLbug('repo-a');
    await initLbugWithDb('repo-b', db, '/tmp/shared-vec-db');
    await expect(ensureVectorExtension('repo-b')).resolves.toBe(false);

    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(2);
  });

  it('retries VECTOR after a rejected lazy load', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockRejectedValueOnce(new Error('transient load failure'));
    loadVectorExtensionMock.mockResolvedValueOnce(true);
    const db = {} as any;

    await initLbugWithDb('repo-a', db, '/tmp/shared-vec-retry-db');
    await expect(ensureVectorExtension('repo-a')).rejects.toThrow('transient load failure');
    await expect(ensureVectorExtension('repo-a')).resolves.toBe(true);

    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(2);
  });
});
