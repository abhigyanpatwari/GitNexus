/**
 * Embedding Pipeline Module
 *
 * Orchestrates the background embedding process:
 * 1. Query embeddable nodes from LadybugDB
 * 2. Generate text representations with enriched metadata
 * 3. Chunk long nodes, batch embed
 * 4. Update LadybugDB with chunk-aware embeddings
 * 5. Create vector index for semantic search
 */

import { createHash } from 'crypto';
import {
  initEmbedder,
  embedBatch,
  embedText,
  embeddingToArray,
  isEmbedderReady,
} from './embedder.js';
import { generateEmbeddingText } from './text-generator.js';
import { chunkNode, characterChunk } from './chunker.js';
import { extractStructuralNames } from './structural-extractor.js';
import {
  type EmbeddingProgress,
  type EmbeddingConfig,
  type EmbeddableNode,
  type SemanticSearchResult,
  type ModelProgress,
  EMBEDDABLE_LABELS,
  isShortLabel,
  LABEL_METHOD,
  LABELS_WITH_EXPORTED,
  STRUCTURAL_LABELS,
  collectBestChunks,
} from './types.js';
import {
  DEFAULT_VECTOR_MAX_DISTANCE,
  getVectorMaxDistance,
  resolveEmbeddingConfig,
} from './config.js';
import { rankExactEmbeddingRows, type ExactEmbeddingRow } from './exact-search.js';
import { EMBEDDING_COUNT_CYPHER } from '../embedding-count.js';
import { EMBEDDING_TABLE_NAME, EMBEDDING_INDEX_NAME, STALE_HASH_SENTINEL } from '../lbug/schema.js';
import { loadVectorExtension, createVectorIndex } from '../lbug/lbug-adapter.js';
import { escapeCypherString } from '../lbug/cypher-escape.js';
import type { ExtensionInstallPolicy } from '../lbug/extension-loader.js';
import { getExactScanLimit } from '../platform/capabilities.js';
import { logger } from '../logger.js';

const isDev = process.env.NODE_ENV === 'development';

const vectorUnavailableMessage =
  'VECTOR extension unavailable; semantic embeddings fall back to exact scan. ' +
  'To enable vector search, install it once with network access ' +
  '(GITNEXUS_LBUG_EXTENSION_INSTALL=auto), or pre-install it for offline use. ' +
  'Set GITNEXUS_LBUG_EXTENSION_INSTALL=never to skip installs and silence this.';

/**
 * Resolve the extension-install policy for the embedding WRITE path (analyze).
 *
 * Generating embeddings is an explicit opt-in to a feature that requires the
 * VECTOR extension, so when the operator has NOT pinned a policy we default to
 * `auto` (one bounded, out-of-process INSTALL) — matching the documented
 * "auto = default for analyze" intent in extension-loader.ts. An explicit
 * GITNEXUS_LBUG_EXTENSION_INSTALL=load-only|never|auto always wins, so an
 * offline or locked-down operator is never silently forced onto the network
 * (the #1153 regression caused by hard-coding `auto` here). Read on every call
 * (not memoized) so test env stubbing works.
 */
export const resolveEmbeddingInstallPolicy = (): ExtensionInstallPolicy => {
  const raw = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
  if (raw === 'load-only' || raw === 'never' || raw === 'auto') return raw;
  return 'auto';
};

const ensureVectorExtensionAvailable = async (): Promise<boolean> => {
  return loadVectorExtension(undefined, { policy: resolveEmbeddingInstallPolicy() });
};
/**
 * Bump this when the embedding text template changes in a way that should
 * invalidate existing vectors, such as metadata/header shape changes,
 * structural container context changes, or preceding-context formatting rules.
 */
export const EMBEDDING_TEXT_VERSION = 'v5';

/**
 * Compute a stable content fingerprint for an embeddable node.
 * Used to detect when the underlying text has changed so stale vectors
 * can be replaced (DELETE-then-INSERT, the Kuzu-sanctioned pattern for
 * vector-indexed rows).
 */
export const contentHashForNode = (
  node: EmbeddableNode,
  config: Partial<EmbeddingConfig> = {},
): string => {
  // Hash must be deterministic across runs, so exclude methodNames/fieldNames
  // which are populated during the batch loop via AST extraction.
  // Using only node.content ensures the hash stays stable.
  // NOTE: A change to extractStructuralNames behavior requires bumping EMBEDDING_TEXT_VERSION.
  const text = generateEmbeddingText(
    { ...node, methodNames: undefined, fieldNames: undefined },
    node.content,
    config,
  );
  return createHash('sha1').update(EMBEDDING_TEXT_VERSION).update('\n').update(text).digest('hex');
};

/**
 * Progress callback type
 */
export type EmbeddingProgressCallback = (progress: EmbeddingProgress) => void;

/**
 * Query all embeddable nodes from LadybugDB
 * Uses table-specific queries for different label types
 */
