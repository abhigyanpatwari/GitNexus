/**
 * The single owner of `RepoMeta.embeddingCheckpoint` — how it is minted, and
 * how a run decides what to do with one it finds.
 *
 * This module exists for the reason `embedding-count.ts` next door exists, and
 * for a sharper one. A review of #2790 found that two hand-copied bodies of
 * "measure the embedding count" had drifted inside a single change; the fix for
 * that then created a SECOND pair of hand-copied publishers — of this record —
 * and they had already drifted too: the CLI armed the attempt counter only
 * after clearing its identity gate, the server derived it from the resumed
 * marker alone. Worse, only one of the two READERS implemented `kind` at all,
 * so a `'partial'` marker written by `gitnexus analyze` and resumed through
 * `POST /api/embed` hit exactly the permanent wedge `kind` was introduced to
 * remove. Prose promising two sites stay in step is not a mechanism. This is.
 *
 * Same tier as {@link ./embedding-count.ts} and {@link ./embedding-mode.ts}:
 * type-only imports, no native dependencies, so `run-analyze.ts` can import it
 * statically without dragging an embeddings module in (#2370) and `server/`
 * can import it too.
 */

import type { RepoMeta } from '../storage/repo-manager.js';

export type EmbeddingCheckpoint = NonNullable<RepoMeta['embeddingCheckpoint']>;
export type EmbeddingCheckpointKind = NonNullable<EmbeddingCheckpoint['kind']>;

export interface EmbeddingRunIdentity {
  model: string;
  dimensions: number;
  provider: string;
}

export interface EmbeddingCheckpointProgress {
  nodesProcessed: number;
  totalNodes: number;
  chunksProcessed: number;
}

/**
 * How many consecutive resume attempts may fail to clear a `'partial'` pending
 * set before it is abandoned.
 *
 * Not a fresh guess: it is this repo's existing per-operation retry budget —
 * the HTTP embedder spends `HTTP_MAX_RETRIES + 1 === 3` per request and the WAL
 * driver `CHECKPOINT_RETRY_ATTEMPTS === 3` per flush. Each attempt here is a
 * whole analyze invocation with those budgets nested underneath, so 3 is
 * already generous while still converging within a day of ordinary committing.
 */
export const EMBEDDING_RESUME_MAX_ATTEMPTS = 3;

/**
 * The one home for the back-compat default. Markers written before #2790's
 * follow-up carry no `kind`, and they must keep the stricter behavior — an
 * implicit default scattered across read sites is precisely how the two
 * readers came to disagree.
 */
export const checkpointKind = (checkpoint: EmbeddingCheckpoint): EmbeddingCheckpointKind =>
  checkpoint.kind ?? 'interrupted';

/** Pending-node count, tolerating the field's optionality. */
export const pendingNodeCount = (checkpoint: EmbeddingCheckpoint): number =>
  checkpoint.pendingNodeIds?.length ?? 0;

/**
 * The attempt-chain rule, which is the subtlest thing here and was the part
 * that had already diverged.
 *
 * The counter advances only when this run resumed a `'partial'` marker AND at
 * least one node it was handed failed AGAIN. A resume that cleared its set but
 * lost *different* nodes is a FRESH partial, so the budget resets — otherwise a
 * steadily-flaky endpoint would exhaust the budget on nodes that were never the
 * problem. `undefined` rather than `0` when the streak breaks, so a clean
 * marker serializes without the field.
 */
export const nextAttemptCount = (
  resumedFrom: EmbeddingCheckpoint | undefined,
  failedNodeIds: readonly string[],
): number | undefined => {
  if (resumedFrom === undefined || checkpointKind(resumedFrom) !== 'partial') return undefined;
  const resumedPending = new Set(resumedFrom.pendingNodeIds ?? []);
  const failedAgain = failedNodeIds.some((id) => resumedPending.has(id));
  return failedAgain ? (resumedFrom.attempts ?? 0) + 1 : undefined;
};

/**
 * Mint the marker written BEFORE a bounded write window opens.
 *
 * `'interrupted'`: if the process dies inside the window these nodes may hold a
 * subset of their chunks, which is what forces resume to delete and regenerate
 * them even when a persisted row carries the current content hash — and what
 * makes an identity mismatch fail closed rather than mix vector spaces. No
 * `attempts`: the retry bound belongs to `'partial'`, whose pending set
 * provably holds zero rows and can therefore be abandoned safely.
 */
