import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory can close over the shared call log.
const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  dropFTSIndex: vi.fn(async (table: string, indexName: string) => {
    calls.push(`drop:${table}.${indexName}`);
  }),
  createFTSIndex: vi.fn(async (table: string, indexName: string) => {
    calls.push(`create:${table}.${indexName}`);
  }),
}));

const { createSearchFTSIndexes } = await import('../../src/core/search/fts-indexes.js');
const { FTS_INDEXES } = await import('../../src/core/search/fts-schema.js');

afterEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('createSearchFTSIndexes', () => {
  it('drops each index before (re)creating it, in order, for every entry', async () => {
    await createSearchFTSIndexes();
    const expected = FTS_INDEXES.flatMap((i) => [
      `drop:${i.table}.${i.indexName}`,
      `create:${i.table}.${i.indexName}`,
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
});
