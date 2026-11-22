/**
 * `exportPattern("(" + 16374 x "|" + "){16384}")` fits the 16 KB pattern cap, builds almost no
 * states and only a few thousand `build` calls, but each of the 16,384 copies of the group
 * body re-scanned its 16,375 alternatives for a literal-only alternation. That scan sat
 * outside every budget: one such NAMESPACE took 10.9 s to analyse against 3.0 s for a plain
 * one. Asserted on the build-step counter (what the budget is charged), never on elapsed time.
 */
import { describe, it, expect } from 'vitest';
import {
  compileLinearRegexDetailed,
  MAX_PATTERN_LENGTH,
  SharedWorkBudget,
} from '../../src/core/ingestion/languages/r/linear-regex.js';

const reasonOf = (r: ReturnType<typeof compileLinearRegexDetailed>): string =>
  'reason' in r ? r.reason : '';

/** 16,375 empty alternatives, repeated 16,384 times: 16,383 characters of pattern text. */
const crafted = `(${'|'.repeat(16374)}){16384}`;

describe('alternation compile work counts as build steps', () => {
  it('fits the pattern length cap', () => {
    expect(crafted.length).toBeLessThanOrEqual(MAX_PATTERN_LENGTH);
  });

  it('refuses the crafted pattern for the work cap instead of compiling it for free', () => {
    const budget = new SharedWorkBudget();
    const result = compileLinearRegexDetailed(crafted, budget);
    expect(reasonOf(result)).toContain('work cap');
    // The refusal is charged: the build-step counter passed the build-step cap
    // (4 x MAX_STATES = 65,536 steps) before it stopped.
    expect(budget.spent).toBeGreaterThan(65_536);
  });

  it('counts a smaller literal alternation once per build, not for free', () => {
    // 100 alternatives repeated 1,000 times is 100,000 alternative scans, past the step cap.
    const pattern = `(${'|'.repeat(99)}){1000}`;
    const result = compileLinearRegexDetailed(pattern, new SharedWorkBudget());
    expect(reasonOf(result)).toContain('work cap');
  });

  it('still compiles an ordinary alternation', () => {
    const budget = new SharedWorkBudget();
    const result = compileLinearRegexDetailed('^(foo|bar|baz)_[a-z]+$', budget);
    expect(reasonOf(result)).toBe('');
  });
});
