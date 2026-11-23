import { describe, expect, it, vi } from 'vitest';
import { readEmptyFtsTables } from '../../src/core/search/fts-table-state.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';

const indexes = FTS_INDEXES.filter((index) => ['Function', 'Class'].includes(index.table));
const emptyClass = { tableName: 'Class', rowCount: 0 };
const populatedFunction = { tableName: 'Function', rowCount: 12 };

describe('readEmptyFtsTables', () => {
  it('proves emptiness with one query, independent of result order and numeric representation', async () => {
    const query = vi.fn().mockResolvedValue([emptyClass, { ...populatedFunction, rowCount: 12n }]);
    expect(await readEmptyFtsTables(query, indexes)).toEqual(new Set(['Class']));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(' UNION ALL ');
  });

  it.each([
    ['missing row', [emptyClass]],
    ['duplicate row', [emptyClass, emptyClass]],
    ['unexpected table', [emptyClass, { tableName: 'File', rowCount: 0 }]],
    ['string count', [emptyClass, { ...populatedFunction, rowCount: '0' }]],
    ['negative count', [emptyClass, { ...populatedFunction, rowCount: -1 }]],
    ['fractional count', [emptyClass, { ...populatedFunction, rowCount: 0.5 }]],
    ['missing count', [emptyClass, { tableName: 'Function' }]],
    ['null row', [emptyClass, null]],
  ])('does not skip any table with %s evidence', async (_label, rows) => {
    expect(await readEmptyFtsTables(vi.fn().mockResolvedValue(rows), indexes)).toEqual(new Set());
  });

  it('does not convert a failed native read into proof of emptiness', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connection failed'));
    expect(await readEmptyFtsTables(query, indexes)).toEqual(new Set());
  });

  it('reads again after a previously empty table gains rows', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([emptyClass, populatedFunction])
      .mockResolvedValueOnce([{ ...emptyClass, rowCount: 1 }, populatedFunction]);
    expect(await readEmptyFtsTables(query, indexes)).toEqual(new Set(['Class']));
    expect(await readEmptyFtsTables(query, indexes)).toEqual(new Set());
  });

  it('never interpolates an unsupported table identifier', async () => {
    const query = vi.fn();
    expect(
      await readEmptyFtsTables(query, [{ ...indexes[0], table: 'Class` MATCH (n) DELETE n //' }]),
    ).toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });
});
