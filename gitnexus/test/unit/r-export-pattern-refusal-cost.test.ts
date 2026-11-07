/**
 * A pattern refused after its NFA was (partly) built used to cost real time that no budget
 * counted: 98 KB of `exportPattern("(a|b){8000}x1")` lines took 4.2 s to refuse. Asserted on the
 * budget's own counter, never on elapsed time.
 */
import { describe, it, expect } from 'vitest';
import {
  compileLinearRegex,
  compileLinearRegexDetailed,
  MAX_SHARED_WORK,
  MAX_STATES,
  SharedWorkBudget,
} from '../../src/core/ingestion/languages/r/linear-regex.js';
import { compileRExportPatternDetailed } from '../../src/core/ingestion/languages/r/export-pattern.js';

/** A pattern that expands past the state cap; `i` makes each one distinct. */
const overCap = (i: number): string => `(a|b){8000}x${i}`;

const reasonOf = (r: ReturnType<typeof compileLinearRegexDetailed>): string =>
  'reason' in r ? r.reason : '';

describe('a pattern refused for expanding past the state cap is charged for its build', () => {
  it('charges the states it built before it was refused', () => {
    const budget = new SharedWorkBudget();
    const refused = compileLinearRegexDetailed(overCap(0), budget);
    expect(reasonOf(refused)).toContain('state cap');
    // The build stops at the cap: MAX_STATES states, 8 visits of work each, plus its steps.
    expect(budget.spent).toBeGreaterThanOrEqual(MAX_STATES * 8);
    // Nothing is kept, so the state allowance is untouched.
    expect(budget.states).toBe(0);
  });

  it('charges a refusal for the work cap, which builds no states at all', () => {
    const budget = new SharedWorkBudget();
    const refused = compileLinearRegexDetailed('((){300}){300}', budget);
    expect(reasonOf(refused)).toContain('work cap');
    expect(budget.spent).toBeGreaterThan(0);
    expect(budget.states).toBe(0);
  });

  it('charges nothing for a pattern refused before any state was built', () => {
    const budget = new SharedWorkBudget();
    expect(reasonOf(compileLinearRegexDetailed('(a', budget))).not.toBe('');
    expect(budget.spent).toBe(0);
  });

  it('stops parsing refused patterns once they have spent the budget, after a bounded number', () => {
    const load = new SharedWorkBudget();
    const pkg = load.child();
    let built = 0;
    let unparsed = 0;
    for (let i = 0; i < 5_000; i++) {
      const reason = reasonOf(compileLinearRegexDetailed(overCap(i), pkg));
      if (reason.includes('state cap')) built++;
      else if (reason.includes('work budget')) unparsed++;
    }
    // MAX_PACKAGE_WORK / (MAX_STATES * 8 + the steps taken) patterns spend the package's share
    // of the work; before the fix every one of the 5,000 was built and none was charged.
    expect(built).toBeGreaterThan(0);
    expect(built).toBeLessThan(300);
    expect(built + unparsed).toBe(5_000);
    expect(pkg.isSpent).toBe(true);
    expect(pkg.spent).toBeLessThanOrEqual(30_000_000 + MAX_STATES * 8 * 2);
    expect(load.spent).toBe(pkg.spent);
    expect(load.spent).toBeLessThan(MAX_SHARED_WORK);
  });

  it('refuses through the exportPattern entry point the same way', () => {
    const pkg = new SharedWorkBudget().child();
    let built = 0;
    for (let i = 0; i < 1_000; i++) {
      const r = compileRExportPatternDetailed(overCap(i), pkg);
      if ('reason' in r && r.reason.includes('state cap')) built++;
    }
    expect(built).toBeLessThan(300);
    expect(pkg.isSpent).toBe(true);
  });

  it('still compiles ordinary patterns after a few refusals', () => {
    const pkg = new SharedWorkBudget().child();
    for (let i = 0; i < 5; i++) compileLinearRegexDetailed(overCap(i), pkg);
    expect(pkg.isSpent).toBe(false);
    expect(compileLinearRegex('^get_', pkg)).not.toBeNull();
  });
});
