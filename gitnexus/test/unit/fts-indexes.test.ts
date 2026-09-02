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
  missingSearchFTSIndexTables,
} = await import('../../src/core/search/fts-indexes.js');
const { FTS_INDEXES } = await import('../../src/core/search/fts-schema.js');
const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');

/** SHOW_INDEXES rows covering every configured FTS index's expected properties. */
const fullCoverageRows = () =>
  FTS_INDEXES.map((i) => ({ index_name: i.indexName, property_names: [...i.properties] }));

/** The row-level tokenizer error of #2544/#2546/#2889, verbatim. */
const POISON = 'Runtime exception: Failed calling LOWER: Invalid UTF-8.';

afterEach(() => {
  calls.length = 0;
  // `reset`, not `clear`: only reset drains the `…Once` queue, and a test that
  // queues more rejections than the code consumes would otherwise leak the
  // leftovers into whichever test runs next. Vitest 4's reset restores the
  // implementation each `vi.fn(impl)` was created with, so the factory's
  // recording defaults survive.
  vi.resetAllMocks();
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

  it('rebuilds only the requested tables when options.tables is set (#3016)', async () => {
    await createSearchFTSIndexes({ tables: new Set(['File', 'Function']) });
    expect(calls).toEqual([
      'drop:File.file_fts',
      'create:File.file_fts:porter',
      'drop:Function.function_fts',
      'create:Function.function_fts:porter',
    ]);
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
  it('isolates a failing index: others build, all drop, the failed one is not ready (#2889)', async () => {
    vi.mocked(createFTSIndex).mockRejectedValueOnce(new Error(POISON));
    const ready: string[] = [];

    const failures = await createSearchFTSIndexes({ onIndexReady: (_t, name) => ready.push(name) });

    const [poisoned, ...survivors] = FTS_INDEXES;
    expect(failures).toEqual([
      { table: poisoned.table, indexName: poisoned.indexName, error: POISON },
    ]);
    // The drop for the failing table still ran — that is why letting the
    // rejection leave the loop cost the table its index as well as the rebuild.
    expect(calls.filter((call) => call.startsWith('drop:'))).toEqual(
      FTS_INDEXES.map((i) => `drop:${i.table}.${i.indexName}`),
    );
    expect(calls.filter((call) => call.startsWith('create:'))).toEqual(
      survivors.map((i) => `create:${i.table}.${i.indexName}:porter`),
    );
    expect(ready).toEqual(survivors.map((i) => i.indexName));
  });
});

describe('buildSearchIndexesOrDegrade', () => {
  it('returns ok:true when every index builds and verifies (#2544/#2546)', async () => {
    const executeQuery = vi.fn(async () => fullCoverageRows());

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false instead of throwing when a single index build rejects (#2544/#2546)', async () => {
    vi.mocked(createFTSIndex).mockRejectedValueOnce(new Error(POISON));
    const executeQuery = vi.fn(async () => fullCoverageRows());

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid UTF-8');
    // A row-level tokenizer error degrades; it must never escalate to an abort.
    expect(result.failureClass).toBe('capability');
    // #2889: verification still runs on a partial build — the surviving indexes
    // are the whole point of isolating the failure, so they get proven, not
    // assumed. (One SHOW_INDEXES read.)
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  it('names every failing table, not just the first (#2889)', async () => {
    vi.mocked(createFTSIndex)
      .mockRejectedValueOnce(new Error(POISON))
      .mockRejectedValueOnce(new Error(POISON));
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
      .mockRejectedValueOnce(new Error(POISON))
      .mockRejectedValueOnce(new Error('IO exception: checkpoint failed'));
    const executeQuery = vi.fn(async () => fullCoverageRows());

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result.failureClass).toBe('integrity');
  });

  it('returns ok:false when verification finds a missing index, without throwing', async () => {
    const executeQuery = vi.fn(async () => fullCoverageRows().slice(1));

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing indexes');
  });

  it('reports a failed table once, with its reason, not twice (#2889)', async () => {
    // The failing table is missing from the catalog too — verification would
    // name it a second time, with no reason attached, if the report did not
    // subtract what the build already explained.
    vi.mocked(createFTSIndex).mockRejectedValueOnce(new Error(POISON));
    const executeQuery = vi.fn(async () => fullCoverageRows().slice(1));

    const result = await buildSearchIndexesOrDegrade(executeQuery);

    const failed = `${FTS_INDEXES[0].table}.${FTS_INDEXES[0].indexName}`;
    expect(result.error).toContain(`${failed} (${POISON})`);
    expect(result.error).not.toContain('missing indexes');
  });
});

describe('missingSearchFTSIndexTables (#3016)', () => {
  const catalogRow = (i: { table: string; indexName: string }) => ({
    table_name: i.table,
    index_name: i.indexName,
  });

  it('reports nothing missing when the catalog carries every configured index', async () => {
    const missing = await missingSearchFTSIndexTables(FTS_INDEXES.map(catalogRow));
    expect(missing).toEqual(new Set());
  });

  it('names every table when the catalog is empty (a prior escalation dropped them all)', async () => {
    const missing = await missingSearchFTSIndexTables([]);
    expect(missing).toEqual(new Set(FTS_INDEXES.map((i) => i.table)));
  });

  it('names only the tables whose index is absent', async () => {
    const rows = FTS_INDEXES.filter((i) => i.table !== 'Function').map(catalogRow);
    expect(await missingSearchFTSIndexTables(rows)).toEqual(new Set(['Function']));
  });

  it('answers undefined when the catalog could not be read, so callers do not narrow', async () => {
    expect(await missingSearchFTSIndexTables(undefined)).toBeUndefined();
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
