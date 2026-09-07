import { afterEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { createLbugDatabaseMock, loadFTSExtensionMock, loadVectorExtensionMock } = vi.hoisted(
  () => ({
    createLbugDatabaseMock: vi.fn(),
    loadFTSExtensionMock: vi.fn(),
    loadVectorExtensionMock: vi.fn(),
  }),
);

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(function (this: any) {
      this.query = vi.fn(async () => ({ getAll: async () => [], close: vi.fn() }));
      this.prepare = vi.fn(async () => ({
        isSuccess: () => true,
        getErrorMessage: async () => '',
      }));
      this.execute = vi.fn(async () => ({
        getAll: async () => [],
        close: vi.fn().mockResolvedValue(undefined),
      }));
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
  createLbugDatabase: createLbugDatabaseMock,
  toNativeSafePath: vi.fn((p: string) => p),
  isWalCorruptionError: vi.fn(() => false),
  WAL_RECOVERY_SUGGESTION: '',
}));

const { closeLbug, ensureVectorExtension, executeParameterized, initLbug, initLbugWithDb } =
  await import('../../src/core/lbug/pool-adapter.js');

describe('read-pool FTS loading', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await closeLbug().catch(() => {});
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    createLbugDatabaseMock.mockReset();
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

  it('caches an unavailable VECTOR result until a non-external Database is reopened', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockResolvedValue(false);
    const dir = await mkdtemp(path.join(tmpdir(), 'gitnexus-vector-reopen-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'index.lbug');
    await writeFile(dbPath, 'fixture');
    const firstDb = { init: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const secondDb = { init: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    createLbugDatabaseMock.mockReturnValueOnce(firstDb).mockReturnValueOnce(secondDb);

    await initLbug('repo-a', dbPath);
    await expect(ensureVectorExtension('repo-a')).resolves.toBe(false);
    await expect(ensureVectorExtension('repo-a')).resolves.toBe(false);

    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(1);

    await closeLbug('repo-a');
    await initLbug('repo-b', dbPath);
    await expect(ensureVectorExtension('repo-b')).resolves.toBe(false);

    expect(createLbugDatabaseMock).toHaveBeenCalledTimes(2);
    expect(firstDb.close).toHaveBeenCalledTimes(1);
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

  it('preflights VECTOR only for executable QUERY_VECTOR_INDEX calls', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockResolvedValue(false);
    await initLbugWithDb('repo-a', {} as any, '/tmp/vector-call-detection-db');

    const exactReads = [
      "RETURN 'CALL QUERY_VECTOR_INDEX(' AS sourceText",
      'RETURN "CALL QUERY_VECTOR_INDEX(" AS sourceText',
      'RETURN `CALL QUERY_VECTOR_INDEX(` AS propertyName',
      'RETURN `QUERY_VECTOR_INDEX` AS propertyName',
      "RETURN 'CALL `QUERY_VECTOR_INDEX`(' AS sourceText",
      '// CALL QUERY_VECTOR_INDEX(\nRETURN 1 AS value',
      '// CALL `QUERY_VECTOR_INDEX`(\nRETURN 1 AS value',
      '/* CALL QUERY_VECTOR_INDEX( */ RETURN 1 AS value',
      '/* CALL `QUERY_VECTOR_INDEX`( */ RETURN 1 AS value',
    ];
    for (const cypher of exactReads) {
      await expect(executeParameterized('repo-a', cypher, {})).resolves.toEqual([]);
    }
    expect(loadVectorExtensionMock).not.toHaveBeenCalled();

    await expect(
      executeParameterized(
        'repo-a',
        "call query_vector_index\n('CodeEmbedding', 'embedding_idx', [0.1], 1)",
        {},
      ),
    ).resolves.toEqual([]);
    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(1);
  });

  it('preflights VECTOR for a backtick-escaped procedure identifier', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockResolvedValue(false);
    await initLbugWithDb('repo-a', {} as any, '/tmp/vector-quoted-call-detection-db');

    await expect(
      executeParameterized(
        'repo-a',
        "CALL /* legal comment */ `QUERY_VECTOR_INDEX`('CodeEmbedding', 'embedding_idx', [0.1], 1)",
        {},
      ),
    ).resolves.toEqual([]);
    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(1);
  });

  it('does not hold query connections while a saturated VECTOR preflight loads', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    let releaseVectorLoad: ((loaded: boolean) => void) | undefined;
    loadVectorExtensionMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseVectorLoad = resolve;
        }),
    );
    await initLbugWithDb('repo-a', {} as any, '/tmp/vector-saturation-db');

    const calls = Array.from({ length: 8 }, () =>
      executeParameterized(
        'repo-a',
        "CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'embedding_idx', [0.1], 1)",
        {},
      ),
    );

    try {
      await vi.waitFor(() => expect(loadVectorExtensionMock).toHaveBeenCalledTimes(1), {
        timeout: 500,
      });
      releaseVectorLoad?.(true);
      await expect(Promise.all(calls)).resolves.toHaveLength(8);
    } finally {
      if (releaseVectorLoad) {
        releaseVectorLoad(true);
      } else {
        // Allows the old hold-one/wait-for-one ordering to unwind promptly
        // instead of leaving its pool waiter alive until the 30-second timeout.
        await closeLbug('repo-a');
      }
      await Promise.allSettled(calls);
    }
  });

  it('lets a direct vector query report its own error when preflight rejects', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockRejectedValueOnce(new Error('transient load failure'));
    await initLbugWithDb('repo-a', {} as any, '/tmp/vector-preflight-rejection-db');

    await expect(
      executeParameterized(
        'repo-a',
        "CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'embedding_idx', [0.1], 1)",
        {},
      ),
    ).resolves.toEqual([]);
  });
});
