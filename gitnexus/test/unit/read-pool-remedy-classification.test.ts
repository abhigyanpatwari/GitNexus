/**
 * The reader buffer-pool remedy is appended to engine errors on the read path.
 * Several callers classify errors by message text, so the remedy must not
 * change the class of the error it wraps: a pool-exhausted read is not a
 * forbidden write, a busy lock, a missing table, a WAL or version problem.
 * Runs the real pool adapter, direct adapter (withLbugDb), LocalBackend and
 * classifiers; only the native Database constructor, connections and the
 * direct adapter's open helper are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createDb, prepare, execute, repoMocks } = vi.hoisted(() => ({
  createDb: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  repoMocks: { listRegisteredRepos: vi.fn() },
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(function (this: any) {
      this.init = vi.fn().mockResolvedValue(undefined);
      this.query = vi.fn().mockResolvedValue({ getAll: async () => [], close: vi.fn() });
      this.setMaxNumThreadForExec = vi.fn().mockResolvedValue(undefined);
      this.prepare = prepare;
      this.execute = execute;
      this.close = vi.fn().mockResolvedValue(undefined);
    }),
  },
}));

vi.mock('../../src/core/lbug/lbug-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/lbug-config.js')>()),
  createLbugDatabase: createDb,
  // The direct adapter (withLbugDb) opens through this helper.
  openLbugConnection: async () => ({
    db: { init: async () => undefined, close: async () => undefined },
    conn: {
      init: async () => undefined,
      query: async () => ({ getAll: async () => [], close: () => undefined }),
      prepare,
      execute,
      close: async () => undefined,
    },
  }),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/lbug-adapter.js')>()),
  loadFTSExtension: vi.fn().mockResolvedValue(false),
  loadVectorExtension: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: repoMocks.listRegisteredRepos,
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/core/git-staleness.js', () => ({
  checkStaleness: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));

import {
  bufferPoolExhaustionRemedy,
  classifyDeleteAllError,
  isDbBusyError,
  isLbugCheckpointBusyError,
  isLbugCheckpointIoError,
  isLbugPageSizeFrameError,
  isOpenRetryExhausted,
  isStorageVersionMismatchError,
  isWalCorruptionError,
  maxDbSizeReachedRemedy,
  pastEofReadRemedy,
  keepPoolErrorAsIs,
  readBufferPoolExhaustionRemedy,
  withReadBufferPoolRemedy,
} from '../../src/core/lbug/lbug-config.js';
import {
  closeLbug as closeDirectLbug,
  isBenignDropFtsIndexError,
  isReadOnlyDbError,
  withLbugDb,
} from '../../src/core/lbug/lbug-adapter.js';
import { _captureLogger } from '../../src/core/logger.js';
import {
  isMissingShadowSidecarError,
  isReadOnlyCheckpointInProgressError,
  isReadOnlyRecoveryFailure,
  isReadOnlyShadowReplayError,
} from '../../src/core/lbug/sidecar-recovery.js';
import { closeLbug, executeParameterized, initLbug } from '../../src/core/lbug/pool-adapter.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const ENGINE_TEXT =
  'Buffer manager exception: Unable to allocate memory! The buffer pool is full and no memory could be freed!';

const goodDb = () => ({
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

/** Every message classifier a read-path error can meet, except the intended one. */
const otherClasses = (err: Error): Record<string, unknown> => ({
  readOnlyWrite: isReadOnlyDbError(err),
  busy: isDbBusyError(err),
  checkpointBusy: isLbugCheckpointBusyError(err),
  openRetryExhausted: isOpenRetryExhausted(err),
  walCorruption: isWalCorruptionError(err),
  storageVersion: isStorageVersionMismatchError(err),
  checkpointIo: isLbugCheckpointIoError(err),
  pageSizeFrame: isLbugPageSizeFrameError(err),
  missingTable: classifyDeleteAllError(err) !== 'rethrow',
  benignDropFts: isBenignDropFtsIndexError(err.message),
  missingShadow: isMissingShadowSidecarError(err),
  shadowReplay: isReadOnlyShadowReplayError(err),
  checkpointInProgress: isReadOnlyCheckpointInProgressError(err),
  recoveryFailure: isReadOnlyRecoveryFailure(err),
  maxDbSize: maxDbSizeReachedRemedy(err.message, 'in-place') !== undefined,
  pastEof: pastEofReadRemedy(err.message, 'in-place') !== undefined,
  timeout: /timed out/i.test(err.message),
  notFound: /not found|does not exist|no table named/i.test(err.message),
});

const noOtherClass = Object.fromEntries(
  Object.keys(otherClasses(new Error('x'))).map((key) => [key, false]),
);

