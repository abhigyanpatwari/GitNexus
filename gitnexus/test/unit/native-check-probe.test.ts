import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for probeFtsExtensionLoad (#2374, PR #2375): the doctor FTS
 * probe's outcomes without the real native module or network. @ladybugdb/core
 * is mocked so query behavior (resolve / reject / never-settle) is controlled
 * per test, and the timeout is exercised with a tiny injected budget.
 */

const h = vi.hoisted(() => ({
  query: vi.fn<(sql: string) => Promise<unknown>>(),
  connCtor: vi.fn<() => void>(),
  connClose: vi.fn<() => Promise<void>>(async () => undefined),
  dbClose: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock('@ladybugdb/core', () => {
  class Database {
    constructor(_path: string) {}
    close = h.dbClose;
  }
  class Connection {
    constructor(_db: unknown) {
      h.connCtor();
    }
    query = h.query;
    close = h.connClose;
  }
  return { default: { Database, Connection } };
});

import { probeFtsExtensionLoad } from '../../src/core/lbug/native-check.js';

const closeable = () => ({ close: vi.fn() });

beforeEach(() => {
  h.query.mockReset();
  h.connCtor.mockReset();
  h.connClose.mockClear();
  h.dbClose.mockClear();
});

describe('probeFtsExtensionLoad (#2374)', () => {
  it('reports loaded and closes every result when LOAD succeeds (array result)', async () => {
    const results = [closeable(), closeable()];
    h.query.mockResolvedValue(results);

    await expect(probeFtsExtensionLoad()).resolves.toEqual({ loaded: true });

    expect(results.map((r) => r.close.mock.calls.length)).toEqual([1, 1]);
    expect(h.connClose).toHaveBeenCalled();
    expect(h.dbClose).toHaveBeenCalled();
  });

  it('reports loaded for a single (non-array) result', async () => {
    h.query.mockResolvedValue(closeable());
    await expect(probeFtsExtensionLoad()).resolves.toEqual({ loaded: true });
  });

  it('reports the collapsed reason when LOAD fails', async () => {
    h.query.mockRejectedValue(new Error('IO exception:\n  invalid ELF header'));
    await expect(probeFtsExtensionLoad()).resolves.toMatchObject({
      loaded: false,
      reason: 'IO exception: invalid ELF header',
    });
  });

  it('times out instead of hanging when the native call never settles', async () => {
    h.query.mockReturnValue(new Promise<unknown>(() => undefined));
    await expect(probeFtsExtensionLoad(20)).resolves.toMatchObject({
      loaded: false,
      reason: expect.stringContaining('timed out'),
    });
  });

  it('still closes the db when the Connection ctor throws', async () => {
    h.connCtor.mockImplementation(() => {
      throw new Error('connection ctor failed');
    });
    await expect(probeFtsExtensionLoad()).resolves.toMatchObject({ loaded: false });
    expect(h.dbClose).toHaveBeenCalled();
  });

  it('reports loaded even when a result close() throws', async () => {
    h.query.mockResolvedValue({
      close: () => {
        throw new Error('close boom');
      },
    });
    await expect(probeFtsExtensionLoad()).resolves.toEqual({ loaded: true });
  });
});
