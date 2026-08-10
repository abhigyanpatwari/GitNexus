import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory can close over the shared call log.
const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  DEFAULT_FTS_STEMMER: 'porter',
  // Row accessors and the snapshot resolver are PURE — mirror the real
  // implementations rather than stubbing them, or `verifySearchFTSIndexes`
  // and `dropSearchFTSIndexes` read `undefined` out of every catalog row and
  // the suite passes for the wrong reason. (#2841 cleanup moved these reads
  // behind named accessors so the LadybugDB column contract has one home; a
  // whole-module mock has to follow.)
  indexRowTable: (row: Record<string, unknown> | undefined) => row?.table_name ?? row?.[0],
  indexRowName: (row: Record<string, unknown> | undefined) => row?.index_name ?? row?.[1],
  indexRowType: (row: Record<string, unknown> | undefined) => row?.index_type ?? row?.[2],
  readIndexCatalogRows: vi.fn(async () => undefined),
  resolveGateRows: vi.fn(async (rows?: unknown) =>
    rows === undefined ? undefined : (rows as unknown[]),
  ),
  dropFTSIndex: vi.fn(async (table: string, indexName: string) => {
    calls.push(`drop:${table}.${indexName}`);
  }),
  createFTSIndex: vi.fn(
    async (table: string, indexName: string, _props: string[], stemmer: string) => {
      calls.push(`create:${table}.${indexName}:${stemmer}`);
    },
  ),
}));

const {
  buildSearchIndexesOrDegrade,
  createSearchFTSIndexes,
  getSearchFTSStemmer,
  initialiseSearchFTSStemmer,
} = await import('../../src/core/search/fts-indexes.js');
const { FTS_INDEXES } = await import('../../src/core/search/fts-schema.js');
const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');

/** SHOW_INDEXES rows covering every configured FTS index's expected properties. */
const fullCoverageRows = () =>
  FTS_INDEXES.map((i) => ({ index_name: i.indexName, property_names: [...i.properties] }));

afterEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  // `clearAllMocks` does NOT drain the `…Once` queue. A test that queues more
  // rejections than the code under test consumes would otherwise leak the
  // leftovers into whichever test runs next — order-dependent, and exactly the
  // shape of failure a per-index isolation change makes easy to introduce.
  // `mockReset` restores the implementation the `vi.mock` factory passed to
  // `vi.fn(impl)`, so the recording default survives.
  vi.mocked(createFTSIndex).mockReset();
  vi.unstubAllEnvs();
});

describe('createSearchFTSIndexes', () => {
  it('drops each index before (re)creating it, in order, for every entry', async () => {
    await createSearchFTSIndexes();
    const expected = FTS_INDEXES.flatMap((i) => [
      `drop:${i.table}.${i.indexName}`,
      `create:${i.table}.${i.indexName}:porter`,
    ]);
    expect(calls).toEqual(expected);
  });

  it('invokes onIndexStart/onIndexReady once per index', async () => {
    const started: string[] = [];
    const ready: string[] = [];
    await createSearchFTSIndexes({
      onIndexStart: (_t, name) => started.push(name),
      onIndexReady: (_t, name) => ready.push(name),
    });
    const expectedNames = FTS_INDEXES.map((i) => i.indexName);
    expect(started).toEqual(expectedNames);
    expect(ready).toEqual(expectedNames);
  });

  it('passes the configured FTS stemmer to every index', async () => {
    vi.stubEnv('GITNEXUS_FTS_STEMMER', ' none ');

    await createSearchFTSIndexes();

    expect(calls.filter((call) => call.startsWith('create:'))).toEqual(
      FTS_INDEXES.map((i) => `create:${i.table}.${i.indexName}:none`),
    );
  });

  it('rejects unsupported stemmer names before creating indexes', async () => {
    vi.stubEnv('GITNEXUS_FTS_STEMMER', "none'); DROP TABLE File; --");

    await expect(createSearchFTSIndexes()).rejects.toThrow('Invalid GITNEXUS_FTS_STEMMER');
    expect(calls).toEqual([]);
  });

  // #2889 — one untokenizable row used to cost the indexes of its own table AND
  // every table after it in FTS_INDEXES order, because the first rejection left
  // the loop. The `drop` for the failing table has already run by then, so the
  // damage was never confined to "the index we could not rebuild".
  describe('per-index failure isolation (#2889)', () => {
    const POISON = 'Runtime exception: Failed calling LOWER: Invalid UTF-8.';
    const recordCreate = async (
      table: string,
      indexName: string,
      _properties: string[],
      stemmer: string,
    ) => {
      calls.push(`create:${table}.${indexName}:${stemmer}`);
    };

    it('builds every remaining table after one index build rejects', async () => {
      const poisoned = FTS_INDEXES[1];
      vi.mocked(createFTSIndex)
        .mockImplementationOnce(recordCreate)
        .mockRejectedValueOnce(new Error(POISON));

      const failures = await createSearchFTSIndexes();

      expect(failures).toEqual([
        {
          table: poisoned.table,
          indexName: poisoned.indexName,
          error: POISON,
          failureClass: 'capability',
        },
      ]);
      expect(calls.filter((call) => call.startsWith('create:'))).toEqual(
        FTS_INDEXES.filter((i) => i.indexName !== poisoned.indexName).map(
          (i) => `create:${i.table}.${i.indexName}:porter`,
        ),
      );
    });

    it('still drops the failing index, and every other index is left rebuilt', async () => {
      vi.mocked(createFTSIndex)
        .mockImplementationOnce(recordCreate)
        .mockRejectedValueOnce(new Error(POISON));

      await createSearchFTSIndexes();

      expect(calls.filter((call) => call.startsWith('drop:'))).toEqual(
        FTS_INDEXES.map((i) => `drop:${i.table}.${i.indexName}`),
      );
    });

    it('does not report a failed index as ready', async () => {
      const poisoned = FTS_INDEXES[1];
      vi.mocked(createFTSIndex)
        .mockImplementationOnce(recordCreate)
        .mockRejectedValueOnce(new Error(POISON));
      const ready: string[] = [];

      await createSearchFTSIndexes({ onIndexReady: (_t, name) => ready.push(name) });

      expect(ready).toEqual(
        FTS_INDEXES.filter((i) => i.indexName !== poisoned.indexName).map((i) => i.indexName),
      );
    });
  });
});

