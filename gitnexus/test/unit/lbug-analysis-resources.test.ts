import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const native = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(async () => {}),
  quarantine: vi.fn(async () => ({ quarantinedPath: '/unused' })),
}));
vi.mock('../../src/core/lbug/lbug-config.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/lbug-config.js')>()),
  openLbugConnection: native.open,
  closeLbugConnection: native.close,
}));
vi.mock('../../src/core/lbug/sidecar-recovery.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/sidecar-recovery.js')>()),
  quarantineWalForMissingShadow: native.quarantine,
  isMissingShadowSidecarError: (error: unknown) =>
    error instanceof Error && error.message === 'missing shadow test',
}));
vi.mock('../../src/core/lbug/extension-loader.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/extension-loader.js')>()),
  extensionManager: {
    ensure: vi.fn(async () => true),
    reset: vi.fn(),
    getCapabilities: vi.fn(() => []),
  },
}));

describe('analysis database resource allocations', () => {
  let root: string;
  let adapter: typeof import('../../src/core/lbug/lbug-adapter.js');
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-analysis-resources-'));
    native.open.mockImplementation(async () => ({
      db: { close: vi.fn(async () => {}) },
      conn: {
        query: vi.fn(async () => ({ getAll: async () => [], close: () => {} })),
        close: vi.fn(async () => {}),
      },
    }));
    adapter = await import('../../src/core/lbug/lbug-adapter.js');
  });
  afterEach(async () => {
    await adapter.closeLbug();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('applies native allocations and reopens only when the allocation changes', async () => {
    const dbPath = path.join(root, 'lbug');
    const options = { skipFts: true, bufferPoolBytes: 64 * 1024 * 1024, threads: 3 };
    await adapter.initLbug(dbPath, options);
    await adapter.initLbug(dbPath, { ...options });
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(native.open.mock.calls[0][2]).toEqual({
      bufferPoolBytes: options.bufferPoolBytes,
      threads: 3,
    });
    const first = await native.open.mock.results[0].value;
    await adapter.initLbug(dbPath, { ...options, threads: 2 });
    expect(first.conn.close).toHaveBeenCalledTimes(1);
    expect(first.db.close).toHaveBeenCalledTimes(1);
    expect(native.open).toHaveBeenCalledTimes(2);
    expect(native.open.mock.calls[1][2]).toEqual({
      bufferPoolBytes: options.bufferPoolBytes,
      threads: 2,
    });
  });

  it('rejects invalid allocations before creating the database directory or opening native code', async () => {
    const parent = path.join(root, 'not-created');
    for (const options of [
      { bufferPoolBytes: 0 },
      { bufferPoolBytes: 1024 },
      { threads: 0 },
      { threads: 1.5 },
    ]) {
      await expect(adapter.initLbug(path.join(parent, 'lbug'), options)).rejects.toThrow(
        /Explicit LadybugDB/,
      );
    }
    expect(native.open).not.toHaveBeenCalled();
    await expect(fs.stat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['conn', 'db'] as const)(
    'retains a failed %s close and refuses to allocate another pool',
    async (handle) => {
      const dbPath = path.join(root, 'lbug');
      const options = { skipFts: true, bufferPoolBytes: 64 * 1024 * 1024, threads: 3 };
      await adapter.initLbug(dbPath, options);
      const first = await native.open.mock.results[0].value;
      first[handle].close.mockRejectedValueOnce(new Error('native close failed'));
      await expect(adapter.initLbug(dbPath, { ...options, threads: 2 })).rejects.toThrow(
        'native close failed',
      );
      expect(native.open).toHaveBeenCalledTimes(1);
      // A subsequent successful drain can safely admit the requested allocation.
      await adapter.initLbug(dbPath, options);
      expect(native.open).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps the same allocations when missing-shadow recovery reopens the writer', async () => {
    native.open.mockResolvedValueOnce({
      db: { close: vi.fn(async () => {}) },
      conn: {
        query: vi.fn(async () => {
          throw new Error('missing shadow test');
        }),
        close: vi.fn(async () => {}),
      },
    });
    const options = { skipFts: true, bufferPoolBytes: 32 * 1024 * 1024, threads: 2 };
    await adapter.initLbug(path.join(root, 'lbug'), options);
    expect(native.quarantine).toHaveBeenCalledTimes(1);
    expect(native.open).toHaveBeenCalledTimes(2);
    expect(native.open.mock.calls.map((call) => call[2])).toEqual([
      { bufferPoolBytes: options.bufferPoolBytes, threads: 2 },
      { bufferPoolBytes: options.bufferPoolBytes, threads: 2 },
    ]);
  });
});