const queryEmbeddableNodes = async (
  executeQuery: (cypher: string) => Promise<any[]>,
): Promise<EmbeddableNode[]> => {
  const allNodes: EmbeddableNode[] = [];

  for (const label of EMBEDDABLE_LABELS) {
    try {
      let query: string;

      if (label === LABEL_METHOD) {
        // Method has parameterCount and returnType
        query = `
          MATCH (n:Method)
          RETURN n.id AS id, n.name AS name, 'Method' AS label,
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.isExported AS isExported, n.description AS description,
                 n.parameterCount AS parameterCount, n.returnType AS returnType,
                 n.language AS language
        `;
      } else if (LABELS_WITH_EXPORTED.has(label)) {
        // Function, Class, Interface have isExported and description
        query = `
          MATCH (n:\`${label}\`)
          RETURN n.id AS id, n.name AS name, '${label}' AS label,
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.isExported AS isExported, n.description AS description,
                 n.language AS language
        `;
      } else {
        // Multi-language tables (Struct, Enum, etc.) — have description but no isExported
        query = `
          MATCH (n:\`${label}\`)
          RETURN n.id AS id, n.name AS name, '${label}' AS label,
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.description AS description, n.language AS language
        `;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        const hasExportedColumn = label === LABEL_METHOD || LABELS_WITH_EXPORTED.has(label);
        allNodes.push({
          id: row.id ?? row[0],
          name: row.name ?? row[1],
          label: row.label ?? row[2],
          filePath: row.filePath ?? row[3],
          content: row.content ?? row[4] ?? '',
          startLine: row.startLine ?? row[5],
          endLine: row.endLine ?? row[6],
          isExported: hasExportedColumn ? (row.isExported ?? row[7]) : undefined,
          description: row.description ?? (hasExportedColumn ? row[8] : row[7]),
          language:
            row.language ??
            row[label === LABEL_METHOD ? 11 : hasExportedColumn ? 9 : 8],
          ...(label === LABEL_METHOD
            ? {
                parameterCount: row.parameterCount ?? row[9],
                returnType: row.returnType ?? row[10],
              }
            : {}),
        });
      }
    } catch (error) {
      if (isDev) {
        // `err` is pino's standard serializer key — an arbitrary key serializes an
        // Error to `{}`, losing the message and stack (#2114).
        logger.warn({ err: error }, `Query for ${label} nodes failed:`);
      }
    }
  }

  return allNodes.length > 0 ? allNodes : queryFallbackFileNodes(executeQuery);
};

/**
 * Static and documentation repositories may contain no code symbols while
 * still persisting useful text on File nodes. Keep File embeddings as a
 * zero-symbol fallback so code repositories retain symbol-first selection.
 */
const queryFallbackFileNodes = async (
  executeQuery: (cypher: string) => Promise<any[]>,
): Promise<EmbeddableNode[]> => {
  try {
    const rows = await executeQuery(`
      MATCH (n:File)
      RETURN n.id AS id, n.name AS name, 'File' AS label,
             n.filePath AS filePath, n.content AS content,
             n.language AS language
    `);

    return rows
      .map((row) => {
        const content = row.content ?? row[4] ?? '';
        return {
          id: row.id ?? row[0],
          name: row.name ?? row[1],
          label: row.label ?? row[2] ?? 'File',
          filePath: row.filePath ?? row[3],
          content,
          language: row.language ?? row[5],
          startLine: 1,
          endLine: Math.max(1, content.split('\n').length),
        };
      })
      .filter(
        (node) =>
          node.id &&
          node.filePath &&
          node.content.trim() &&
          node.content !== '[Binary file - content not stored]',
      );
  } catch (error) {
    if (isDev) {
      // `err`, not `error` — see the serializer note above (#2114).
      logger.warn({ err: error }, 'Fallback File-node embedding query failed:');
    }
    return [];
  }
};

/**
 * Batch INSERT chunk-aware embeddings into CodeEmbedding table
 */
export const batchInsertEmbeddings = async (
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>,
  ) => Promise<void>,
  updates: Array<{
    nodeId: string;
    chunkIndex: number;
    startLine: number;
    endLine: number;
    embedding: number[];
    contentHash?: string;
  }>,
): Promise<void> => {
  const paramsList = updates.map((u) => ({
    id: `${u.nodeId}:${u.chunkIndex}`,
    nodeId: u.nodeId,
    chunkIndex: u.chunkIndex,
    startLine: u.startLine,
    endLine: u.endLine,
    embedding: u.embedding,
    contentHash: u.contentHash ?? STALE_HASH_SENTINEL,
  }));
  if (paramsList.length === 0) return;

  await executeWithReusedStatement(
    `MATCH (e:${EMBEDDING_TABLE_NAME} {id: $id}) DELETE e`,
    paramsList.map(({ id }) => ({ id })),
  );
  const cypher = `CREATE (e:${EMBEDDING_TABLE_NAME} {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, startLine: $startLine, endLine: $endLine, embedding: $embedding, contentHash: $contentHash})`;
  await executeWithReusedStatement(cypher, paramsList);
};

/**
 * Create the vector index for semantic search (indexes the CodeEmbedding table).
 *
 * Keeps the embedding-specific extension-install policy gate here
 * (ensureVectorExtensionAvailable → resolveEmbeddingInstallPolicy, default
 * `auto` for the analyze write path), then delegates the actual
 * `CALL CREATE_VECTOR_INDEX(...)` to the adapter, which runs it through the
 * unprepared `conn.query()` path. It must NOT go through the injected
 * `executeQuery` (prepared `conn.prepare()`): LadybugDB cannot prepare that
 * procedure and fails with "We do not support prepare multiple statements" —
 * the silent degrade in #2114.
 *
 * Exported for run-analyze's wipe-and-restore seam (tri-review 4669518496
 * P1): a full-rebuild/escalated write wipes the DB files — index included —
 * and a preserve-only run restores embedding ROWS without ever reaching the
 * pipeline call sites below, so the orchestrator recreates the index through
 * this same policy-gated, warn-on-failure entry point. Consumed there via
 * dynamic import only (lazy-embeddings convention, #2370).
 */
export const buildVectorIndex = async (): Promise<boolean> => {
  // This pre-check applies the embedding-specific install policy
  // (resolveEmbeddingInstallPolicy, default `auto` for analyze) before reaching
  // the adapter. The adapter's createVectorIndex() calls loadVectorExtension()
  // again, but that's a no-op here: once this gate loads VECTOR the module-level
  // `vectorExtensionLoaded` flag is set, so the adapter's second call
  // short-circuits without re-resolving the policy — no double install.
  if (!(await ensureVectorExtensionAvailable())) return false;
  try {
    return await createVectorIndex();
  } catch (error) {
    // Surface this even outside dev: it silently downgrades a user-requested
    // feature (semantic search) to exact scan. Log under `err` so pino's
    // standard serializer captures the message/stack — logging under `error`
    // serialized an Error to `{}` (the empty `{"error":{}}` reported in #2114).
    logger.warn(
      { err: error },
      'Vector index creation failed; semantic search will use exact-scan fallback',
    );
    return false;
  }
};