describe('buildSearchIndexesOrDegrade', () => {
  it('returns ok:true when every index builds and verifies (#2544/#2546)', async () => {
    const executeQuery = vi.fn(async () => fullCoverageRows());

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false instead of throwing when a single index build rejects (#2544/#2546)', async () => {
    vi.mocked(createFTSIndex).mockRejectedValueOnce(
      new Error('Runtime exception: Failed calling LOWER: Invalid UTF-8.'),
    );
    const executeQuery = vi.fn(async () => fullCoverageRows());

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid UTF-8');
  });

  it('names every failing table, not just the first (#2889)', async () => {
    vi.mocked(createFTSIndex)
      .mockRejectedValueOnce(new Error('Runtime exception: Failed calling LOWER: Invalid UTF-8.'))
      .mockRejectedValueOnce(new Error('Runtime exception: Failed calling LOWER: Invalid UTF-8.'));
    const executeQuery = vi.fn(async () => fullCoverageRows());

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(FTS_INDEXES[0].table);
    expect(result.error).toContain(FTS_INDEXES[1].table);
    expect(result.error).toContain(`2 of ${FTS_INDEXES.length} tables`);
  });

  it('escalates the aggregate to integrity when any single failure is integrity (#2889)', async () => {
    // Capability signatures are checked first, so aggregating the raw messages
    // into one string would have let an untokenizable row mask a broken write.
    vi.mocked(createFTSIndex)
      .mockRejectedValueOnce(new Error('Runtime exception: Failed calling LOWER: Invalid UTF-8.'))
      .mockRejectedValueOnce(new Error('IO exception: checkpoint failed'));
    const executeQuery = vi.fn(async () => fullCoverageRows());

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result.failureClass).toBe('integrity');
  });

  it('stays capability when every failure is a row-level tokenizer error (#2889)', async () => {
    vi.mocked(createFTSIndex).mockRejectedValueOnce(
      new Error('Runtime exception: Failed calling LOWER: Invalid UTF-8.'),
    );
    const executeQuery = vi.fn(async () => fullCoverageRows());

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result.failureClass).toBe('capability');
  });

  it('returns ok:false when verification finds a missing index, without throwing', async () => {
    const executeQuery = vi.fn(async () => fullCoverageRows().slice(1));

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing indexes');
  });
});

describe('getSearchFTSStemmer', () => {
  it('defaults to porter when unset', () => {
    expect(getSearchFTSStemmer()).toBe('porter');
  });

  it('normalizes configured stemmer names', () => {
    vi.stubEnv('GITNEXUS_FTS_STEMMER', ' German ');

    expect(getSearchFTSStemmer()).toBe('german');
  });
});

// Caches module state via initialise; keep last so no later test reads it.
describe('initialiseSearchFTSStemmer', () => {
  it('throws on an unsupported stemmer', () => {
    vi.stubEnv('GITNEXUS_FTS_STEMMER', 'porterr');

    expect(() => initialiseSearchFTSStemmer()).toThrow('Invalid GITNEXUS_FTS_STEMMER');
  });

  it('resolves once so later reads ignore a changed env', () => {
    vi.stubEnv('GITNEXUS_FTS_STEMMER', 'german');
    expect(initialiseSearchFTSStemmer()).toBe('german');

    vi.stubEnv('GITNEXUS_FTS_STEMMER', 'french');
    expect(getSearchFTSStemmer()).toBe('german');
  });
});