describe('reader buffer-pool remedy keeps the error class', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-read-pool-remedy-'));
    fs.mkdirSync(path.join(tmpDir, '.gitnexus'));
    dbPath = path.join(tmpDir, '.gitnexus', 'lbug');
    fs.writeFileSync(dbPath, '');
    createDb.mockImplementation(() => goodDb());
    prepare.mockResolvedValue({ isSuccess: () => true });
    execute.mockResolvedValue({ getAll: async () => [], close: vi.fn() });
    repoMocks.listRegisteredRepos.mockResolvedValue([
      {
        name: 'pool-repo',
        path: tmpDir,
        storagePath: path.join(tmpDir, '.gitnexus'),
        indexedAt: '2026-01-01T00:00:00Z',
        lastCommit: 'abc1234',
      },
    ]);
  });

  afterEach(async () => {
    await closeLbug().catch(() => {});
    await closeDirectLbug().catch(() => {});
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const openError = async (): Promise<Error> => {
    createDb.mockImplementation(() => {
      throw new Error(ENGINE_TEXT);
    });
    return initLbug('open-failure', dbPath).then(
      () => new Error('expected the open to fail'),
      (e: Error) => e,
    );
  };

  const queryError = async (): Promise<Error> => {
    await initLbug('query-failure', dbPath);
    execute.mockRejectedValueOnce(new Error(ENGINE_TEXT));
    return executeParameterized('query-failure', 'RETURN 1', {}).then(
      () => new Error('expected the query to fail'),
      (e: Error) => e,
    );
  };

  it.each([
    ['open', openError],
    ['query', queryError],
  ])('the %s-path wrapper matches no other classifier', async (_label, produce) => {
    const err = await produce();
    expect(err.message).toContain(ENGINE_TEXT);
    expect(err.message).toContain('GITNEXUS_LBUG_BUFFER_POOL_SIZE');
    expect((err as Error & { cause?: Error }).cause?.message).toBe(ENGINE_TEXT);
    expect(otherClasses(err)).toEqual(noOtherClass);
    // The intended class still matches.
    expect(bufferPoolExhaustionRemedy(err.message)).toBeDefined();
  });

  it('the remedy text alone matches no classifier, including the intended one', () => {
    const wrapped = withReadBufferPoolRemedy(new Error(ENGINE_TEXT)) as Error;
    const remedyOnly = new Error(wrapped.message.slice(ENGINE_TEXT.length));
    expect(otherClasses(remedyOnly)).toEqual(noOtherClass);
    expect(bufferPoolExhaustionRemedy(remedyOnly.message)).toBeUndefined();
  });

  it.each([
    ['query', () => prepare.mockRejectedValueOnce(new Error(ENGINE_TEXT))],
    [
      'open',
      () =>
        createDb.mockImplementation(() => {
          throw new Error(ENGINE_TEXT);
        }),
    ],
  ])(
    'MCP cypher reports a full pool at %s with the remedy, not as a forbidden write',
    async (_label, fail) => {
      const backend = new LocalBackend();
      await backend.init();
      fail();

      const outcome = await backend
        .callTool('cypher', { repo: 'pool-repo', query: 'MATCH (n) RETURN n LIMIT 1' })
        .then(
          (result: { error?: string }) => result.error ?? JSON.stringify(result),
          (err: Error) => err.message,
        );

      expect(outcome).toContain(ENGINE_TEXT);
      expect(outcome).toContain('GITNEXUS_LBUG_BUFFER_POOL_SIZE');
      expect(outcome).not.toContain('Write operations');
      expect(outcome).not.toContain('Retry later');
    },
  );

  it('passes a non-exhaustion query error through as the same object', async () => {
    await initLbug('pass-through', dbPath);
    const native = new Error('Binder exception: Table Nope does not exist.');
    execute.mockRejectedValueOnce(native);
    await expect(executeParameterized('pass-through', 'RETURN 1', {})).rejects.toBe(native);
  });

  it('leaves vector-lane errors unchanged: the env knob does not resize its reservation', async () => {
    await initLbug('vector-lane', dbPath, {
      kind: 'vector',
      bufferPoolBytes: 64 * 1024 * 1024,
      threads: 1,
    });
    const native = new Error(ENGINE_TEXT);
    execute.mockRejectedValueOnce(native);
    await expect(executeParameterized('vector-lane', 'RETURN 1', {})).rejects.toBe(native);
  });
  describe('withLbugDb (serve REST reads)', () => {
    const fail = (err: unknown) => async () => {
      throw err;
    };

    it('adds the remedy and keeps the cause for a read-only failure', async () => {
      const native = new Error(ENGINE_TEXT);
      const err = await withLbugDb(dbPath, fail(native), { readOnly: true }).catch((e) => e);
      expect(err.message).toContain(ENGINE_TEXT);
      expect(err.message).toContain('GITNEXUS_LBUG_BUFFER_POOL_SIZE');
      expect(err.cause).toBe(native);
    });

    it('leaves a writable failure as the same object', async () => {
      const native = new Error(ENGINE_TEXT);
      await expect(withLbugDb(dbPath, fail(native))).rejects.toBe(native);
    });

    it('leaves a reserved-lane failure from inside a read-only operation as the same object', async () => {
      await initLbug('vector-in-rest', dbPath, {
        kind: 'vector',
        bufferPoolBytes: 64 * 1024 * 1024,
        threads: 1,
      });
      const native = new Error(ENGINE_TEXT);
      execute.mockRejectedValueOnce(native);
      await expect(
        withLbugDb(dbPath, () => executeParameterized('vector-in-rest', 'RETURN 1', {}), {
          readOnly: true,
        }),
      ).rejects.toBe(native);
    });
  });

  it('wraps once: a wrapped or marked error comes back unchanged', () => {
    const wrapped = withReadBufferPoolRemedy(new Error(ENGINE_TEXT));
    expect(withReadBufferPoolRemedy(wrapped)).toBe(wrapped);
    const marked = keepPoolErrorAsIs(new Error(ENGINE_TEXT));
    expect(withReadBufferPoolRemedy(marked)).toBe(marked);
  });

  it('does not repeat the invalid GITNEXUS_LBUG_BUFFER_POOL_SIZE warning for each wrapped error', () => {
    vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', 'abc');
    const cap = _captureLogger();
    try {
      expect(readBufferPoolExhaustionRemedy(ENGINE_TEXT)).toBeDefined();
      const warnings = cap
        .records()
        .filter(
          (r) =>
            typeof r.msg === 'string' &&
            r.msg.includes('Ignoring invalid GITNEXUS_LBUG_BUFFER_POOL_SIZE'),
        );
      expect(warnings).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });
});
