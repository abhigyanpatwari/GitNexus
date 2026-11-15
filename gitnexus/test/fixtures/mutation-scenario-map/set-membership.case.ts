// Scenario-map controls fixture (Phase 1 U17), positive control `set-membership` (design §8): two
// members of one supported Set table, one test each, with identical kill sets. Expected: Row, the
// verdict the design implies (expected.json explains why it is not a repeat).
import { describe, expect, it } from 'vitest';
import { isSuccessStatus } from './src/set-membership.js';

describe('set-membership', () => {
  it('accepts 200 as a success status', () => {
    expect(isSuccessStatus(200)).toBe(true);
  });

  it('accepts 204 as a success status', () => {
    expect(isSuccessStatus(204)).toBe(true);
  });
});
