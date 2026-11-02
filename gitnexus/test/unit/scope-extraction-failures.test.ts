import { describe, expect, it } from 'vitest';
import {
  reconcileScopeExtractionFailures,
  scopeExtractionFailureTotal,
  summarizeScopeExtractionFailures,
} from '../../src/core/ingestion/scope-resolution/scope-extraction-failures.js';

describe('summarizeScopeExtractionFailures', () => {
  it('deduplicates, sorts, and caps paths while retaining the exact total', () => {
    expect(summarizeScopeExtractionFailures(['z.ts', 'a.ts', 'z.ts', 'b.ts'], 2)).toEqual({
      total: 3,
      paths: ['a.ts', 'b.ts'],
      truncated: true,
    });
  });

  it('returns undefined when no failure was recorded', () => {
    expect(summarizeScopeExtractionFailures([])).toBeUndefined();
    expect(summarizeScopeExtractionFailures()).toBeUndefined();
  });

  it('ignores malformed paths restored from a corrupt cache payload', () => {
    expect(
      summarizeScopeExtractionFailures(['valid.ts', null, undefined, 42] as unknown as string[]),
    ).toEqual({ total: 1, paths: ['valid.ts'] });
  });

  it('clears worker failures recovered by fallback and retains final omissions', () => {
    const failures = new Set(['recovered.ts', 'still-broken.ts', 'untouched.ts']);

    reconcileScopeExtractionFailures(
      failures,
      ['recovered.ts', 'still-broken.ts', 'new-failure.ts'],
      ['still-broken.ts', 'new-failure.ts'],
    );

    expect([...failures].sort()).toEqual(['new-failure.ts', 'still-broken.ts', 'untouched.ts']);
  });
});

describe('scopeExtractionFailureTotal', () => {
  it.each([
    ['absent summary', undefined, 0],
    ['clean summary', { total: 0, paths: [] }, 0],
    ['failure summary', { total: 2, paths: ['a.ts', 'b.ts'] }, 2],
    ['non-object', 'invalid', undefined],
    ['null', null, undefined],
    ['fractional count', { total: 1.5 }, undefined],
    ['negative count', { total: -1 }, undefined],
    ['missing count', {}, undefined],
  ])('reads %s consistently', (_name, summary, expected) => {
    expect(scopeExtractionFailureTotal(summary)).toBe(expected);
  });
});