export interface EmbeddingPipelineResult {
  /** Nodes that finished the run with a COMPLETE set of embedding rows. */
  nodesProcessed: number;
  chunksProcessed: number;
  vectorIndexReady: boolean;
  semanticMode: 'vector-index' | 'exact-scan';
  /**
   * Nodes whose embeddings were dropped this run because at least one of their
   * chunks lost its sub-batch to a failing endpoint (#2790). Their rows were
   * deleted, so they now hold ZERO rows and the next incremental run re-embeds
   * them from scratch. Empty on a clean run.
   */
  failedNodeIds: string[];
}

/**
 * How many sub-batches may fail back-to-back before the pipeline gives up.
 *
 * Surviving a transient endpoint hiccup is the whole point of tolerating a
 * failed sub-batch (#2790) — but a genuinely dead endpoint would otherwise walk
 * every remaining node deleting its rows on the way, which on an incremental run
 * wipes surviving embeddings wholesale. Rethrowing once the ceiling is reached
 * preserves the pre-#2790 behavior for a dead endpoint. Any successful sub-batch
 * resets the counter, so only an unbroken run of failures trips it.
 *
 * ponytail: flat consecutive-failure ceiling; make it rate-based if flaky
 * endpoints prove common.
 */
const MAX_CONSECUTIVE_SUB_BATCH_FAILURES = 5;

/**
 * Cumulative guard: the share of sub-batches allowed to fail across the whole
 * run, and the minimum sample before that share means anything.
 *
 * The ceiling above only catches a total outage — any success resets it, so an
 * endpoint load-shedding every other sub-batch walks the entire repo dropping
 * half of it while `analyze` still exits 0 (#2790). Shaped after Resilience4j's
 * `failureRateThreshold` + `minimumNumberOfCalls`: judge a failure RATE, but
 * only once enough sub-batches have been attempted for a rate to mean anything
 * — a 3-node repo losing its single sub-batch is 100% and must not abort. The
 * rate sits below a live-traffic breaker's 50% (a batch indexer's job is to
 * index the whole corpus, not to serve degraded traffic) and above Hadoop's
 * single-digit `mapreduce.map.failures.maxpercent` (tolerating transient
 * hiccups is the entire point of #2790).
 *
 * The sample floor SCALES with the run; it used to be a flat 20. A flat floor
 * can exceed a run's ENTIRE sub-batch budget, and then the guard is not "not yet
 * armed" — it is structurally off. Every resume run has exactly that shape by
 * construction: its node set is only the pending ids, so it produces few
 * sub-batches no matter how large the repo is, and the run whose whole purpose
 * is retrying a suspect endpoint was the one run this guard could never fire in.
 * Resilience4j can afford a constant `minimumNumberOfCalls` because a breaker
 * sits on an unbounded call stream — the sample always arrives eventually; a
 * batch indexer has a finite budget, so the minimum has to be expressed relative
 * to it. Hadoop's `mapreduce.map.failures.maxpercent` takes the other extreme, a
 * pure percentage with no minimum at all, which is why a 1-of-1 failure reads as
 * "100% failed" there. The clamp below keeps both ends honest:
 *
 *   floor = clamp(ceil(totalNodes / subBatchSize / 2), 5, 20)
 *
 *  - ceil(totalNodes / subBatchSize / 2): the run's own sub-batch budget, halved
 *    — so the rate is judged over the back half of a short run: a real sample,
 *    still early enough to stop the run before it walks the rest of the corpus.
 *    Derived from the ACTUAL `subBatchSize` rather than assuming the default of
 *    8, because `GITNEXUS_EMBEDDING_SUB_BATCH_SIZE` is exactly the knob an
 *    operator turns for a constrained or flaky endpoint — the population this
 *    guard protects — and a floor computed against the wrong divisor is the same
 *    structurally-off guard, just at a different repo size. Nodes that chunk
 *    into several chunks only produce MORE sub-batches, so the guard arms
 *    earlier still.
 *  - min 5: under five attempts a "rate" is one or two coin flips. A 3-node repo
 *    losing its single sub-batch is 100% and must be tolerated, not aborted —
 *    the exact case the old flat floor was written to protect, kept intact.
 *  - max 20 (the previous flat value, reached once a run has 40 sub-batches):
 *    large runs keep today's behavior byte for byte, and a purely proportional
 *    floor would perversely WEAKEN the guard at scale — half a 20k-node repo's
 *    sub-batches is 1250 of them (at subBatchSize 8) eaten before a rate could
 *    abort anything.
 *
 * Honest limit: this bounds the failure RATE, never the absolute loss. A run
 * that steadily fails just under 25% of its sub-batches never aborts, so a
 * single run may drop up to a quarter of the corpus and still exit 0 behind one
 * warning line. That is by design — the dropped nodes are left holding ZERO rows
 * so the next incremental run re-embeds them, which beats failing the whole
 * analyze — but it is the real ceiling on what this guard promises.
 *
 * ponytail: lifetime ratio, evaluated only when a sub-batch fails. A sliding
 * window would spot an endpoint that degrades late in a long run sooner —
 * upgrade if partial-corpus reports keep arriving from runs that stayed under
 * this bar.
 */
const MAX_SUB_BATCH_FAILURE_RATIO = 0.25;
const MIN_SUB_BATCHES_FLOOR = 5;
const MAX_SUB_BATCHES_FLOOR = 20;
/** Judge the rate over the back half of the run: half its sub-batch budget. */
const RATIO_GUARD_SAMPLE_FRACTION_DIVISOR = 2;

