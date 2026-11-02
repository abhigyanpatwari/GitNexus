// Scenario-map controls fixture (Phase 1 U17), adversarial pair `derived-to-fixed` (design §5.3a,
// §8): 2.4 and 2.5 are scaled to 24 and 25 by repo arithmetic before they reach toFixed. Only the
// value-flow check separates the two tests. Expected: Review (expected.json).
import { describe, expect, it } from 'vitest';
import { formatRating } from './src/derived-to-fixed.js';

describe('derived-to-fixed', () => {
  it('formats a 2.4-star rating', () => {
    expect(formatRating(2.4)).toBe('24.0');
  });

  it('formats a 2.5-star rating', () => {
    expect(formatRating(2.5)).toBe('25.0');
  });
});
