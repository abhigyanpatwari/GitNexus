// Scenario-map controls fixture (Phase 1 U17), adversarial pair `locale-compare` (design §8): the
// same receiver compared with two different arguments (argument position). Both orders hold in
// every Latin collation, and both fail under code-unit order. Only the value-flow check separates
// the two tests. Expected: Review (expected.json).
import { describe, expect, it } from 'vitest';
import { compareLabels } from './src/locale-compare.js';

describe('locale-compare', () => {
  it('orders apple before Banana', () => {
    expect(compareLabels('apple', 'Banana')).toBe(-1);
  });

  it('orders apple before Damson', () => {
    expect(compareLabels('apple', 'Damson')).toBe(-1);
  });
});
