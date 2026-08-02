/**
 * What POST /api/embed persists and reports once the embedding pipeline returns.
 *
 * Extracted from api.ts (#2790 review, finding 9): these are pure functions, and
 * reaching them through `await import('../../src/server/api.js')` pulled in
 * Express, cors, the LadybugDB native adapter and the whole MCP wiring — one
 * measured run of the test file TIMED OUT at 30s and the two that passed took
 * ~20s and ~22s. Nothing here imports the database, MCP or Express; the only
 * imports are types.
 *
 * The CLI's equivalent decisions live in `core/run-analyze.ts` Phase 5. The two
 * paths write the SAME `RepoMeta.embeddingCheckpoint` field, so their rules are
 * deliberately kept in step — see each comment below for the CLI counterpart.
 */

import type { RepoMeta } from '../storage/repo-manager.js';
import type { AnalyzeJobPartialOutcome } from './analyze-job.js';

/** The embedding identity a run resolved — what a checkpoint is stamped with. */
export interface EmbeddingRunIdentity {
  model: string;
  dimensions: number;
  provider: string;
}

/** The subset of `EmbeddingPipelineResult` the outcome decision reads. */
export interface EmbeddingRunResult {
  nodesProcessed: number;
  chunksProcessed: number;
  failedNodeIds: string[];
}

/** Everything the decision needs beyond the run's own result. */
export interface EmbedRunFinalizeContext {
  /**
   * Embedding rows counted after the final flush; `undefined` ≡ COULD NOT ASK
   * (see `core/embedding-count.ts`). Never a fabricated 0.
   */
  measuredEmbeddings?: number;
  /**
   * The meta currently on disk, re-read immediately before the finalize write.
   * Its `embeddingCheckpoint` is the marker the run's own mid-run checkpoint
   * writer last saved — the recovery evidence the clean-run branch may keep.
   */
  onDisk?: Pick<RepoMeta, 'stats' | 'embeddingCheckpoint'>;
  /**
   * The marker this run RESUMED from, read at job start — not the same object
   * as `onDisk.embeddingCheckpoint`, which the mid-run writer has since
   * overwritten with an `'interrupted'` marker. Carries the attempt chain.
   */
  resumedFrom?: RepoMeta['embeddingCheckpoint'];
}

export interface EmbedRunOutcome {
  /** What to write as `embeddingCheckpoint`; `undefined` ≡ clear it. */
  checkpoint: RepoMeta['embeddingCheckpoint'];
  /** Set ≡ the job must be reported `failed`. */
  error?: string;
  /** Set ≡ the failure is a PARTIAL one; relayed on the job and the SSE payload. */
  partial?: AnalyzeJobPartialOutcome;
}

/** Progress figures a checkpoint records, whoever writes it. */
export interface EmbeddingCheckpointProgress {
  nodesProcessed: number;
  totalNodes: number;
  chunksProcessed: number;
}

/**
 * The marker an IN-FLIGHT run writes — before a bounded write window opens, and
 * again after each LadybugDB checkpoint flush.
 *
 * Always `kind: 'interrupted'`: the run has not finished, so a crash can leave
 * `pendingNodeIds` HALF-persisted. That is what forces resume to delete and
 * regenerate them even when a persisted row carries the current content hash,
 * and to fail closed on an identity mismatch rather than mix vector spaces
 * (repo-manager.ts). No `attempts` — the retry bound applies to `'partial'`
 * markers, whose pending set provably holds zero rows and can be abandoned.
 *
 * Mirrors run-analyze.ts's in-flight `saveEmbeddingCheckpoint` stamp.
 */
export const inFlightEmbeddingCheckpoint = (
  identity: EmbeddingRunIdentity,
  progress: EmbeddingCheckpointProgress,
  pendingNodeIds: string[],
): NonNullable<RepoMeta['embeddingCheckpoint']> => ({
  at: new Date().toISOString(),
  ...progress,
  model: identity.model,
  dimensions: identity.dimensions,
  provider: identity.provider,
  kind: 'interrupted',
  pendingNodeIds,
});

/**
 * Decide the checkpoint + reported outcome for a finished /api/embed run.
 *
 * PARTIAL RUN: the pipeline no longer throws when a sub-batch loses its
 * endpoint — it deletes the affected nodes' rows and names them in
 * `failedNodeIds`. Dropping that receipt made the route clear
 * `embeddingCheckpoint` and mark the job 'complete', so a partial run was
 * indistinguishable from a clean one and the dropped nodes were never retried:
 * a plain `analyze` derives `shouldGenerateEmbeddings: false` once any
 * embeddings exist, so nothing would ever call the pipeline again. So the
 * checkpoint is RETAINED, carrying the dropped ids as `pendingNodeIds` (the
 * next run's `forceReembedNodeIds`), and the run is reported failed — the
 * `AnalyzeJob` status union has no partial member and this is what the pre-#2790
 * throw produced, so a poller keeps seeing "not a clean success". `partial`
 * carries the distinction a client needs without a new status member.
 *
 * CLEAN RUN: clear the checkpoint — with one exception, below.
 */
