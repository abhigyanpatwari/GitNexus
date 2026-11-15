// Scenario-map controls fixture (Phase 1 U17), adversarial pair `math-round` (design §5.3a, §8):
// 2.4 rounds down and 2.5 rounds up inside Math.round. Path, checks, context, facet and kills
// match; only the value-flow check separates the two tests. Expected: Review (expected.json).
import { describe, expect, it } from 'vitest';
import { roundScore } from './src/math-round.js';

describe('math-round', () => {
  it('rounds 2.4 down to 2', () => {
    expect(roundScore(2.4)).toBe(2);
  });

  it('rounds 2.5 up to 3', () => {
    expect(roundScore(2.5)).toBe(3);
  });
});
