/** Compare pooled embeddings, not just their width: a backend can return the
 * right shape while placing every vector in a different semantic space. */
interface ProbeResult {
  data: ArrayLike<number>;
  dims?: readonly number[];
}

// Allow small fp32 backend differences while rejecting the ~0.37 cosine in #3685.
const MIN_PROBE_COSINE = 0.999;

export const assertEmbeddingDeviceParity = (
  candidate: ProbeResult,
  reference: ProbeResult,
  batchSize: number,
): void => {
  const dimensions = reference.dims?.[1];
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize <= 0 ||
    reference.dims?.length !== 2 ||
    reference.dims[0] !== batchSize ||
    typeof dimensions !== 'number' ||
    !Number.isSafeInteger(dimensions) ||
    dimensions <= 0 ||
    candidate.dims?.length !== 2 ||
    candidate.dims[0] !== batchSize ||
    candidate.dims[1] !== dimensions ||
    reference.data.length !== batchSize * dimensions ||
    candidate.data.length !== reference.data.length
  ) {
    throw new Error('probe embedding shapes do not match');
  }

  for (let row = 0; row < batchSize; row++) {
    let dot = 0;
    let candidateNorm = 0;
    let referenceNorm = 0;
    for (let column = 0; column < dimensions; column++) {
      const index = row * dimensions + column;
      const a = candidate.data[index];
      const b = reference.data[index];
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error('probe embeddings contain non-finite values');
      }
      dot += a * b;
      candidateNorm += a * a;
      referenceNorm += b * b;
    }
    const cosine = dot / Math.sqrt(candidateNorm * referenceNorm);
    if (!Number.isFinite(cosine) || cosine < MIN_PROBE_COSINE) {
      throw new Error(`probe ${row + 1} cosine ${cosine.toFixed(6)} is below ${MIN_PROBE_COSINE}`);
    }
  }
};
