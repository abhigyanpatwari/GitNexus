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

export const DEFAULT_VECTOR_MAX_DISTANCE = 0.5;
export const DEFAULT_MCP_VECTOR_MAX_DISTANCE = 0.6;

export const getVectorMaxDistance = (fallback: number = DEFAULT_VECTOR_MAX_DISTANCE): number => {
  const raw = process.env.GITNEXUS_VECTOR_MAX_DISTANCE;
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

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
