import { describe, expect, it } from 'vitest';

const { compare, summarize } = await import(
  new URL('../../bench/mcp-query/statistics.mjs', import.meta.url).href
);
const samples = (ratio: number, baseline = 100) =>
  Array.from({ length: 8 }, (_, session) => ({ session, baseline, candidate: baseline * ratio }));

describe('MCP performance regression decision', () => {
  it('detects a consistent material slowdown', () => {
    expect(compare(samples(1.2)).verdict).toBe('regression');
  });

  it('accepts faster requests and negligible absolute overhead', () => {
    expect(compare(samples(0.8)).verdict).toBe('within-threshold');
    expect(compare(samples(2, 1)).verdict).toBe('within-threshold');
  });

  it('does not call process variation a proven improvement or regression', () => {
    const rows = samples(1).map((row, i) => ({ ...row, candidate: i % 2 ? 150 : 70 }));
    expect(compare(rows).verdict).toBe('inconclusive');
  });

  it('does not gain confidence by repeating correlated requests in one process', () => {
    const rows = samples(1).map((row, i) => ({ ...row, candidate: i % 2 ? 150 : 70 }));
    const repeated = rows.flatMap((row) => Array.from({ length: 5 }, () => ({ ...row })));
    const original = compare(rows).ratioCi95;
    compare(repeated).ratioCi95.forEach((value: number, i: number) =>
      expect(value).toBeCloseTo(original[i], 12),
    );
    expect(compare(samples(2).map((row) => ({ ...row, session: 0 }))).verdict).toBe(
      'insufficient-sessions',
    );
  });

  it.each([0, -1, NaN, Infinity, undefined])('rejects invalid measurements (%s)', (value) => {
    expect(() => compare([{ session: 0, baseline: 100, candidate: value }])).toThrow();
  });

  it('rejects empty, incomplete, duplicate, and missing workload evidence', () => {
    expect(() => compare([])).toThrow();
    expect(() => summarize([], 8, 5, ['query'])).toThrow('Incomplete');
    const record = {
      session: 0,
      round: 0,
      baseline: { query: { ms: 100 } },
      candidate: { query: { ms: 110 } },
    };
    expect(() => summarize([record, record], 1, 2, ['query'])).toThrow('Duplicate');
    expect(() => summarize([record], 1, 1, ['context'])).toThrow('Missing');
    expect(() => summarize([record], 1, 1, [])).toThrow('workload');
    expect(() => summarize([{ ...record, round: 0.5 }], 1, 1, ['query'])).toThrow('identity');
  });
});
