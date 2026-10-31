// Scenario-map controls fixture (Phase 1 U17), adversarial pair `unicode-normalize` (design §8):
// the differing value is the receiver of String.prototype.normalize. `e` + U+0301 composes to one
// code unit; `q` + U+0301 has no composed form and stays two. Only the value-flow check separates
// the two tests. Expected: Review (expected.json).
import { describe, expect, it } from 'vitest';
import { composedLength } from './src/unicode-normalize.js';

describe('unicode-normalize', () => {
  it('composes e and a combining acute into one code unit', () => {
    expect(composedLength('Jose\u0301')).toBe(4);
  });

  it('keeps a combining acute that has no composed form', () => {
    expect(composedLength('Josq\u0301')).toBe(5);
  });
});