export const mintInterruptedCheckpoint = (
  identity: EmbeddingRunIdentity,
  progress: EmbeddingCheckpointProgress,
  pendingNodeIds: string[],
  at: string = new Date().toISOString(),
): EmbeddingCheckpoint => ({
  at,
  ...progress,
  model: identity.model,
  dimensions: identity.dimensions,
  provider: identity.provider,
  kind: 'interrupted',
  pendingNodeIds,
});

/**
 * Mint the marker written AFTER a run that completed while dropping nodes.
 *
 * `totalNodes` is reconstructed as complete + dropped, because `nodesProcessed`
 * counts only the nodes that finished with a full row set. It feeds the resume
 * log line and nothing else.
 */
export const mintPartialCheckpoint = (
  identity: EmbeddingRunIdentity,
  result: { nodesProcessed: number; chunksProcessed: number; failedNodeIds: string[] },
  resumedFrom: EmbeddingCheckpoint | undefined,
  at: string = new Date().toISOString(),
): EmbeddingCheckpoint => ({
  at,
  nodesProcessed: result.nodesProcessed,
  totalNodes: result.nodesProcessed + result.failedNodeIds.length,
  chunksProcessed: result.chunksProcessed,
  model: identity.model,
  dimensions: identity.dimensions,
  provider: identity.provider,
  kind: 'partial',
  attempts: nextAttemptCount(resumedFrom, result.failedNodeIds),
  pendingNodeIds: result.failedNodeIds,
});

/**
 * Mint the marker written when a run finished but its embedding count could not
 * be verified.
 *
 * A third state, and it needs its own `kind` rather than borrowing `'partial'`:
 * its pending set is EMPTY. Nothing was dropped and nothing needs re-embedding
 * — the marker exists only to defeat the same-commit fast return so the next
 * run re-derives a count, because clearing it while `stats.embeddings` still
 * reads a stale zero is what arms a later `--force` to wipe live embeddings.
 * Stamping it `'partial'` made `gitnexus status` tell the operator that N nodes
 * had lost their embeddings, where N is zero.
 */
export const mintUnverifiedCountCheckpoint = (
  identity: EmbeddingRunIdentity,
  progress: EmbeddingCheckpointProgress,
  at: string = new Date().toISOString(),
): EmbeddingCheckpoint => ({
  at,
  ...progress,
  model: identity.model,
  dimensions: identity.dimensions,
  provider: identity.provider,
  kind: 'unverified-count',
  pendingNodeIds: [],
});

export type EmbeddingResumeDecision =
  /** An explicit flag cleared it; nothing to resume. */
  | { readonly action: 'discard'; readonly log: string }
  /**
   * Keep running, but abandon the pending set — either the retry budget is
   * spent, or the marker was written by a different embedding identity whose
   * nodes provably hold zero rows so nothing is at risk.
   */
  | { readonly action: 'abandon'; readonly log: string }
  /** Resume: regenerate `pendingNodeIds` under the matching identity. */
  | {
      readonly action: 'resume';
      readonly log: string;
      readonly pendingNodeIds: ReadonlySet<string>;
      readonly resumedFrom: EmbeddingCheckpoint;
    }
  /** Fail closed: a half-written window under a foreign identity. */
  | { readonly action: 'abort'; readonly error: string };

/**
 * The one implementation of "what should this run do with the checkpoint it
 * found", shared by the CLI resume gate and `POST /api/embed`.
 *
 * Callers resolve the embedding identity lazily and pass it only when they need
 * a verdict beyond the flag checks — resolving it is not free, and the flag
 * paths short-circuit before it is needed. Pass `identity: undefined` to get
 * just those; a decision that requires an identity returns `'resume'` only when
 * one was supplied and matched.
 */
