/**
 * What POST /api/embed persists and reports once the embedding pipeline returns.
 *
 * Extracted from api.ts (#2790 review, finding 9): these are pure functions, and
 * reaching them through `await import('../../src/server/api.js')` pulled in
 * Express, cors, the LadybugDB native adapter and the whole MCP wiring — one
 * measured run of the test file TIMED OUT at 30s and the two that passed took
 * ~20s and ~22s. Nothing here imports the database, MCP or Express.
 *
 * This module ROUTES that decision onto the route's meta write and job status;
 * it does not author the checkpoint record. Minting and the resume rules live in
 * `core/embedding-checkpoint.ts`, shared with the CLI's Phase 5, so the two
 * writers of one field cannot drift apart again.
 */

import type { RepoMeta } from '../storage/repo-manager.js';
import { mintPartialCheckpoint, type EmbeddingRunIdentity } from '../core/embedding-checkpoint.js';
import {
  resolvePersistedEmbeddingCount,
  type PersistedEmbeddingCount,
} from '../core/embedding-count.js';
import type { AnalyzeJobPartialOutcome } from './analyze-job.js';

export type { EmbeddingRunIdentity };

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

/**
 * Decide the checkpoint + reported outcome for a finished /api/embed run.
 *
 * PARTIAL RUN: the pipeline no longer throws when a sub-batch loses its
 * endpoint — it deletes the affected nodes' rows and names them in
 * `failedNodeIds`. Dropping that receipt made the route clear
 * `embeddingCheckpoint` and mark the job 'complete', and the dropped nodes were
 * then never retried: a plain `analyze` derives `shouldGenerateEmbeddings:
 * false` once any embeddings exist, so nothing would ever call the pipeline
 * again. So the checkpoint is RETAINED, carrying the dropped ids as
 * `pendingNodeIds` (the next run's `forceReembedNodeIds`), and the run is
 * reported failed — the `AnalyzeJob` status union has no partial member and this
 * is what the pre-#2790 throw produced, so a poller keeps seeing "not a clean
 * success". `partial` carries the distinction a client needs without a new
 * status member.
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
    // When the count query did not answer, the route cannot stamp
    // `stats.embeddings` (a fabricated value is worse than none — see
    // `core/embedding-count.ts`), so a repo whose recorded count is still 0
    // would end this run with NOTHING on disk saying embeddings exist. Keeping
    // the mid-run marker leaves one durable record. It costs a re-embed of its
    // pending set on the next run and clears itself as soon as any run can
    // measure the table.
    const countIsKnown = context.measuredEmbeddings !== undefined;
    const metaAlreadyRecordsEmbeddings = (context.onDisk?.stats?.embeddings ?? 0) > 0;
    if (countIsKnown || metaAlreadyRecordsEmbeddings) return { checkpoint: undefined };
    return { checkpoint: context.onDisk?.embeddingCheckpoint };
  }

  return {
    // `'partial'` + the attempt-chain rule are the minter's (#2790).
    checkpoint: mintPartialCheckpoint(identity, result, context.resumedFrom),
    error:
      `Embedding generation finished partially: ${result.failedNodeIds.length} node(s) lost ` +
      'their embeddings to endpoint failures and were dropped. They are checkpointed as ' +
      'pending — run embedding generation again to retry exactly those nodes.',
    partial: {
      kind: 'embedding-partial',
      pendingNodeCount: result.failedNodeIds.length,
      nodesProcessed: result.nodesProcessed,
    },
  };
};

/** A write that did not even ask — folded exactly like a failed measurement. */
const UNMEASURED: PersistedEmbeddingCount = {
  kind: 'unknown',
  reason: 'this write measured nothing',
};

/**
 * Fold a measurement into the meta /api/embed is about to save.
 *
 * The /api/embed count omission: this route generated embeddings and wrote
 * `embeddingCheckpoint`, but never `stats.embeddings` — so a repo embedded
 * purely through the server kept whatever count the last CLI `analyze` stamped
 * (0 for a repo analyzed without embeddings), and the next `analyze --force`
 * wiped every server-generated embedding.
 *
 * The carry-forward itself is `resolvePersistedEmbeddingCount`'s, not this
 * module's: the CLI publishes the same field, and "unknown ⇒ carry forward,
 * never fabricate 0" only holds if both publishers ask the same function
 * (core/embedding-count.ts).
 */
export const withMeasuredEmbeddingCount = (
  meta: RepoMeta,
  /** `undefined` ≡ this write measured nothing (e.g. the window-start save). */
  measured: PersistedEmbeddingCount | undefined,
): RepoMeta => {
  const embeddings = resolvePersistedEmbeddingCount(measured ?? UNMEASURED, meta.stats?.embeddings);
  return embeddings === undefined ? meta : { ...meta, stats: { ...meta.stats, embeddings } };
};
