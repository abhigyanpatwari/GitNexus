export interface ExactEmbeddingRow {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: readonly number[];
}

export interface ExactSearchChunk {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  distance: number;
}

const cosineDistance = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 1;
  return 1 - dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
};

export const rankExactEmbeddingRows = (
  rows: readonly ExactEmbeddingRow[],
  queryEmbedding: readonly number[],
  limit: number,
  maxDistance: number,
): ExactSearchChunk[] =>
  rows
    .map((row) => ({
      nodeId: row.nodeId,
      chunkIndex: row.chunkIndex,
      startLine: row.startLine,
      endLine: row.endLine,
      distance: cosineDistance(row.embedding, queryEmbedding),
    }))
    .filter((row) => row.distance < maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
