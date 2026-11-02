// Scenario-map controls fixture (Phase 1 U17), adversarial pair `date-boundary` (design §8): the
// end of February in a leap year and in a common year. The leap-year rule lives inside Date. Only
// the value-flow check separates the two tests. Expected: Review (expected.json).
import { describe, expect, it } from 'vitest';
import { daysInMonth } from './src/date-boundary.js';

describe('date-boundary', () => {
  it('counts the days of February in a leap year', () => {
    expect(daysInMonth(2024, 1)).toBe(29);
  });

  it('counts the days of February in a common year', () => {
    expect(daysInMonth(2023, 1)).toBe(28);
  });
});