const minSubBatchesBeforeFailureRatioGuard = (totalNodes: number, subBatchSize: number): number =>
  Math.min(
    MAX_SUB_BATCHES_FLOOR,
    Math.max(
      MIN_SUB_BATCHES_FLOOR,
      Math.ceil(totalNodes / subBatchSize / RATIO_GUARD_SAMPLE_FRACTION_DIVISOR),
    ),
  );

/**
 * The cumulative-ratio abort (#2790). Deliberately NOT the raw endpoint error
 * the consecutive ceiling rethrows: the operator's next action differs — one bad
 * batch is noise, a quarter of the corpus failing is an endpoint to fix before
 * re-running. The retained streak error still names the real defect, carried in
 * both the message and `cause`.
 */
const failureRatioAbortError = (failures: number, attempted: number, cause: unknown): Error =>
  new Error(
    `[embed] Aborting: ${failures} of ${attempted} embed sub-batches failed ` +
      `(${Math.round((failures / attempted) * 100)}%, limit ` +
      `${Math.round(MAX_SUB_BATCH_FAILURE_RATIO * 100)}%) — too much of the corpus is failing to ` +
      `embed for this run to produce a usable index. Fix the embedding endpoint and re-run. ` +
      `Underlying failure: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );

/**
 * Both failed: the run is aborting AND the cleanup DELETE for the dropped nodes
 * threw (busy/read-only DB). The abort error stays primary — it is the one that
 * names the real defect and the one the operator must act on — and is kept as
 * `cause`; the cleanup failure is appended, because it also means those nodes may
 * still hold partial rows carrying the CURRENT contentHash, which a later
 * incremental run would read as fresh (the corruption the cleanup exists to
 * prevent). Without this, a failing DELETE replaced the endpoint error outright.
 */
const abortWithFailedCleanupError = (abortErr: unknown, cleanupErr: unknown): Error =>
  new Error(
    `${abortErr instanceof Error ? abortErr.message : String(abortErr)} — additionally, ` +
      `cleanup of the dropped nodes' embedding rows FAILED, so some may still hold partial ` +
      `rows that a later incremental run would read as fresh: ` +
      `${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
    { cause: abortErr },
  );

/**
 * Cancellation is an instruction, not endpoint flakiness — it must abort the run
 * instead of being absorbed as a tolerable sub-batch failure. Checked on the
 * error shape as well as on our own signal, because an embed call handed the
 * signal rejects with a `DOMException`/`Error` named `AbortError` rather than
 * flipping anything the pipeline owns (e.g. a host-supplied transport signal).
 */
const isCancellationError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';

export interface EmbeddingPipelineCheckpoint {
  nodesProcessed: number;
  totalNodes: number;
  chunksProcessed: number;
}

export interface EmbeddingPipelineCheckpointWindow extends EmbeddingPipelineCheckpoint {
  nodeIds: string[];
}

export interface EmbeddingPipelineOptions {
  signal?: AbortSignal;
  checkpointEveryNodes?: number;
  forceReembedNodeIds?: ReadonlySet<string>;
  onCheckpointWindowStart?: (window: EmbeddingPipelineCheckpointWindow) => Promise<void>;
  onCheckpoint?: (checkpoint: EmbeddingPipelineCheckpoint) => Promise<void>;
}

/**
 * DELETE stale embedding rows for the given nodeIds so they can be re-inserted.
 *
 * Kuzu forbids SET on vector-indexed properties; DELETE-then-INSERT is the
 * sanctioned pattern. A `"does not exist"` error means the rows are already gone
 * (safe to proceed); any other error risks vector-index corruption, so it
 * propagates and aborts the pipeline.
 *
 * Called per-batch (just before each batch's INSERT), not once up front — see
 * the caller comment / KTD7: an up-front bulk delete of every stale row leaves
 * the whole index deleted-not-reinserted if the re-embed is interrupted. Per-batch
 * interleaving bounds that window to a single batch.
 */
const deleteStaleEmbeddingRows = async (
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>,
  ) => Promise<void>,
  nodeIds: string[],
): Promise<void> => {
  if (nodeIds.length === 0) return;
  try {
    await executeWithReusedStatement(
      `MATCH (e:${EMBEDDING_TABLE_NAME} {nodeId: $nodeId}) DELETE e`,
      nodeIds.map((nodeId) => ({ nodeId })),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('does not exist')) {
      throw new Error(
        `[embed] Failed to delete stale embedding rows — aborting to prevent vector-index corruption: ${msg}`,
      );
    }
  }
};

/**
 * Run the embedding pipeline
 *
 * @param executeQuery - Function to execute Cypher queries against LadybugDB
 * @param executeWithReusedStatement - Function to execute with reused prepared statement
 * @param onProgress - Callback for progress updates
 * @param config - Optional configuration override
 * @param skipNodeIds - Optional set of node IDs that already have embeddings (incremental mode)
 * @param existingEmbeddings - Optional map of nodeId → contentHash for incremental mode.
 *        Nodes whose hash matches are skipped; nodes with a changed hash are DELETE'd
 *        and re-embedded; nodes not in the map are embedded fresh.
 */
export const runEmbeddingPipeline = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>,
  ) => Promise<void>,
  onProgress: EmbeddingProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  skipNodeIds?: Set<string>,
  existingEmbeddings?: Map<string, string>,
  pipelineOptions: EmbeddingPipelineOptions = {},
): Promise<EmbeddingPipelineResult> => {
  const finalConfig = resolveEmbeddingConfig(config);
  let totalChunks = 0;
  const checkpointEveryNodes = pipelineOptions.checkpointEveryNodes ?? 5_000;
  if (!Number.isSafeInteger(checkpointEveryNodes) || checkpointEveryNodes <= 0) {
    throw new Error('checkpointEveryNodes must be a positive integer');
  }
  const throwIfCancelled = (): void => pipelineOptions.signal?.throwIfAborted();

  try {
    throwIfCancelled();
    const vectorAvailable = await ensureVectorExtensionAvailable();
    throwIfCancelled();
    if (!vectorAvailable) {
      logger.warn(vectorUnavailableMessage);
    }

    // Phase 1: Load embedding model
    onProgress({
      phase: 'loading-model',
      percent: 0,
      modelDownloadPercent: 0,
    });

    if (!isEmbedderReady()) {
      await initEmbedder((modelProgress: ModelProgress) => {
        const downloadPercent = modelProgress.progress ?? 0;
        onProgress({
          phase: 'loading-model',
          percent: Math.round(downloadPercent * 0.2),
          modelDownloadPercent: downloadPercent,
        });
      }, finalConfig);
      throwIfCancelled();
    }

    onProgress({
      phase: 'loading-model',
      percent: 20,
      modelDownloadPercent: 100,
    });

    if (isDev) {
      logger.info('🔍 Querying embeddable nodes...');
    }

    // Phase 2: Query embeddable nodes
    let nodes = await queryEmbeddableNodes(executeQuery);
    throwIfCancelled();
    const embeddableNodeIds = new Set(nodes.map((node) => node.id));

    // Incremental mode: compare content hashes, delete stale rows, skip fresh ones.
    // Computed hashes for stale nodes are cached so batchInsertEmbeddings can reuse them
    // (avoids double computation).
    const computedStaleHashes = new Map<string, string>();
    // Stale rows are DELETE'd per-batch (just before each batch's INSERT) rather
    // than all up front — see U6 / KTD7. `staleNodeIds` is consulted inside the
    // batch loop; it stays empty in full (non-incremental) mode so no deletes fire.
    const staleNodeIds = new Set<string>();
    const forceReembedNodeIds = pipelineOptions.forceReembedNodeIds;
    if (
      (existingEmbeddings && existingEmbeddings.size > 0) ||
      (forceReembedNodeIds && forceReembedNodeIds.size > 0)
    ) {
      const beforeCount = nodes.length;
      nodes = nodes.filter((n) => {
        const existingHash = existingEmbeddings?.get(n.id);
        if (existingHash === undefined) {
          // New node — needs embedding
          return true;
        }
        const currentHash = contentHashForNode(n, finalConfig);
        if (currentHash !== existingHash || forceReembedNodeIds?.has(n.id)) {
          // Content changed — cache hash for reuse during insert, mark for DELETE + re-embed
          computedStaleHashes.set(n.id, currentHash);
          staleNodeIds.add(n.id);
          return true;
        }
        // Hash matches — skip (fresh); no need to cache hash for skipped nodes
        return false;
      });

      if (isDev) {
        logger.info(
          `📦 Incremental embeddings: ${beforeCount} total, ${existingEmbeddings.size} cached, ${staleNodeIds.size} stale, ${nodes.length} to embed`,
        );
      }
    }

    if (forceReembedNodeIds && forceReembedNodeIds.size > 0) {
      const removedPendingNodeIds = [...forceReembedNodeIds].filter(
        (nodeId) => !embeddableNodeIds.has(nodeId),
      );
      await deleteStaleEmbeddingRows(executeWithReusedStatement, removedPendingNodeIds);
      throwIfCancelled();
    }

    const totalNodes = nodes.length;

    if (isDev) {
      logger.info(`📊 Found ${totalNodes} embeddable nodes`);
    }

    if (totalNodes === 0) {
      throwIfCancelled();
      // Ensure the vector index exists even when no new nodes need embedding.
      // A prior crash or first-time incremental run may have left CodeEmbedding
      // rows without ever reaching index creation.
      const vectorIndexReady = await buildVectorIndex();

      onProgress({
        phase: 'ready',
        percent: 100,
        nodesProcessed: 0,
        totalNodes: 0,
      });
      return {
        nodesProcessed: 0,
        chunksProcessed: 0,
        vectorIndexReady,
        semanticMode: vectorIndexReady ? 'vector-index' : 'exact-scan',
        failedNodeIds: [],
      };
    }

    // Phase 3: Chunk + embed nodes
    const batchSize = finalConfig.batchSize;
    const chunkSize = finalConfig.chunkSize;
    const overlap = finalConfig.overlap;
    const checkpointWindowNodeCount = Math.max(
      batchSize,
      Math.ceil(checkpointEveryNodes / batchSize) * batchSize,
    );
    // Nodes that finished with a COMPLETE row set. Distinct from the number of
    // nodes traversed (see `traversedNodes` in the loop): a node whose chunks lost
    // a sub-batch is walked past but NOT processed, and must not be counted as if
    // its embeddings exist.
    let processedNodes = 0;
    // Run-level: every node whose rows were dropped by the sub-batch failure path.
    const failedNodeIds = new Set<string>();
    // Run-level, not per-batch: a dead endpoint stays dead across batch boundaries.
    let consecutiveSubBatchFailures = 0;
    // Run-level tally behind MAX_SUB_BATCH_FAILURE_RATIO (#2790). Lifetime, never
    // reset — a steadily-degraded endpoint is exactly the shape the consecutive
    // counter's reset-on-success blinds it to.
    let subBatchesAttempted = 0;
    let subBatchFailures = 0;
    // Sized from this run's own node set AND its configured sub-batch size, not
    // a flat constant, so a resume run (whose node set is only the pending ids)
    // and an operator-tuned `subBatchSize` both still arm the guard — see
    // minSubBatchesBeforeFailureRatioGuard.
    const minSubBatchesForRatioGuard = minSubBatchesBeforeFailureRatioGuard(
      totalNodes,
      finalConfig.subBatchSize,
    );
    // #2790: the FIRST error of the current streak — the one the ceiling rethrows.
    // Later failures in a streak degrade into generic noise: a misconfigured
    // endpoint trips the HTTP client's circuit breaker after 3 rejections, so
    // failures 4 and 5 are "circuit open … retry in 30s" (advice to wait for a
    // condition that never changes) while the first still names the real defect
    // ("unexpected response shape"). Boxed rather than held as a bare `unknown`
    // so a thrown `undefined` can't be misread as "no error". Cleared with the
    // counter below, so the rethrown error always belongs to the streak that
    // actually tripped the ceiling.
    let streakFirstError: { err: unknown } | undefined;

    onProgress({
      phase: 'embedding',
      percent: 20,
      nodesProcessed: 0,
      totalNodes,
      currentBatch: 0,
      totalBatches: Math.ceil(totalNodes / batchSize),
    });

    // Process in batches of nodes
    for (let batchIndex = 0; batchIndex < totalNodes; batchIndex += batchSize) {
      throwIfCancelled();
      if (pipelineOptions.onCheckpointWindowStart && batchIndex % checkpointWindowNodeCount === 0) {
        await pipelineOptions.onCheckpointWindowStart({
          nodesProcessed: processedNodes,
          totalNodes,
          chunksProcessed: totalChunks,
          nodeIds: nodes
            .slice(batchIndex, batchIndex + checkpointWindowNodeCount)
            .map((node) => node.id),
        });
        throwIfCancelled();
      }
      const batch = nodes.slice(batchIndex, batchIndex + batchSize);

      // Chunk each node and generate text
      const allTexts: string[] = [];
      const allUpdates: Array<{
        nodeId: string;
        chunkIndex: number;
        startLine: number;
        endLine: number;
        contentHash: string;
      }> = [];

      for (const node of batch) {
        const isShort = isShortLabel(node.label);
        const startLine = node.startLine ?? 0;
        const endLine = node.endLine ?? 0;

        // Extract structural names for class-like nodes via AST extractors
        if (!isShort && STRUCTURAL_LABELS.has(node.label)) {
          try {
            const names = await extractStructuralNames(node.content, node.filePath, node.language);
            node.methodNames = names.methodNames;
            node.fieldNames = names.fieldNames;
          } catch {
            // AST extraction failed — names stay undefined, text-generator handles gracefully
          }
        }

        // Compute content hash once per node (re-use cached value for stale nodes)
        const hash = computedStaleHashes.get(node.id) ?? contentHashForNode(node, finalConfig);

        let chunks: Array<{ text: string; chunkIndex: number; startLine: number; endLine: number }>;
        if (isShort) {
          chunks = [{ text: node.content, chunkIndex: 0, startLine, endLine }];
        } else {
          try {
            chunks = await chunkNode(
              node.label,
              node.content,
              node.filePath,
              startLine,
              endLine,
              chunkSize,
              overlap,
              node.language,
            );
          } catch (chunkErr) {
            if (isDev) {
              logger.warn(
                { chunkErr },
                `⚠️ AST chunking failed for ${node.label} "${node.name}" (${node.filePath}), falling back to character-based chunking:`,
              );
            }
            chunks = characterChunk(node.content, startLine, endLine, chunkSize, overlap);
          }
        }

        let prevTail = '';
        for (const chunk of chunks) {
          const text = generateEmbeddingText(
            node,
            chunk.text,
            finalConfig,
            chunk.chunkIndex,
            prevTail,
          );
          allTexts.push(text);
          allUpdates.push({
            nodeId: node.id,
            chunkIndex: chunk.chunkIndex,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            contentHash: hash,
          });
          prevTail = overlap > 0 ? chunk.text.slice(-overlap) : '';
        }
      }

      // U6 / KTD7: delete this batch's stale rows immediately before its inserts,
      // so an interrupted re-embed loses at most one batch (not the whole index).
      // Preserves Kuzu's required DELETE-before-INSERT for vector-indexed rows.
      const batchStaleIds = batch.filter((n) => staleNodeIds.has(n.id)).map((n) => n.id);
      await deleteStaleEmbeddingRows(executeWithReusedStatement, batchStaleIds);
      throwIfCancelled();

      // Embed chunk texts in sub-batches to control memory
      const EMBED_SUB_BATCH = finalConfig.subBatchSize;
      // Nodes that lost at least one chunk in this batch. Collected as NODE ids,
      // not sub-batch indices: `allTexts`/`allUpdates` are flat over the whole
      // batch with no node alignment, so one node's chunks can straddle a
      // sub-batch boundary and a failure never maps cleanly onto whole nodes.
      const batchFailedNodeIds = new Set<string>();
      // Set instead of thrown immediately so the cleanup DELETE below still runs.
      // Carries EITHER abort reason — the consecutive-ceiling rethrow or the
      // cumulative-ratio abort — hence the reason-neutral name.
      let abortError: { err: unknown } | undefined;
      for (let si = 0; si < allTexts.length; si += EMBED_SUB_BATCH) {
        const subTexts = allTexts.slice(si, si + EMBED_SUB_BATCH);
        const subUpdates = allUpdates.slice(si, si + EMBED_SUB_BATCH);
        subBatchesAttempted += 1;

        let embeddings: Float32Array[];
        try {
          embeddings = await embedBatch(subTexts, { signal: pipelineOptions.signal });
        } catch (embedErr) {
          // Never swallow a cancel as a "tolerable" failure — the operator asked
          // us to stop, and the run has no business continuing (or deleting rows).
          if (pipelineOptions.signal?.aborted || isCancellationError(embedErr)) throw embedErr;

          // #2790: one transient hiccup used to discard an entire multi-hour run.
          // Warn (not error — the run survives), drop this sub-batch's nodes, and
          // keep going; the cleanup DELETE after this loop makes the drop safe.
          const droppedNodeIds = new Set(subUpdates.map((u) => u.nodeId));
          for (const nodeId of droppedNodeIds) batchFailedNodeIds.add(nodeId);
          consecutiveSubBatchFailures += 1;
          subBatchFailures += 1;
          const streakError = (streakFirstError ??= { err: embedErr });
          // Log under `err` so pino's standard serializer keeps the message and
          // stack — the previous `{ embedErr }` key serialized to `{}` (#2114).
          logger.warn(
            { err: embedErr },
            `⚠️ embedBatch failed for ${subTexts.length} texts (first: "${subTexts[0]?.substring(0, 80)}...") — ` +
              `dropping ${droppedNodeIds.size} node(s) from this run so the next run re-embeds them ` +
              `(${consecutiveSubBatchFailures}/${MAX_CONSECUTIVE_SUB_BATCH_FAILURES} consecutive, ` +
              `${subBatchFailures}/${subBatchesAttempted} sub-batches failed this run):`,
          );
          if (consecutiveSubBatchFailures >= MAX_CONSECUTIVE_SUB_BATCH_FAILURES) {
            // Bail out — but via `break`, not `throw`, so the cleanup DELETE below
            // still runs: sub-batches that succeeded before the endpoint went dark
            // left partial rows carrying the CURRENT hash, which is exactly the
            // read-as-fresh corruption this path exists to prevent.
            abortError = streakError;
            break;
          }
          if (
            subBatchesAttempted >= minSubBatchesForRatioGuard &&
            subBatchFailures / subBatchesAttempted >= MAX_SUB_BATCH_FAILURE_RATIO
          ) {
            // Same break-then-cleanup path as the ceiling: a run aborting because
            // the endpoint is shedding a quarter of the corpus still must not leave
            // this batch's touched nodes half embedded (#2790).
            abortError = {
              err: failureRatioAbortError(subBatchFailures, subBatchesAttempted, streakError.err),
            };
            break;
          }
          continue;
        }
        consecutiveSubBatchFailures = 0;
        streakFirstError = undefined;

        const dbUpdates = subUpdates.map((u, i) => ({
          ...u,
          embedding: embeddingToArray(embeddings[i]),
        }));

        await batchInsertEmbeddings(executeWithReusedStatement, dbUpdates);
        throwIfCancelled();
      }

      // A failed sub-batch leaves the node HALF embedded, and half is worse than
      // none: this batch's stale rows were already deleted above, a node's chunks
      // can straddle a sub-batch boundary, and every surviving row carries the
      // CURRENT contentHash. Both downstream hash-map builders collapse a node's
      // rows to one entry (last row wins), so a half-embedded node would read as
      // FRESH on every future run and its missing chunks would never come back.
      // Deleting ALL of its rows leaves zero, which the incremental filter reads
      // as "New node — needs embedding" — it self-heals next run. Kept inside the
      // per-batch iteration so the inconsistency window stays one batch wide,
      // matching the U6 / KTD7 delete-window rationale above.
      if (batchFailedNodeIds.size > 0) {
        try {
          await deleteStaleEmbeddingRows(executeWithReusedStatement, [...batchFailedNodeIds]);
        } catch (cleanupErr) {
          // A failing cleanup DELETE must never swallow a pending abort: that
          // error names the actual defect (the endpoint), while a busy or
          // read-only DB is a second, downstream symptom. Without this the
          // `throw` below is unreachable and the run reports only the DELETE.
          if (!abortError) throw cleanupErr;
          throw abortWithFailedCleanupError(abortError.err, cleanupErr);
        }
        for (const nodeId of batchFailedNodeIds) failedNodeIds.add(nodeId);
      }
      if (abortError) throw abortError.err;

      // Nodes walked past in this run so far. Drives progress percent and the
      // checkpoint cadence, which must stay monotonic and hit `totalNodes`
      // exactly — `processedNodes` can now lag behind and would silently stop the
      // window-aligned and terminal checkpoints from ever firing.
      const traversedNodes = batchIndex + batch.length;
      processedNodes += batch.length - batchFailedNodeIds.size;
      totalChunks += allUpdates.filter((u) => !batchFailedNodeIds.has(u.nodeId)).length;

      const embeddingProgress = 20 + (traversedNodes / totalNodes) * 70;
      onProgress({
        phase: 'embedding',
        percent: Math.round(embeddingProgress),
        nodesProcessed: processedNodes,
        totalNodes,
        currentBatch: Math.floor(batchIndex / batchSize) + 1,
        totalBatches: Math.ceil(totalNodes / batchSize),
      });

      if (
        pipelineOptions.onCheckpoint &&
        (traversedNodes % checkpointWindowNodeCount === 0 || traversedNodes === totalNodes)
      ) {
        await pipelineOptions.onCheckpoint({
          nodesProcessed: processedNodes,
          totalNodes,
          chunksProcessed: totalChunks,
        });
        throwIfCancelled();
      }
    }

    // Phase 4: Create vector index
    throwIfCancelled();
    // Report the nodes actually embedded, not `totalNodes`: with a flaky endpoint
    // those differ, and a caller is about to read this number as truth.
    onProgress({
      phase: 'indexing',
      percent: 90,
      nodesProcessed: processedNodes,
      totalNodes,
    });

    if (isDev) {
      logger.info('📇 Creating vector index...');
    }

    const vectorIndexReady = await buildVectorIndex();

    onProgress({
      phase: 'ready',
      percent: 100,
      nodesProcessed: processedNodes,
      totalNodes,
    });

    if (failedNodeIds.size > 0) {
      logger.warn(
        `⚠️ Embedding pipeline finished with ${failedNodeIds.size} node(s) dropped after embed failures; ` +
          'their rows were removed so the next run re-embeds them.',
      );
    }
    if (isDev) {
      logger.info(
        `✅ Embedding pipeline complete! (${totalChunks} chunks from ${processedNodes}/${totalNodes} nodes)`,
      );
    }
    return {
      nodesProcessed: processedNodes,
      chunksProcessed: totalChunks,
      vectorIndexReady,
      semanticMode: vectorIndexReady ? 'vector-index' : 'exact-scan',
      failedNodeIds: [...failedNodeIds],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (isDev) {
      // `err`, not `error` — see the serializer note in queryEmbeddableNodes (#2114).
      logger.error({ err: error }, '❌ Embedding pipeline error:');
    }

    onProgress({
      phase: 'error',
      percent: 0,
      error: errorMessage,
    });

    throw error;
  }
};

/**
 * Perform semantic search using the vector index with chunk deduplication
 */
export const semanticSearch = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 10,
  maxDistance: number = getVectorMaxDistance(DEFAULT_VECTOR_MAX_DISTANCE),
): Promise<SemanticSearchResult[]> => {
  if (!isEmbedderReady()) {
    throw new Error('Embedding model not initialized. Run embedding pipeline first.');
  }

  const queryEmbedding = await embedText(query);
  const queryVec = embeddingToArray(queryEmbedding);
  const queryVecStr = `[${queryVec.join(',')}]`;

  let bestChunks = new Map<
    string,
    { distance: number; chunkIndex: number; startLine: number; endLine: number }
  >();
  // Query/read path: NEVER spawn a network INSTALL on a user query. If the
  // VECTOR extension was not pre-installed, fall back to exact scan rather than
  // blocking the query on a download (offline-first; see extension-loader.ts
  // "load-only" — used by all serve/MCP query paths).
  if (await loadVectorExtension(undefined, { policy: 'load-only' })) {
    try {
      bestChunks = await collectBestChunks(k, async (fetchLimit) => {
        const vectorQuery = `
          CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
            CAST(${queryVecStr} AS FLOAT[${queryVec.length}]), ${fetchLimit})
          YIELD node AS emb, distance
          WITH emb, distance
          WHERE distance < ${maxDistance}
          RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex,
                 emb.startLine AS startLine, emb.endLine AS endLine, distance
          ORDER BY distance
        `;

        const embResults = await executeQuery(vectorQuery);
        return embResults.map((row) => ({
          nodeId: row.nodeId ?? row[0],
          chunkIndex: row.chunkIndex ?? row[1] ?? 0,
          startLine: row.startLine ?? row[2] ?? 0,
          endLine: row.endLine ?? row[3] ?? 0,
          distance: row.distance ?? row[4],
        }));
      });
    } catch {
      bestChunks = new Map();
    }
  }

  if (bestChunks.size === 0) {
    // The Cypher only. NOT `measurePersistedEmbeddingCount`: its tri-state
    // exists so a publisher never writes a fabricated 0, whereas here `?? 0`
    // is the right answer — an unknown count simply skips the exact scan.
    const countRows = await executeQuery(EMBEDDING_COUNT_CYPHER);
    const countRow = countRows[0];
    const embeddingCount = Number(countRow?.cnt ?? countRow?.[0] ?? 0);
    const exactLimit = getExactScanLimit();
    if (embeddingCount > 0 && embeddingCount <= exactLimit) {
      const rows = await executeQuery(`
        MATCH (e:${EMBEDDING_TABLE_NAME})
        RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex,
               e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding
      `);
      const exactRows: ExactEmbeddingRow[] = rows.map((row) => ({
        nodeId: row.nodeId ?? row[0],
        chunkIndex: row.chunkIndex ?? row[1] ?? 0,
        startLine: row.startLine ?? row[2] ?? 0,
        endLine: row.endLine ?? row[3] ?? 0,
        embedding: row.embedding ?? row[4] ?? [],
      }));
      bestChunks = new Map(
        rankExactEmbeddingRows(exactRows, queryVec, k, maxDistance).map((row) => [
          row.nodeId,
          {
            distance: row.distance,
            chunkIndex: row.chunkIndex,
            startLine: row.startLine,
            endLine: row.endLine,
          },
        ]),
      );
    }
  }

  if (bestChunks.size === 0) {
    return [];
  }

  // Group results by label for batched metadata queries
  const byLabel = new Map<
    string,
    Array<{ nodeId: string; distance: number } & Record<string, any>>
  >();
  for (const [nodeId, chunk] of Array.from(bestChunks.entries()).slice(0, k)) {
    const labelEndIdx = nodeId.indexOf(':');
    const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push({ nodeId, ...chunk });
  }

  // Batch-fetch metadata per label
  const results: SemanticSearchResult[] = [];

  for (const [label, items] of byLabel) {
    const idList = items.map((i) => `'${escapeCypherString(i.nodeId)}'`).join(', ');
    try {
      const nodeQuery = `
        MATCH (n:\`${label}\`) WHERE n.id IN [${idList}]
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
               n.startLine AS startLine, n.endLine AS endLine
      `;
      const nodeRows = await executeQuery(nodeQuery);
      const rowMap = new Map<string, any>();
      for (const row of nodeRows) {
        const id = row.id ?? row[0];
        rowMap.set(id, row);
      }
      for (const item of items) {
        const nodeRow = rowMap.get(item.nodeId);
        if (nodeRow) {
          results.push({
            nodeId: item.nodeId,
            name: nodeRow.name ?? nodeRow[1] ?? '',
            label,
            filePath: nodeRow.filePath ?? nodeRow[2] ?? '',
            distance: item.distance,
            startLine: item.startLine,
            endLine: item.endLine,
          });
        }
      }
    } catch {
      // Table might not exist, skip
    }
  }

  results.sort((a, b) => a.distance - b.distance);

  return results;
};

/**
 * Semantic search with graph expansion (flattened results)
 */
export const semanticSearchWithContext = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 5,
  _hops: number = 1,
): Promise<any[]> => {
  const results = await semanticSearch(executeQuery, query, k);

  return results.map((r) => ({
    matchId: r.nodeId,
    matchName: r.name,
    matchLabel: r.label,
    matchPath: r.filePath,
    distance: r.distance,
    connectedId: null,
    connectedName: null,
    connectedLabel: null,
    relationType: null,
  }));
};
