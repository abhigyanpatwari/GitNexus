import path from 'node:path';
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

import {
  ftsAvailabilityLabel,
  probeFtsExtensionLoad,
  probeVectorExtensionLoad,
} from '../../src/core/lbug/native-check.js';

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

  it('reports suppressed-by-policy under never without issuing LOAD', async () => {
    await expect(probeFtsExtensionLoad(undefined, { policy: 'never' })).resolves.toEqual({
      loaded: false,
      suppressed: true,
      reason: 'suppressed by policy GITNEXUS_LBUG_EXTENSION_INSTALL=never',
    });
    expect(h.query).not.toHaveBeenCalled();
    expect(ftsAvailabilityLabel({ loaded: false, suppressed: true })).toBe('suppressed');
  });

  it('tries a vendored path LOAD before the name-only LOAD', async () => {
    h.query.mockResolvedValue(closeable());
    const vendoredPath = '/tmp/gn-fts-vendor/libfts.lbug_extension';

    await expect(
      probeFtsExtensionLoad(undefined, { vendoredPath, policy: 'load-only' }),
    ).resolves.toEqual({ loaded: true });

    expect(h.query).toHaveBeenCalledWith(`LOAD EXTENSION '${path.resolve(vendoredPath)}'`);
    expect(h.query).not.toHaveBeenCalledWith('LOAD EXTENSION fts');
  });

  it('falls back to name-only LOAD when the vendored path LOAD fails', async () => {
    const vendoredPath = '/tmp/gn-fts-vendor/libfts.lbug_extension';
    h.query
      .mockRejectedValueOnce(new Error('IO exception: missing vendored file'))
      .mockResolvedValueOnce(closeable());

    await expect(
      probeFtsExtensionLoad(undefined, {
        vendoredPath,
        policy: 'load-only',
      }),
    ).resolves.toEqual({ loaded: true });

    expect(h.query).toHaveBeenNthCalledWith(1, `LOAD EXTENSION '${path.resolve(vendoredPath)}'`);
    expect(h.query).toHaveBeenNthCalledWith(2, 'LOAD EXTENSION fts');
  });
});

describe('probeVectorExtensionLoad (#2623 follow-up)', () => {
  it('issues LOAD EXTENSION vector and reports loaded on success — no platform short-circuit', async () => {
    h.query.mockResolvedValue(closeable());
    await expect(probeVectorExtensionLoad()).resolves.toEqual({ loaded: true });
    // The probe must really attempt the LOAD (the old code refused Windows
    // before ever touching the engine; the artifact ships for win_amd64 too).
    expect(h.query).toHaveBeenCalledWith('LOAD EXTENSION vector');
  });

  it('reports the collapsed reason when LOAD fails', async () => {
    h.query.mockRejectedValue(new Error('IO exception:\n  extension file not found'));
    await expect(probeVectorExtensionLoad()).resolves.toMatchObject({
      loaded: false,
      reason: 'IO exception: extension file not found',
    });
  });

  it('times out instead of hanging when the native call never settles', async () => {
    h.query.mockReturnValue(new Promise<unknown>(() => undefined));
    await expect(probeVectorExtensionLoad(20)).resolves.toMatchObject({
      loaded: false,
      reason: expect.stringContaining('timed out'),
    });
  });
});
