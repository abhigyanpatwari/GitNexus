// Scenario-map controls fixture (Phase 1 U17), positive control `repo-arithmetic` (design §8):
// add(2, 3) against add(5, 5) on repo-only arithmetic. Expected: Repeat, strong evidence
// (expected.json).
import { describe, expect, it } from 'vitest';
import { add } from './src/repo-arithmetic.js';

describe('repo-arithmetic', () => {
  it('adds 2 and 3', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('adds 5 and 5', () => {
    expect(add(5, 5)).toBe(10);
  });
});
