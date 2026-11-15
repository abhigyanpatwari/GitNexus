// Scenario-map controls fixture (Phase 1 U17), adversarial pair `numeric-boundary` (design §8,
// KTD6): 101 is PAGE_LIMIT + 1, 150 is an interior value. PAGE_LIMIT lives in a constants-only
// module two imports away. Only the facet's ±1 rule separates the two tests. Expected: Review
// (expected.json).
import { describe, expect, it } from 'vitest';
import { clampPageSize } from './src/page-size.js';

describe('numeric-boundary', () => {
  it('cuts a page size one above the limit', () => {
    expect(clampPageSize(101)).toBe(100);
  });

  it('cuts a page size far above the limit', () => {
    expect(clampPageSize(150)).toBe(100);
  });
});
