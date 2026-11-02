// Scenario-map controls fixture (Phase 1 U17), adversarial pair `regex-alternatives` (design §8):
// two inputs that match different alternatives of one regex. Only the value-flow check separates
// the two tests. Expected: Review (expected.json).
import { describe, expect, it } from 'vitest';
import { isAccessorName } from './src/regex-alternatives.js';

describe('regex-alternatives', () => {
  it('recognises a getter name', () => {
    expect(isAccessorName('getName')).toBe(true);
  });

  it('recognises a setter name', () => {
    expect(isAccessorName('setName')).toBe(true);
  });
});
