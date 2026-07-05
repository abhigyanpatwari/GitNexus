import { describe, expect, it } from 'vitest';

import { EMBEDDING_DIMS_ERROR, normalizeEmbeddingDims } from '../../src/cli/embedding-dims.js';

describe('normalizeEmbeddingDims', () => {
  it.each([
    ['4096', '4096'],
    ['384', '384'],
    ['1', '1'],
    ['007', '7'], // canonicalized
    ['  4096  ', '4096'], // trim-then-validate
  ])('accepts %j and canonicalizes to %j', (input, expected) => {
    expect(normalizeEmbeddingDims(input)).toBe(expected);
  });

  it.each(['abc', '0', '00', '-5', '', '   ', '0x10', '3.5', '+5', '4096x', 'Infinity'])(
    'rejects %j (returns null)',
    (input) => {
      expect(normalizeEmbeddingDims(input)).toBeNull();
    },
  );

  // Regression for tri-review finding #1 (B): "1e3" must NOT be accepted.
  // parseInt("1e3",10) === 1 froze the vector column at FLOAT[1] while
  // Number("1e3") === 1000 passed the old validator and requested 1000-dim
  // vectors — a silent dimension mismatch. The strict /^\d+$/ rule rejects it.
  it('rejects scientific notation 1e3 (no silent FLOAT[1]-vs-1000 mismatch)', () => {
    expect(normalizeEmbeddingDims('1e3')).toBeNull();
  });

  it('exposes a positive-integer error message naming the flag', () => {
    expect(EMBEDDING_DIMS_ERROR).toContain('--embedding-dims');
  });
});
