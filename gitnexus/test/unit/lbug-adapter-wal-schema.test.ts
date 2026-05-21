/**
 * Tests for WAL corruption detection in the doInitLbug schema creation loop.
 *
 * Before this fix, a corrupt WAL that threw during schema DDL was silently
 * logged as WARN. After the fix, `isWalCorruptionError` is checked first:
 * the DB is closed cleanly and an Error with `WAL_RECOVERY_SUGGESTION` is
 * thrown so the caller (serve / MCP / analyze) can exit with a clear message.
 *
 * Two test layers (same pattern as lbug-checkpoint-lifecycle.test.ts):
 *   1. Structural — grep the adapter source to verify the guard is wired in.
 *   2. Behavioural — vi.doMock + vi.resetModules to exercise the runtime path.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeOpenMock = () =>
  vi.fn(async () => ({
    writeFile: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }));

const SCHEMA_MOCK = {
  NODE_TABLES: ['File', 'Function', 'Class'],
  REL_TABLE_NAME: 'CodeRelation',
  EMBEDDING_TABLE_NAME: 'Embedding',
  STALE_HASH_SENTINEL: '__stale__',
  SCHEMA_QUERIES: ['CREATE NODE TABLE IF NOT EXISTS File (id STRING, PRIMARY KEY(id))'],
};

function makeFsMock(dbPath: string) {
  const ENOENT = Object.assign(new Error(`ENOENT: ${dbPath}`), { code: 'ENOENT' });
  return {
    default: {
      lstat: vi.fn(async () => {
        throw ENOENT;
      }),
      access: vi.fn(async () => {
        throw ENOENT;
      }),
      unlink: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      open: makeOpenMock(),
    },
  };
}

// ─── Structural tests ─────────────────────────────────────────────────────────

describe('doInitLbug WAL corruption guard — structural', () => {
  let adapterSource: string;
  let schemaLoopBody: string;

  beforeAll(async () => {
    adapterSource = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'lbug-adapter.ts'),
      'utf-8',
    );
    // 3000-char window from the SCHEMA_QUERIES loop comfortably covers the
    // full catch block including the throw with WAL_RECOVERY_SUGGESTION.
    const loopIdx = adapterSource.indexOf('for (const schemaQuery of SCHEMA_QUERIES)');
    schemaLoopBody = adapterSource.slice(loopIdx, loopIdx + 3000);
  });

  it('imports isWalCorruptionError and WAL_RECOVERY_SUGGESTION from lbug-config', () => {
    expect(adapterSource).toMatch(/isWalCorruptionError/);
    expect(adapterSource).toMatch(/WAL_RECOVERY_SUGGESTION/);
    expect(adapterSource).toMatch(/from '\.\/lbug-config\.js'/);
  });

  it('calls isWalCorruptionError inside the schema creation loop catch block', () => {
    expect(schemaLoopBody).toMatch(/isWalCorruptionError\(err\)/);
  });

  it('WAL guard calls safeClose() to avoid leaving an open handle', () => {
    expect(schemaLoopBody).toMatch(/await safeClose\(\)/);
  });

  it('WAL guard resets open connection state', () => {
    expect(schemaLoopBody).toMatch(/resetOpenConnectionState\(\)/);
  });

  it('WAL guard throws with WAL_RECOVERY_SUGGESTION in the message', () => {
    expect(schemaLoopBody).toMatch(/WAL_RECOVERY_SUGGESTION/);
    expect(schemaLoopBody).toMatch(/throw new Error/);
  });

  it('WAL guard appears BEFORE the generic schema-warning logger.warn', () => {
    const walGuardIdx = schemaLoopBody.indexOf('isWalCorruptionError(err)');
    // Avoid multi-byte emoji — search for the text portion only
    const warnIdx = schemaLoopBody.indexOf('Schema creation warning');
    expect(walGuardIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(-1);
    expect(walGuardIdx).toBeLessThan(warnIdx);
  });
});

// ─── Behavioural tests ────────────────────────────────────────────────────────

describe('doInitLbug WAL corruption guard — behavioural', () => {
  afterEach(() => {
    vi.doUnmock('fs/promises');
    vi.doUnmock('../../src/core/lbug/schema.js');
    vi.doUnmock('../../src/core/lbug/lbug-config.js');
    vi.doUnmock('../../src/core/lbug/extension-loader.js');
    vi.doUnmock('../../src/core/logger.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('throws with WAL recovery message when a schema query raises a WAL corruption error', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-wal-schema-throw/lbug';
    const walError = new Error(
      'Runtime exception: Corrupted wal file. Read out invalid WAL record type.',
    );
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const conn = {
      query: vi.fn().mockRejectedValueOnce(walError).mockResolvedValue(queryResult),
      close: vi.fn(async () => {}),
    };
    const db = { close: vi.fn(async () => {}) };

    vi.doMock('fs/promises', () => makeFsMock(dbPath));
    vi.doMock('../../src/core/lbug/schema.js', () => SCHEMA_MOCK);
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn(() => false),
      isOpenRetryExhausted: vi.fn(() => false),
      isWalCorruptionError: vi.fn((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return /corrupt.*wal|invalid.*wal.*record/i.test(msg);
      }),
      WAL_RECOVERY_SUGGESTION:
        'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => true),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    // Catch the error once and assert both patterns in the message.
    // (mockRejectedValueOnce is consumed on the first call, so a second
    //  initLbug call would succeed — test both patterns in one shot.)
    const err = await adapter.initLbug(dbPath).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/LadybugDB WAL corruption detected/);
    expect((err as Error).message).toMatch(/gitnexus analyze/);
  });

  it('does NOT throw for unrecognised schema errors — logs warn and continues', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-wal-schema-nonwal/lbug';
    const genericError = new Error('some unrelated schema warning');
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    let callCount = 0;
    const conn = {
      query: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw genericError;
        return queryResult;
      }),
      close: vi.fn(async () => {}),
    };
    const db = { close: vi.fn(async () => {}) };
    const warnMock = vi.fn();

    vi.doMock('fs/promises', () => makeFsMock(dbPath));
    vi.doMock('../../src/core/lbug/schema.js', () => SCHEMA_MOCK);
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn(() => false),
      isOpenRetryExhausted: vi.fn(() => false),
      isWalCorruptionError: vi.fn(() => false), // always false → generic warn path
      WAL_RECOVERY_SUGGESTION:
        'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => true),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    // Must resolve without throwing — non-WAL schema errors are swallowed (logged as WARN)
    await expect(adapter.initLbug(dbPath)).resolves.toBeDefined();
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('Schema creation warning'));

    await adapter.closeLbug();
  });

  it('quarantines the WAL and retries writable schema creation when shadow sidecar is missing', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-writable-shadow-missing/lbug';
    const missingShadowError = new Error(
      `IO exception: Cannot open file ${dbPath}.shadow: No such file or directory`,
    );
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const firstConn = {
      query: vi.fn().mockRejectedValueOnce(missingShadowError).mockResolvedValue(queryResult),
      close: vi.fn(async () => {}),
    };
    const firstDb = { close: vi.fn(async () => {}) };
    const recoveredConn = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const recoveredDb = { close: vi.fn(async () => {}) };
    const openLbugConnectionMock = vi
      .fn()
      .mockResolvedValueOnce({ db: firstDb, conn: firstConn })
      .mockResolvedValueOnce({ db: recoveredDb, conn: recoveredConn });
    const fsMock = makeFsMock(dbPath);
    const ensureMock = vi.fn(async () => false);
    const warnMock = vi.fn();

    vi.doMock('fs/promises', () => fsMock);
    vi.doMock('../../src/core/lbug/schema.js', () => SCHEMA_MOCK);
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: openLbugConnectionMock,
      closeLbugConnection: async (handle: { conn: typeof firstConn; db: typeof firstDb }) => {
        await handle.conn.close();
        await handle.db.close();
      },
      isDbBusyError: vi.fn(() => false),
      isOpenRetryExhausted: vi.fn(() => false),
      isWalCorruptionError: vi.fn(() => false),
      WAL_RECOVERY_SUGGESTION:
        'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: ensureMock,
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(adapter.initLbug(dbPath)).resolves.toBeDefined();

    expect(openLbugConnectionMock).toHaveBeenCalledTimes(2);
    expect(fsMock.default.rename).toHaveBeenCalledWith(
      `${dbPath}.wal`,
      expect.stringContaining(`${dbPath}.wal.missing-shadow.`),
    );
    expect(recoveredConn.query).toHaveBeenCalledWith(SCHEMA_MOCK.SCHEMA_QUERIES[0]);
    expect(warnMock).not.toHaveBeenCalledWith(expect.stringContaining('Schema creation warning'));

    await adapter.closeLbug();
  });

  it('skips schema DDL and uses load-only FTS policy for read-only opens', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-readonly-schema-skip/lbug';
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const conn = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const db = { close: vi.fn(async () => {}) };
    const openLbugConnectionMock = vi.fn(async () => ({ db, conn }));
    const ensureMock = vi.fn(async () => false);
    const warnMock = vi.fn();

    vi.doMock('fs/promises', () => makeFsMock(dbPath));
    vi.doMock('../../src/core/lbug/schema.js', () => SCHEMA_MOCK);
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: openLbugConnectionMock,
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn(() => false),
      isOpenRetryExhausted: vi.fn(() => false),
      isWalCorruptionError: vi.fn(() => false),
      WAL_RECOVERY_SUGGESTION:
        'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: ensureMock,
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(adapter.withLbugDb(dbPath, async () => 'ok', { readOnly: true })).resolves.toBe(
      'ok',
    );

    expect(openLbugConnectionMock).toHaveBeenCalledWith(expect.anything(), dbPath, {
      readOnly: true,
    });
    expect(conn.query).not.toHaveBeenCalledWith(SCHEMA_MOCK.SCHEMA_QUERIES[0]);
    expect(ensureMock).toHaveBeenCalledWith(expect.any(Function), 'fts', 'FTS', {
      policy: 'load-only',
    });
    expect(warnMock).not.toHaveBeenCalledWith(expect.stringContaining('Schema creation warning'));

    await adapter.closeLbug();
  });

  it('replays dirty shadow pages with a temporary writable open before read-only serving', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-readonly-shadow-replay/lbug';
    const shadowReplayError = new Error(
      "Runtime exception: Couldn't replay shadow pages under read-only mode. Please re-open the database with read-write mode to replay shadow pages.",
    );
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const readOnlyConn1 = {
      query: vi.fn().mockRejectedValueOnce(shadowReplayError),
      close: vi.fn(async () => {}),
    };
    const readOnlyDb1 = { close: vi.fn(async () => {}) };
    const writableConn = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const writableDb = { close: vi.fn(async () => {}) };
    const readOnlyConn2 = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const readOnlyDb2 = { close: vi.fn(async () => {}) };
    const openLbugConnectionMock = vi
      .fn()
      .mockResolvedValueOnce({ db: readOnlyDb1, conn: readOnlyConn1 })
      .mockResolvedValueOnce({ db: writableDb, conn: writableConn })
      .mockResolvedValueOnce({ db: readOnlyDb2, conn: readOnlyConn2 });
    const ensureMock = vi.fn(async () => false);

    vi.doMock('fs/promises', () => makeFsMock(dbPath));
    vi.doMock('../../src/core/lbug/schema.js', () => SCHEMA_MOCK);
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: openLbugConnectionMock,
      closeLbugConnection: async (handle: {
        conn: typeof readOnlyConn1;
        db: typeof readOnlyDb1;
      }) => {
        await handle.conn.close();
        await handle.db.close();
      },
      isDbBusyError: vi.fn(() => false),
      isOpenRetryExhausted: vi.fn(() => false),
      isWalCorruptionError: vi.fn(() => false),
      WAL_RECOVERY_SUGGESTION:
        'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: ensureMock,
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(adapter.withLbugDb(dbPath, async () => 'ok', { readOnly: true })).resolves.toBe(
      'ok',
    );

    expect(openLbugConnectionMock).toHaveBeenNthCalledWith(1, expect.anything(), dbPath, {
      readOnly: true,
    });
    expect(openLbugConnectionMock).toHaveBeenNthCalledWith(2, expect.anything(), dbPath);
    expect(openLbugConnectionMock).toHaveBeenNthCalledWith(3, expect.anything(), dbPath, {
      readOnly: true,
    });
    expect(readOnlyConn1.close).toHaveBeenCalled();
    expect(readOnlyDb1.close).toHaveBeenCalled();
    expect(writableConn.query).toHaveBeenCalledWith('MATCH (n) RETURN n LIMIT 1');
    expect(writableConn.close).toHaveBeenCalled();
    expect(writableDb.close).toHaveBeenCalled();
    expect(readOnlyConn2.query).toHaveBeenCalledWith('MATCH (n) RETURN n LIMIT 1');
    expect(ensureMock).toHaveBeenCalledWith(expect.any(Function), 'fts', 'FTS', {
      policy: 'load-only',
    });

    await adapter.closeLbug();
  });

  it('quarantines the WAL and reopens read-only when the shadow sidecar is missing', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-readonly-shadow-missing/lbug';
    const missingShadowError = new Error(
      `IO exception: Cannot open file ${dbPath}.shadow: No such file or directory`,
    );
    const readOnlyConn = {
      query: vi.fn().mockRejectedValueOnce(missingShadowError),
      close: vi.fn(async () => {}),
    };
    const readOnlyDb = { close: vi.fn(async () => {}) };
    const recoveredConn = {
      query: vi.fn(async () => ({ getAll: vi.fn(async () => []), close: vi.fn() })),
      close: vi.fn(async () => {}),
    };
    const recoveredDb = { close: vi.fn(async () => {}) };
    const openLbugConnectionMock = vi
      .fn()
      .mockResolvedValueOnce({
        db: readOnlyDb,
        conn: readOnlyConn,
      })
      .mockResolvedValueOnce({
        db: recoveredDb,
        conn: recoveredConn,
      });
    const fsMock = makeFsMock(dbPath);

    vi.doMock('fs/promises', () => fsMock);
    vi.doMock('../../src/core/lbug/schema.js', () => SCHEMA_MOCK);
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: openLbugConnectionMock,
      closeLbugConnection: async (handle: { conn: typeof readOnlyConn; db: typeof readOnlyDb }) => {
        await handle.conn.close();
        await handle.db.close();
      },
      isDbBusyError: vi.fn(() => false),
      isOpenRetryExhausted: vi.fn(() => false),
      isWalCorruptionError: vi.fn(() => false),
      WAL_RECOVERY_SUGGESTION:
        'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => false),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(adapter.withLbugDb(dbPath, async () => 'ok', { readOnly: true })).resolves.toBe(
      'ok',
    );
    expect(openLbugConnectionMock).toHaveBeenCalledTimes(2);
    expect(readOnlyConn.close).toHaveBeenCalled();
    expect(readOnlyDb.close).toHaveBeenCalled();
    expect(fsMock.default.rename).toHaveBeenCalledWith(
      `${dbPath}.wal`,
      expect.stringContaining(`${dbPath}.wal.missing-shadow.`),
    );

    await adapter.closeLbug();
  });

  it('calls safeClose() (db.close) when WAL corruption is detected mid-schema', async () => {
    vi.resetModules();

    const dbPath = '/tmp/gitnexus-lbug-wal-schema-state/lbug';
    const walError = new Error('Corrupted wal file. Read out invalid WAL record type.');
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const conn = {
      query: vi.fn().mockRejectedValueOnce(walError).mockResolvedValue(queryResult),
      close: vi.fn(async () => {}),
    };
    const db = { close: vi.fn(async () => {}) };

    vi.doMock('fs/promises', () => makeFsMock(dbPath));
    vi.doMock('../../src/core/lbug/schema.js', () => SCHEMA_MOCK);
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: vi.fn(async () => ({ db, conn })),
      closeLbugConnection: vi.fn(async () => {}),
      isDbBusyError: vi.fn(() => false),
      isOpenRetryExhausted: vi.fn(() => false),
      isWalCorruptionError: vi.fn((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return /corrupt.*wal|invalid.*wal.*record/i.test(msg);
      }),
      WAL_RECOVERY_SUGGESTION:
        'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => true),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(adapter.initLbug(dbPath)).rejects.toThrow(/LadybugDB WAL corruption/);

    // safeClose was called — db.close is its final step
    expect(db.close).toHaveBeenCalled();
  });
});

// ─── Symmetric WAL-size gate (PR #1747 review, D2) ──────────────────────────
//
// Both reopenWritableAfterMissingShadow and reopenReadOnlyAfterMissingShadow
// must refuse to quarantine a WAL larger than TINY_ORPHAN_WAL_BYTES (4096).
// The pre-PR behavior silently quarantined any size of WAL during recovery —
// on the read-only path this could permanently orphan uncheckpointed pages
// because a later writable open would see a `clean` state and never replay.

const TINY_ORPHAN_WAL_BYTES_TEST = 4 * 1024;

/**
 * Variant of makeFsMock where the `.wal` path is classified by
 * inspectLbugSidecars based on a chosen size. Use to drive the
 * `orphan-wal` vs `tiny-orphan-wal` branches of refuseLargeWalQuarantine
 * without spinning up real files.
 */
