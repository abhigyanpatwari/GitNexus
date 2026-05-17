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

  it('WAL guard resets currentDbPath to null', () => {
    expect(schemaLoopBody).toMatch(/currentDbPath = null/);
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
