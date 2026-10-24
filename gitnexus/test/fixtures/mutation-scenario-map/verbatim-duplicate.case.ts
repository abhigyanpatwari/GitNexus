// Scenario-map controls fixture (Phase 1 U17), positive control `verbatim-duplicate`: two
// byte-identical test bodies with different titles. Expected: Repeat, strong evidence
// (expected.json).
import { describe, expect, it } from 'vitest';
import { clampPercent } from './src/verbatim-duplicate.js';

describe('verbatim-duplicate', () => {
  it('clamps a percentage above 100', () => {
    expect(clampPercent(150)).toBe(100);
  });

  it('caps an oversized percentage', () => {
    expect(clampPercent(150)).toBe(100);
  });
});
