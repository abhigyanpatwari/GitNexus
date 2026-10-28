// Scenario-map controls fixture (Phase 1 U17), adversarial pair `parse-int-radix` (design §8): the
// same text read in radix 8 and radix 16. Only the value-flow check separates the two tests.
// Expected: Review (expected.json).
import { describe, expect, it } from 'vitest';
import { readCode } from './src/parse-int-radix.js';

describe('parse-int-radix', () => {
  it('reads 17 as an octal code', () => {
    expect(readCode('17', 8)).toBe(15);
  });

  it('reads 17 as a hexadecimal code', () => {
    expect(readCode('17', 16)).toBe(23);
  });
});