export const resolveEmbedRunOutcome = (
  identity: EmbeddingRunIdentity,
  result: EmbeddingRunResult,
  context: EmbedRunFinalizeContext = {},
): EmbedRunOutcome => {
  if (result.failedNodeIds.length === 0) {
    // ── Clearing the marker requires PROOF the index is accounted for ──────
    // `stats.embeddings` is the sole input to the next run's
    // `existingEmbeddingCount` → `deriveEmbeddingMode` → `shouldLoadCache`. When
    // the count query did not answer, the route cannot stamp one (a fabricated
    // value is worse than none), so a repo whose recorded count is still 0 —
    // the normal state for one analyzed without embeddings, then embedded
    // through the server — would end this run with NOTHING on disk saying
    // embeddings exist, and the next `analyze --force` would wipe them without
    // loading the cache. Keeping the mid-run marker leaves one durable record.
    // It costs a re-embed of its pending set on the next run and clears itself
    // as soon as any run can measure the table.
    const countIsKnown = context.measuredEmbeddings !== undefined;
    const metaAlreadyRecordsEmbeddings = (context.onDisk?.stats?.embeddings ?? 0) > 0;
    if (countIsKnown || metaAlreadyRecordsEmbeddings) return { checkpoint: undefined };
    return { checkpoint: context.onDisk?.embeddingCheckpoint };
  }

  // ── Bounded retry (#2790) ──────────────────────────────────────────────
  // "Consecutive resume attempts that failed to clear the pending set", exactly
  // as repo-manager.ts defines it and run-analyze.ts Phase 5 computes it: the
  // counter advances only when this run was itself a `'partial'` resume AND at
  // least one node it was asked to clear failed AGAIN. A resume that cleared
  // its set and lost different nodes is a FRESH partial, so the budget resets.
  // Only carried forward here — the cap is enforced on the resume side.
  const resumed = context.resumedFrom;
  const resumedPending = new Set(resumed?.kind === 'partial' ? (resumed.pendingNodeIds ?? []) : []);
  const failedAgain = result.failedNodeIds.some((id) => resumedPending.has(id));

  return {
    checkpoint: {
      at: new Date().toISOString(),
      nodesProcessed: result.nodesProcessed,
      // `nodesProcessed` counts only the COMPLETE nodes, so the walked total is
      // those plus the dropped ones (same reconstruction as run-analyze.ts).
      totalNodes: result.nodesProcessed + result.failedNodeIds.length,
      chunksProcessed: result.chunksProcessed,
      model: identity.model,
      dimensions: identity.dimensions,
      provider: identity.provider,
      // The run COMPLETED and the pipeline already deleted every row of these
      // nodes, so they provably hold zero — which is what lets the resume gate
      // downgrade an identity mismatch to a warning instead of wedging every
      // later run. A mid-run writer stamps `'interrupted'` instead, because its
      // pending set may be half-persisted (repo-manager.ts).
      kind: 'partial',
      attempts: failedAgain ? (resumed?.attempts ?? 0) + 1 : undefined,
      pendingNodeIds: result.failedNodeIds,
    },
    error:
      `Embedding generation finished partially: ${result.failedNodeIds.length} node(s) lost ` +
      'their embeddings to endpoint failures and were dropped. They are checkpointed as ' +
      'pending — run embedding generation again to retry exactly those nodes.',
    partial: {
      kind: 'embedding-partial',
      pendingNodeCount: result.failedNodeIds.length,
      nodesProcessed: result.nodesProcessed,
      retryable: true,
    },
  };
};

/**
 * Fold a MEASURED embedding count into the meta /api/embed is about to save.
 *
 * The /api/embed count omission: this route generated embeddings and wrote
 * `embeddingCheckpoint`, but never `stats.embeddings` — so a repo embedded
 * purely through the server kept whatever count the last CLI `analyze` stamped
 * (0 for a repo analyzed without embeddings). The next CLI run reads that as
 * `existingEmbeddingCount`, `deriveEmbeddingMode` sees `hasExisting: false` and
 * returns `shouldLoadCache: false`, and `analyze --force` then wipes the DB
 * without loading the cache — silently destroying every server-generated
 * embedding.
 *
 * `undefined` ≡ not measured: leave the previous value alone rather than
 * publish a fabricated 0. Wrong-LOW is the dangerous direction — a false 0 is
 * exactly what triggers the wipe above (same reasoning as run-analyze.ts's
 * `persistedEmbeddingCount`).
 */
export const withMeasuredEmbeddingCount = (
  meta: RepoMeta,
  embeddings: number | undefined,
): RepoMeta =>
  embeddings === undefined ? meta : { ...meta, stats: { ...meta.stats, embeddings } };