function makeFsMockWithWalSize(dbPath: string, walBytes: number | 'missing') {
  const ENOENT = Object.assign(new Error(`ENOENT: ${dbPath}`), { code: 'ENOENT' });
  const isWal = (p: string): boolean => p === `${dbPath}.wal`;
  const isShadow = (p: string): boolean => p === `${dbPath}.shadow`;
  return {
    default: {
      lstat: vi.fn(async () => {
        throw ENOENT;
      }),
      access: vi.fn(async (p: string) => {
        if (isWal(p) && walBytes !== 'missing') return;
        throw ENOENT;
      }),
      stat: vi.fn(async (p: string) => {
        if (isWal(p)) {
          if (walBytes === 'missing') throw ENOENT;
          return { size: walBytes };
        }
        if (isShadow(p)) throw ENOENT;
        return { size: 0 };
      }),
      unlink: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      open: makeOpenMock(),
    },
  };
}

describe('Symmetric WAL-size gate during missing-shadow recovery (PR #1747 D2)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  const setupShadowMissingRecovery = (dbPath: string, walBytes: number | 'missing') => {
    const missingShadowError = new Error(
      `IO exception: Cannot open file ${dbPath}.shadow: No such file or directory`,
    );
    const queryResult = { getAll: vi.fn(async () => []), close: vi.fn() };
    const firstConn = {
      query: vi.fn().mockRejectedValueOnce(missingShadowError).mockResolvedValue(queryResult),
      close: vi.fn(async () => {}),
    };
    const firstDb = { close: vi.fn(async () => {}) };
    const recoveredConn = {
      query: vi.fn(async () => queryResult),
      close: vi.fn(async () => {}),
    };
    const recoveredDb = { close: vi.fn(async () => {}) };
    const openLbugConnectionMock = vi
      .fn()
      .mockResolvedValueOnce({ db: firstDb, conn: firstConn })
      .mockResolvedValueOnce({ db: recoveredDb, conn: recoveredConn });
    const fsMock = makeFsMockWithWalSize(dbPath, walBytes);
    const warnMock = vi.fn();

    vi.doMock('fs/promises', () => fsMock);
    vi.doMock('../../src/core/lbug/schema.js', () => SCHEMA_MOCK);
    vi.doMock('../../src/core/lbug/lbug-config.js', () => ({
      openLbugConnection: openLbugConnectionMock,
      closeLbugConnection: async (handle: { conn: typeof firstConn; db: typeof firstDb }) => {
        await handle.conn.close();
        await handle.db.close();
      },
      isDbBusyError: vi.fn(() => false),
      isOpenRetryExhausted: vi.fn(() => false),
      isWalCorruptionError: vi.fn(() => false),
      WAL_RECOVERY_SUGGESTION:
        'WAL corruption detected. Run `gitnexus analyze --force` to rebuild the index.',
      waitForWindowsHandleRelease: vi.fn(async () => true),
    }));
    vi.doMock('../../src/core/lbug/extension-loader.js', () => ({
      extensionManager: {
        ensure: vi.fn(async () => false),
        getCapabilities: vi.fn(() => []),
        reset: vi.fn(),
      },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    return { fsMock, openLbugConnectionMock, warnMock };
  };

  it('writable recovery: refuses to quarantine a large WAL (4097 bytes) and throws shadow-recovery message', async () => {
    vi.resetModules();
    const dbPath = '/tmp/gitnexus-lbug-large-wal-writable/lbug';
    const { fsMock, warnMock } = setupShadowMissingRecovery(dbPath, TINY_ORPHAN_WAL_BYTES_TEST + 1);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(adapter.initLbug(dbPath)).rejects.toThrow(
      /LadybugDB checkpoint sidecar is missing/,
    );
    expect(fsMock.default.rename).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('refusing to quarantine large WAL'),
    );
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('writable recovery'));
  });

  it('read-only recovery: refuses to quarantine a large WAL (4097 bytes) and throws shadow-recovery message', async () => {
    vi.resetModules();
    const dbPath = '/tmp/gitnexus-lbug-large-wal-readonly/lbug';
    const { fsMock, warnMock } = setupShadowMissingRecovery(dbPath, TINY_ORPHAN_WAL_BYTES_TEST + 1);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(
      adapter.withLbugDb(dbPath, async () => 'unreached', { readOnly: true }),
    ).rejects.toThrow(/LadybugDB checkpoint sidecar is missing/);
    expect(fsMock.default.rename).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('refusing to quarantine large WAL'),
    );
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('read-only recovery'));
  });

  it('writable recovery: WAL at exactly TINY_ORPHAN_WAL_BYTES (4096 bytes) is treated as tiny and quarantined', async () => {
    vi.resetModules();
    const dbPath = '/tmp/gitnexus-lbug-boundary-tiny/lbug';
    const { fsMock } = setupShadowMissingRecovery(dbPath, TINY_ORPHAN_WAL_BYTES_TEST);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(adapter.initLbug(dbPath)).resolves.toBeDefined();
    expect(fsMock.default.rename).toHaveBeenCalledWith(
      `${dbPath}.wal`,
      expect.stringContaining(`${dbPath}.wal.missing-shadow.`),
    );
    await adapter.closeLbug();
  });

  it('writable recovery: WAL at TINY_ORPHAN_WAL_BYTES + 1 (4097 bytes) is treated as orphan-wal and refused', async () => {
    vi.resetModules();
    const dbPath = '/tmp/gitnexus-lbug-boundary-large/lbug';
    const { fsMock } = setupShadowMissingRecovery(dbPath, TINY_ORPHAN_WAL_BYTES_TEST + 1);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(adapter.initLbug(dbPath)).rejects.toThrow();
    expect(fsMock.default.rename).not.toHaveBeenCalled();
  });

  it('tiny-WAL recovery path: writable recovery still quarantines and proceeds for a 1024-byte WAL', async () => {
    vi.resetModules();
    const dbPath = '/tmp/gitnexus-lbug-tiny-wal/lbug';
    const { fsMock } = setupShadowMissingRecovery(dbPath, 1024);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    await expect(adapter.initLbug(dbPath)).resolves.toBeDefined();
    expect(fsMock.default.rename).toHaveBeenCalledWith(
      `${dbPath}.wal`,
      expect.stringContaining(`${dbPath}.wal.missing-shadow.`),
    );
    await adapter.closeLbug();
  });
});
