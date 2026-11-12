/**
 * A verdict answered from a matcher's memo costs one visit of the work budget, so that asking
 * many matchers about the same names over and over is bounded by the budget like every other cost.
 * Asserted on the budget's own counter, never on elapsed time.
 */
import { describe, it, expect } from 'vitest';
import {
  compileLinearRegex,
  SharedWorkBudget,
  type LinearRegex,
} from '../../src/core/ingestion/languages/r/linear-regex.js';
import { rExportPatternMatches } from '../../src/core/ingestion/languages/r/package-config.js';

describe('a verdict answered from the memo is charged as one visit', () => {
  it('adds one unit of work per repeated lookup and keeps the verdict', () => {
    const budget = new SharedWorkBudget();
    const matcher = compileLinearRegex('^get_', budget) as LinearRegex;
    expect(matcher.test('get_x')).toBe(true);
    expect(matcher.test('other')).toBe(false);
    const before = budget.spent;

    for (let i = 0; i < 100; i++) {
      expect(matcher.test('get_x')).toBe(true);
      expect(matcher.test('other')).toBe(false);
    }
    expect(budget.spent - before).toBe(200);
    expect(matcher.work).toBe(budget.spent);
  });

  it('bounds matchers x repeated names by the budget instead of letting them run free', () => {
    const budget = new SharedWorkBudget(10_000);
    const info = {
      exportPatterns: Array.from(
        { length: 50 },
        (_, i) => compileLinearRegex(`^zz${i}_`, budget) as LinearRegex,
      ),
      exportPatternBudget: budget,
    };
    let answered = 0;
    for (let i = 0; i < 1_000 && !budget.isSpent; i++) {
      expect(rExportPatternMatches(info, 'initialize')).toBe(false);
      answered++;
    }
    // 50 matchers x one visit per repeat: spent after ~200 calls, not 1,000 uncounted ones.
    expect(budget.isSpent).toBe(true);
    expect(answered).toBeLessThan(1_000);
    // Once spent, the matchers are not consulted at all and the verdict is false.
    expect(rExportPatternMatches(info, 'initialize')).toBe(false);
    expect(budget.cutShort).toBe(true);
  });
});
