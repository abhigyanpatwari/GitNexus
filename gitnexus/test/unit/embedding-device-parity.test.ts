import { describe, expect, it } from 'vitest';
import { assertEmbeddingDeviceParity } from '../../src/core/embeddings/embedding-device-parity.js';

const probe = (data = [1, 0, 0, 1], dims: number[] = [2, 2]) => ({ data, dims });

describe('embedding device parity', () => {
  it('accepts matching directions with small fp32 differences', () => {
    expect(() =>
      assertEmbeddingDeviceParity(probe([1, 0.001, 0.001, 1]), probe(), 2),
    ).not.toThrow();
  });

  it('uses the device-specific tolerance for small differences', () => {
    const slightlyDifferent = probe([1, 0.1, 0.1, 1]);
    expect(() => assertEmbeddingDeviceParity(slightlyDifferent, probe(), 2, 'cuda')).not.toThrow();
    expect(() => assertEmbeddingDeviceParity(slightlyDifferent, probe(), 2, 'dml')).toThrow(
      'cosine',
    );
  });

  it('compares each row, rather than hiding one bad vector in a batch average', () => {
    expect(() => assertEmbeddingDeviceParity(probe([1, 0, 1, 0]), probe(), 2)).toThrow(
      'probe 2 cosine',
    );
  });

  it('rejects opposite directions even though they have the same norm and shape', () => {
    expect(() => assertEmbeddingDeviceParity(probe([-1, 0, 0, -1]), probe(), 2)).toThrow('cosine');
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects non-finite values (%s) on either backend',
    (value) => {
      const invalid = probe([value, 0, 0, 1]);
      expect(() => assertEmbeddingDeviceParity(invalid, probe(), 2)).toThrow('non-finite');
      expect(() => assertEmbeddingDeviceParity(probe(), invalid, 2)).toThrow('non-finite');
    },
  );

  it('rejects zero vectors', () => {
    expect(() => assertEmbeddingDeviceParity(probe([0, 0, 0, 1]), probe(), 2)).toThrow('cosine');
  });

  it.each([
    probe([1, 0], [1, 2]),
    probe([1, 0, 0, 1], [2, 1, 2]),
    probe([1, 0, 0, 1], [2, 3]),
    probe([1, 0, 0]),
    { data: [1, 0, 0, 1] },
  ])('rejects malformed tensor shapes', (invalid) => {
    expect(() => assertEmbeddingDeviceParity(invalid, probe(), 2)).toThrow('shapes');
    expect(() => assertEmbeddingDeviceParity(probe(), invalid, 2)).toThrow('shapes');
  });
});
