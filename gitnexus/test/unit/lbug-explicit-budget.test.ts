import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLbugDatabase, openLbugConnection } from '../../src/core/lbug/lbug-config.js';

afterEach(() => vi.unstubAllEnvs());

describe('explicit native handle reservations', () => {
  it('uses a per-handle reservation while preserving the environment policy for legacy callers', () => {
    vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', '0');
    const Database = vi.fn<(...args: unknown[]) => void>(function () {});
    const module = { Database } as unknown as Parameters<typeof createLbugDatabase>[0];
    createLbugDatabase(module, '/tmp/budgeted', { bufferPoolBytes: 64 * 1024 * 1024 });
    expect(Database.mock.calls[0][1]).toBe(64 * 1024 * 1024);
    createLbugDatabase(module, '/tmp/legacy');
    expect(Database.mock.calls[1][1]).toBe(0);
  });

  it.each([-1, NaN, Infinity, 1.5])(
    'rejects invalid explicit reservation %s before opening native',
    (bufferPoolBytes) => {
      const Database = vi.fn<(...args: unknown[]) => void>(function () {});
      const module = { Database } as unknown as Parameters<typeof createLbugDatabase>[0];
      expect(() => createLbugDatabase(module, '/tmp/invalid', { bufferPoolBytes })).toThrow(
        'nonnegative byte',
      );
      expect(Database).not.toHaveBeenCalled();
    },
  );

  it('passes an explicit thread count only when requested', async () => {
    const Database = vi.fn<(...args: unknown[]) => void>(function () {});
    const Connection = vi.fn<(...args: unknown[]) => void>(function () {});
    const module = { Database, Connection } as unknown as Parameters<typeof openLbugConnection>[0];
    await openLbugConnection(module, '/tmp/threads', {
      bufferPoolBytes: 64 * 1024 * 1024,
      threads: 2,
    });
    expect(Connection.mock.calls[0]).toHaveLength(2);
    expect(Connection.mock.calls[0][1]).toBe(2);
    await openLbugConnection(module, '/tmp/legacy');
    expect(Connection.mock.calls[1]).toHaveLength(1);
    await expect(openLbugConnection(module, '/tmp/invalid', { threads: 0 })).rejects.toThrow(
      'positive integer',
    );
    expect(Database).toHaveBeenCalledTimes(2);
  });
});