export const decideEmbeddingResume = (
  checkpoint: EmbeddingCheckpoint,
  identity: EmbeddingRunIdentity | undefined,
  options: {
    force?: boolean;
    dropEmbeddings?: boolean;
    maxAttempts?: number;
  } = {},
): EmbeddingResumeDecision => {
  const kind = checkpointKind(checkpoint);
  const pending = pendingNodeCount(checkpoint);
  const maxAttempts = options.maxAttempts ?? EMBEDDING_RESUME_MAX_ATTEMPTS;

  if (options.dropEmbeddings) {
    return { action: 'discard', log: 'Discarding the embedding checkpoint (--drop-embeddings).' };
  }
  if (options.force) {
    return {
      action: 'discard',
      log:
        'Discarding the embedding checkpoint (--force)' +
        `${pending > 0 ? ` and its ${pending} pending node(s)` : ''}; this run rebuilds from ` +
        'scratch. Pass --embeddings to regenerate them explicitly.',
    };
  }
  // Only the 'unverified-count' marker may skip the identity gate. Its pending
  // set is empty BY DEFINITION and it exists purely to force a fresh count, so
  // there is nothing a foreign embedding identity could corrupt.
  //
  // An empty pending set alone must NOT take this path. `onCheckpoint` mints an
  // 'interrupted' marker with `pendingNodeIds: []` after every post-window
  // save, and legacy markers may omit the field entirely — so keying on
  // emptiness would silently clear an interrupted marker under a foreign
  // provider instead of failing closed, which is exactly the vector-space
  // mixing the 'interrupted' kind exists to prevent.
  if (kind === 'unverified-count') {
    return {
      action: 'abandon',
      log: 'Re-deriving the embedding count left unverified by the previous run.',
    };
  }
  if (kind === 'partial' && (checkpoint.attempts ?? 0) >= maxAttempts) {
    return {
      action: 'abandon',
      log:
        `Warning: ${pending} node(s) failed to embed on ${checkpoint.attempts} consecutive ` +
        'resume attempts and are being abandoned (#2790). The index is registered without ' +
        'them; `gitnexus status` stops reporting it as incomplete. Re-run ' +
        '`gitnexus analyze --embeddings --force` once the embedding endpoint accepts them.',
    };
  }
  if (identity === undefined) {
    return {
      action: 'abort',
      error: 'Cannot resume embedding checkpoint: no embedding identity was resolved.',
    };
  }

  const providerDiffers = checkpoint.provider !== identity.provider;
  const identityDiffers =
    providerDiffers ||
    checkpoint.model !== identity.model ||
    checkpoint.dimensions !== identity.dimensions;

  if (identityDiffers && kind !== 'interrupted') {
    // Those nodes hold zero rows, so there is no vector space to mix. Throwing
    // here is what turned an exit-0 partial run into a permanent wedge: a hook
    // or CI job without the endpoint's env vars resolves `provider: 'local'`,
    // mismatches, and dies before any phase runs.
    return {
      action: 'abandon',
      log:
        `Warning: dropping ${pending} pending node(s) from a ${kind} embedding checkpoint: it ` +
        `was written by a different embedding configuration (${checkpoint.model} at ` +
        `${checkpoint.dimensions} dimensions) than this run resolves (${identity.model} at ` +
        `${identity.dimensions}). Those nodes hold no embedding rows, so nothing is lost that ` +
        'a later `--embeddings` run cannot regenerate.',
    };
  }
  if (providerDiffers) {
    return {
      action: 'abort',
      error:
        'Cannot resume embedding checkpoint: the embedding provider configuration differs. ' +
        'Restore the matching endpoint configuration or pass --drop-embeddings to rebuild without it.',
    };
  }
  if (identityDiffers) {
    return {
      action: 'abort',
      error:
        `Cannot resume embedding checkpoint: it uses ${checkpoint.model} at ` +
        `${checkpoint.dimensions} dimensions, but this run resolves ${identity.model} at ` +
        `${identity.dimensions}. Restore the matching embedding configuration or pass ` +
        '--drop-embeddings to rebuild without it.',
    };
  }
  // Reached with an EMPTY pending set too — an 'interrupted' marker written by
  // a post-window save names none. That still resumes rather than clearing:
  // the marker's presence is what forces embedding generation on a run that
  // would otherwise derive `shouldGenerateEmbeddings: false`, and it has now
  // cleared the identity gate, so resuming is safe.
  return {
    action: 'resume',
    log:
      `Previous analyze ended at an embedding checkpoint (${checkpoint.nodesProcessed}/` +
      `${checkpoint.totalNodes} nodes); resuming from persisted hashes` +
      `${pending > 0 ? ` and regenerating ${pending} pending node(s)` : ''}.`,
    pendingNodeIds: new Set(checkpoint.pendingNodeIds ?? []),
    resumedFrom: checkpoint,
  };
};
