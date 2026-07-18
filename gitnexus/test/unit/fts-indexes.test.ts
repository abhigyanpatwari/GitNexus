import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory can close over the shared call log.
const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  DEFAULT_FTS_STEMMER: 'porter',
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
