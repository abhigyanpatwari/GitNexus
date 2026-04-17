/**
 * Embedding Pipeline Types
 *
 * Type definitions for the embedding generation and semantic search system.
 */

/**
 * Node labels that need chunking (have code body, potentially long)
 */
export const CHUNKABLE_LABELS = [
  'Function',
  'Method',
  'Constructor',
  'Class',
  'Interface',
  'Struct',
  'Enum',
  'Trait',
  'Impl',
  'Macro',
  'Namespace',
] as const;

/**
 * Node labels that are short (no chunking needed, embed directly)
 */
export const SHORT_LABELS = [
  'TypeAlias',
  'Typedef',
  'Const',
  'Property',
  'Record',
  'Union',
  'Static',
  'Variable',
] as const;

/**
 * All embeddable labels (union of CHUNKABLE + SHORT)
 */
export const EMBEDDABLE_LABELS = [...CHUNKABLE_LABELS, ...SHORT_LABELS] as const;

export type EmbeddableLabel = (typeof EMBEDDABLE_LABELS)[number];

/**
 * Check if a label should be embedded
 */
export const isEmbeddableLabel = (label: string): label is EmbeddableLabel =>
  EMBEDDABLE_LABELS.includes(label as EmbeddableLabel);

/**
 * Check if a label needs chunking
 */
export const isChunkableLabel = (label: string): boolean =>
  (CHUNKABLE_LABELS as readonly string[]).includes(label);

/**
 * Check if a label is a short type (no chunking)
 */
export const isShortLabel = (label: string): boolean =>
  (SHORT_LABELS as readonly string[]).includes(label);

/**
 * Node labels that have structural names (methods/fields) extractable via AST
 */
export const STRUCTURAL_LABELS: ReadonlySet<string> = new Set([
  'Class',
  'Struct',
  'Interface',
  'Enum',
]);

/**
 * Node labels that have isExported column in their schema
 */
export const LABELS_WITH_EXPORTED = new Set([
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
]) as ReadonlySet<string>;

/**
 * Embedding pipeline phases
 */
export type EmbeddingPhase =
  | 'idle'
  | 'loading-model'
  | 'embedding'
  | 'indexing'
  | 'ready'
  | 'error';

/**
 * Progress information for the embedding pipeline
 */
export interface EmbeddingProgress {
  phase: EmbeddingPhase;
  percent: number;
  modelDownloadPercent?: number;
  nodesProcessed?: number;
  totalNodes?: number;
  currentBatch?: number;
  totalBatches?: number;
  error?: string;
}

/**
 * Configuration for the embedding pipeline
 */
export interface EmbeddingConfig {
  /** Model identifier for transformers.js (local) or the HTTP endpoint model name */
  modelId: string;
  /** Number of nodes to embed in each batch */
  batchSize: number;
  /** Embedding vector dimensions */
  dimensions: number;
  /** Device to use for inference: 'auto' tries GPU first (DirectML on Windows, CUDA on Linux), falls back to CPU */
  device: 'auto' | 'dml' | 'cuda' | 'cpu' | 'wasm';
  /** Maximum characters of code snippet to include */
  maxSnippetLength: number;
  /** Maximum code chunk size in characters (for chunking long code) */
  chunkSize: number;
  /** Overlap between chunks in characters */
  overlap: number;
  /** Maximum description length in characters */
  maxDescriptionLength: number;
}

/**
 * Default embedding configuration
 * Uses snowflake-arctic-embed-xs for browser efficiency
 * Tries WebGPU first (fast), user can choose WASM fallback if unavailable
 */
export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  modelId: 'Snowflake/snowflake-arctic-embed-xs',
  batchSize: 16,
  dimensions: 384,
  device: 'auto',
  maxSnippetLength: 500,
  chunkSize: 1200,
  overlap: 120,
  maxDescriptionLength: 150,
};

/**
 * Result from semantic search
 */
export interface SemanticSearchResult {
  nodeId: string;
  name: string;
  label: string;
  filePath: string;
  distance: number;
  startLine?: number;
  endLine?: number;
}

/**
 * Node data for embedding (minimal structure from LadybugDB query)
 */
export interface EmbeddableNode {
  id: string;
  name: string;
  label: string;
  filePath: string;
  content: string;
  startLine?: number;
  endLine?: number;
  isExported?: boolean;
  description?: string;
  parameterCount?: number;
  returnType?: string;
  repoName?: string;
  serverName?: string;
  methodNames?: string[];
  fieldNames?: string[];
}

/**
 * Cached embedding entry restored from LadybugDB before a graph rebuild
 */
export interface CachedEmbedding {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: number[];
  contentHash?: string;
}

/**
 * Context info for embedding pipeline (repo/server metadata enrichment)
 */
export interface EmbeddingContext {
  repoName?: string;
  serverName?: string;
}

/**
 * Model download progress from transformers.js
 */
export interface ModelProgress {
  status: 'initiate' | 'download' | 'progress' | 'done' | 'ready';
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface ChunkSearchRow {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  distance: number;
}

export interface BestChunkMatch {
  chunkIndex: number;
  startLine: number;
  endLine: number;
  distance: number;
}

/**
 * Deduplicate vector search chunk results by nodeId,
 * keeping the chunk with smallest distance for each node.
 */
export const dedupBestChunks = (
  rows: ChunkSearchRow[],
  limit?: number,
): Map<string, BestChunkMatch> => {
  const best = new Map<string, BestChunkMatch>();
  for (const row of rows) {
    const existing = best.get(row.nodeId);
    if (!existing || row.distance < existing.distance) {
      best.set(row.nodeId, {
        chunkIndex: row.chunkIndex,
        startLine: row.startLine,
        endLine: row.endLine,
        distance: row.distance,
      });
    }
    if (limit !== undefined && best.size >= limit) break;
  }
  return best;
};

const DEFAULT_FETCH_MULTIPLIER = 4;
const DEFAULT_FETCH_BUFFER = 8;
const DEFAULT_MAX_FETCH = 200;

/**
 * Fetch vector-search chunks until we have enough unique nodeIds
 * or can tell the result set is exhausted.
 */
export const collectBestChunks = async (
  limit: number,
  fetchRows: (fetchLimit: number) => Promise<ChunkSearchRow[]>,
  maxFetch: number = DEFAULT_MAX_FETCH,
): Promise<Map<string, BestChunkMatch>> => {
  if (limit <= 0) return new Map();

  let fetchLimit = Math.max(limit * DEFAULT_FETCH_MULTIPLIER, limit + DEFAULT_FETCH_BUFFER);
  let previousFetchLimit = 0;

  while (fetchLimit > previousFetchLimit) {
    const rows = await fetchRows(fetchLimit);
    const bestChunks = dedupBestChunks(rows, limit);

    if (bestChunks.size >= limit || rows.length < fetchLimit) {
      return bestChunks;
    }

    previousFetchLimit = fetchLimit;
    fetchLimit = fetchLimit >= maxFetch ? fetchLimit * 2 : Math.min(maxFetch, fetchLimit * 2);
  }

  return new Map();
};
