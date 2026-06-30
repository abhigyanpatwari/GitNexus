import { logger } from '../logger.js';

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

/**
 * Cosine distance over normalized embeddings is bounded to [0, 2], so any threshold
 * above this accepts every row and silently disables the relevance filter. Values
 * over the ceiling are clamped to it rather than passed through.
 */
export const VECTOR_MAX_DISTANCE_CEILING = 2;

const warned = new Set<string>();

const warnOnce = (key: string, message: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
};

/**
 * Resolve the effective max accepted vector/semantic cosine distance.
 * Reads `GITNEXUS_VECTOR_MAX_DISTANCE`. Unset/empty/whitespace → silent fallback.
 * Invalid (non-numeric, <= 0, non-finite) → fallback plus a one-time warning.
 * Values above the cosine ceiling (2) are clamped to it with a one-time warning.
 */
export const getVectorMaxDistance = (fallback: number = DEFAULT_VECTOR_MAX_DISTANCE): number => {
  const raw = process.env.GITNEXUS_VECTOR_MAX_DISTANCE;
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warnOnce(
      `invalid:${raw}`,
      `  GITNEXUS_VECTOR_MAX_DISTANCE must be a positive number in (0, ${VECTOR_MAX_DISTANCE_CEILING}], got "${raw}" — using default ${fallback}`,
    );
    return fallback;
  }
  if (parsed > VECTOR_MAX_DISTANCE_CEILING) {
    warnOnce(
      `clamp:${raw}`,
      `  GITNEXUS_VECTOR_MAX_DISTANCE=${parsed} exceeds the cosine-distance ceiling (${VECTOR_MAX_DISTANCE_CEILING}) — clamping`,
    );
    return VECTOR_MAX_DISTANCE_CEILING;
  }
  return parsed;
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
