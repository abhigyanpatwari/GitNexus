/**
 * Embedding Pipeline Types
 *
 * Type definitions for the embedding generation and semantic search system.
 */

export const LABEL_FUNCTION = 'Function' as const;
export const LABEL_METHOD = 'Method' as const;
export const LABEL_CONSTRUCTOR = 'Constructor' as const;
export const LABEL_CLASS = 'Class' as const;
export const LABEL_INTERFACE = 'Interface' as const;
export const LABEL_STRUCT = 'Struct' as const;
export const LABEL_ENUM = 'Enum' as const;
export const LABEL_TRAIT = 'Trait' as const;
export const LABEL_IMPL = 'Impl' as const;
export const LABEL_MACRO = 'Macro' as const;
export const LABEL_NAMESPACE = 'Namespace' as const;
export const LABEL_TYPE_ALIAS = 'TypeAlias' as const;
export const LABEL_TYPEDEF = 'Typedef' as const;
export const LABEL_CONST = 'Const' as const;
export const LABEL_PROPERTY = 'Property' as const;
export const LABEL_RECORD = 'Record' as const;
export const LABEL_UNION = 'Union' as const;
export const LABEL_STATIC = 'Static' as const;
export const LABEL_VARIABLE = 'Variable' as const;
export const LABEL_CODE_ELEMENT = 'CodeElement' as const;

export const CHUNK_MODE_AST_FUNCTION = 'ast-function' as const;
export const CHUNK_MODE_AST_DECLARATION = 'ast-declaration' as const;
// CHUNK_MODE_CHARACTER exists for type completeness but is a no-op in CHUNKING_RULES —
// omit the entry entirely to get character fallback via chunker.ts dispatch.
export const CHUNK_MODE_CHARACTER = 'character' as const;

export const STRUCTURAL_TEXT_MODE_NONE = 'none' as const;
export const STRUCTURAL_TEXT_MODE_DECLARATION = 'declaration' as const;

export interface ChunkingRule {
  mode:
    | typeof CHUNK_MODE_AST_FUNCTION
    | typeof CHUNK_MODE_AST_DECLARATION
    | typeof CHUNK_MODE_CHARACTER;
  includePrefix: boolean;
  includeSuffix: boolean;
  groupFields: boolean;
  structuralTextMode: typeof STRUCTURAL_TEXT_MODE_NONE | typeof STRUCTURAL_TEXT_MODE_DECLARATION;
}

/**
 * Node labels that need chunking (have code body, potentially long)
 */
export const CHUNKABLE_LABELS = [
  LABEL_FUNCTION,
  LABEL_METHOD,
  LABEL_CONSTRUCTOR,
  LABEL_CLASS,
  LABEL_INTERFACE,
  LABEL_STRUCT,
  LABEL_ENUM,
  LABEL_TRAIT,
  LABEL_IMPL,
  LABEL_MACRO,
  LABEL_NAMESPACE,
] as const;

/**
 * Node labels that are short (no chunking needed, embed directly)
 */
export const SHORT_LABELS = [
  LABEL_TYPE_ALIAS,
  LABEL_TYPEDEF,
  LABEL_CONST,
  LABEL_PROPERTY,
  LABEL_RECORD,
  LABEL_UNION,
  LABEL_STATIC,
  LABEL_VARIABLE,
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
 * Node labels that have structural names (methods/fields) extractable via AST.
 * Only labels that consume methodNames/fieldNames in their embedding text should
 * be listed here — extra entries trigger wasted AST parses with no effect on output.
 */
export const STRUCTURAL_LABELS: ReadonlySet<string> = new Set([
  LABEL_CLASS,
  LABEL_STRUCT,
  LABEL_INTERFACE,
]);

/**
 * Node labels that have isExported column in their schema
 */
export const LABELS_WITH_EXPORTED = new Set([
  LABEL_FUNCTION,
  LABEL_CLASS,
  LABEL_INTERFACE,
  LABEL_METHOD,
  LABEL_CODE_ELEMENT,
]) as ReadonlySet<string>;

/**
 * Labels that need special chunking and/or structural text semantics.
 * Any chunkable label omitted here intentionally falls back to characterChunk
 * plus generateCodeBodyText (for example Enum/Trait/Impl/Macro/Namespace).
 */
type ChunkableLabel = (typeof CHUNKABLE_LABELS)[number];
export const CHUNKING_RULES: Readonly<Partial<Record<ChunkableLabel, ChunkingRule>>> = {
  [LABEL_FUNCTION]: {
    mode: CHUNK_MODE_AST_FUNCTION,
    includePrefix: true,
    includeSuffix: true,
    groupFields: false,
    structuralTextMode: STRUCTURAL_TEXT_MODE_NONE,
  },
  [LABEL_METHOD]: {
    mode: CHUNK_MODE_AST_FUNCTION,
    includePrefix: true,
    includeSuffix: true,
    groupFields: false,
    structuralTextMode: STRUCTURAL_TEXT_MODE_NONE,
  },
  [LABEL_CONSTRUCTOR]: {
    mode: CHUNK_MODE_AST_FUNCTION,
    includePrefix: true,
    includeSuffix: true,
    groupFields: false,
    structuralTextMode: STRUCTURAL_TEXT_MODE_NONE,
  },
  [LABEL_CLASS]: {
    mode: CHUNK_MODE_AST_DECLARATION,
    includePrefix: true,
    includeSuffix: false,
    groupFields: true,
    structuralTextMode: STRUCTURAL_TEXT_MODE_DECLARATION,
  },
  [LABEL_INTERFACE]: {
    mode: CHUNK_MODE_AST_DECLARATION,
    includePrefix: true,
    includeSuffix: false,
    groupFields: false,
    structuralTextMode: STRUCTURAL_TEXT_MODE_DECLARATION,
  },
  [LABEL_STRUCT]: {
    mode: CHUNK_MODE_AST_DECLARATION,
    includePrefix: true,
    includeSuffix: false,
    groupFields: true,
    structuralTextMode: STRUCTURAL_TEXT_MODE_DECLARATION,
  },
};

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
  /** Number of chunks passed to one local/HTTP embedding call */
  subBatchSize: number;
  /** Maximum ONNX Runtime CPU threads for local inference */
  threads: number;
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
  subBatchSize: 8,
  threads: 2,
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
