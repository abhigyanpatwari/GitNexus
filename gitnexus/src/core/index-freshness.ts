import { checkpointKind } from './embedding-checkpoint.js';
import type { RepoMeta } from '../storage/repo-manager.js';

export const INDEX_INCOMPLETE_REASONS = [
  'incremental-in-progress',
  'embedding-checkpoint-pending',
  'embedding-count-unverified',
  'graph-write-collapsed',
] as const;

export type IndexIncompleteReason = (typeof INDEX_INCOMPLETE_REASONS)[number];

/**
 * Fraction of the pipeline's relationship count that must survive into the DB
 * before the write counts as collapsed. Deliberately generous: this detects
 * "most of the graph did not persist" (the reported case lost ~91%), not a
 * per-edge reconciliation.
 */
export const GRAPH_WRITE_COLLAPSE_RATIO = 0.5;

/**
 * Below this many relationships the ratio is meaningless — a handful of edges
 * lost to legitimate filtering would trip it — so small repos are exempt.
 */
export const GRAPH_WRITE_COLLAPSE_MIN_EDGES = 100;

/** Why {@link detectGraphWriteCollapse} could reach no verdict at all. */
export type GraphWriteCollapseUnmeasurableReason =
  /** The pipeline's own total was not a usable number (or was zero). */
  | 'expected-unavailable'
  /** The DB-side count could not be READ — a query that threw, no connection. */
  | 'persisted-unreadable'
  /** Set by the CALLER: an incremental write persists only the changed
   *  subgraph, so whole-scope counts are not comparable to it. */
  | 'incremental-write';

/**
 * The three outcomes of the collapse check, kept APART because two of them used
 * to share `undefined` and the conflation erased a stamp recording real,
 * unrepaired edge loss.
 *
 * `'healthy'` is a POSITIVE all-clear — the counts were both taken and enough
 * rows persisted — and is the only outcome that licenses clearing a previous
 * `graph-write-collapsed` stamp. `'unmeasurable'` says the comparison never
 * happened; the previous stamp must survive it, because nothing has repaired
 * whatever it recorded.
 */
export type GraphWriteCollapseVerdict =
  | { verdict: 'collapsed'; expected: number; persisted: number }
  | { verdict: 'healthy' }
  | { verdict: 'unmeasurable'; reason: GraphWriteCollapseUnmeasurableReason };

/**
 * Decide whether a finished write collapsed, comparing what the pipeline
 * produced against what the DB hands back.
 *
 * A RATIO, not equality: some relationship types do not round-trip one-for-one
 * and `--pdg` writes MORE rows into the same table, so demanding equality would
 * fire on healthy runs. Only a collapse is a defect.
 *
 * FAIL-SAFE at `expected === 0`: an implementation that offloads relationships
 * out of memory may not be able to report a total, and a false "your index is
 * broken" is worse than a missed one. That case is `'unmeasurable'`, NOT
 * `'healthy'` — nothing was compared, so nothing was cleared.
 *
 * Returns a THREE-WAY verdict rather than `{...} | undefined`. The absent value
 * meant both "measured, fine" and "could not measure", and the caller — which
 * decides whether to keep or erase the persisted `graph-write-collapsed` stamp —
 * cannot tell those apart from a shared `undefined`. It guessed by write mode
 * instead, so a full run whose structural count threw took the
 * "no collapse ⇒ clear it" branch and deleted a stamp recording real loss.
 */
export function detectGraphWriteCollapse(
  expected: number,
  /**
   * Relationships readable from the DB, or `undefined` when the count could
   * not be READ at all (no connection, a query that threw).
   *
   * The distinction is load-bearing and was got wrong once: `getLbugStats`
   * reports `edges: 0` for "no connection", "query threw" AND "empty table"
   * alike, so passing it straight in made every run without a readable DB look
   * like a total collapse. An unmeasurable count is not a measured zero —
   * accepting `undefined` here is what keeps this check from committing the
   * same confident-zero error it exists to catch.
   */
  persisted: number | undefined,
): GraphWriteCollapseVerdict {
  // Both sides must be REAL NUMBERS before any comparison. A non-numeric
  // `expected` (a graph implementation that reports no total, a lightweight
  // pipeline result) does not merely skip the guards — it INVERTS them:
  // `undefined < 100` is false, so the min-edges exemption never fires, and
  // `0 >= undefined * 0.5` is `0 >= NaN`, also false, so the ratio check
  // "passes" too and a healthy run is reported as a total collapse. Comparing
  // against a non-number is the one way this check can manufacture the exact
  // false certainty it was written to prevent.
  if (!Number.isFinite(expected)) {
    return { verdict: 'unmeasurable', reason: 'expected-unavailable' };
  }
  if (typeof persisted !== 'number' || !Number.isFinite(persisted)) {
    return { verdict: 'unmeasurable', reason: 'persisted-unreadable' };
  }
  const expectedCount = expected;
  const persistedCount = persisted;
  // FAIL-SAFE, and `'unmeasurable'` rather than `'healthy'`: a zero expectation
  // is the documented "could not report a total" case, not evidence the write
  // went well. Reporting it as an all-clear would let a run that measured
  // nothing erase a stamp recording a previous run's real loss.
  if (expectedCount === 0) {
    return { verdict: 'unmeasurable', reason: 'expected-unavailable' };
  }
  // A TOTAL loss is never small enough to excuse. The min-edges exemption
  // exists for "a handful of edges lost to legitimate filtering", which its own
  // docstring says — it does not describe a persisted count of zero. Evaluated
  // before the exemption because the exemption looked only at `expected`:
  // `expected = 99, persisted = 0` lost every single edge and still returned
  // no verdict, leaving the metadata fresh and the CLI reporting success.
  if (expectedCount > 0 && persistedCount === 0) {
    return { verdict: 'collapsed', expected: expectedCount, persisted: persistedCount };
  }
  // The small-repo exemption and the cleared ratio are both `'healthy'`, not
  // `'unmeasurable'`: both counts WERE taken, and the comparison ran. Calling
  // the exemption a non-verdict would make a stamp unclearable on any repo that
  // shrank below the threshold — a permanent forced-rebuild wedge, which is the
  // failure this taxonomy exists to avoid rather than to relocate.
  if (expectedCount < GRAPH_WRITE_COLLAPSE_MIN_EDGES) return { verdict: 'healthy' };
  if (persistedCount >= expectedCount * GRAPH_WRITE_COLLAPSE_RATIO) return { verdict: 'healthy' };
  return { verdict: 'collapsed', expected: expectedCount, persisted: persistedCount };
}

/** Stable machine-readable reasons an index cannot be certified complete. */
export function getIndexIncompleteReasons(
  meta:
    | Pick<RepoMeta, 'incrementalInProgress' | 'embeddingCheckpoint' | 'graphWriteCollapsed'>
    | null
    | undefined,
): IndexIncompleteReason[] {
  const reasons: IndexIncompleteReason[] = [];
  if (meta?.incrementalInProgress) reasons.push('incremental-in-progress');
  // The run finished and wrote metadata, but far fewer edges reached the DB
  // than the pipeline produced — the "refresh reported success, the index is
  // unusable" failure. Without this the index reads as fresh and every tool
  // answers from a graph missing most of its edges, which is indistinguishable
  // from a codebase that genuinely has no such relationships.
  if (meta?.graphWriteCollapsed) reasons.push('graph-write-collapsed');
  if (meta?.embeddingCheckpoint) {
    // The three checkpoint kinds are not one operator-facing state. GUARDRAILS
    // and the runbook document `embedding-checkpoint-pending` as "N node(s)
    // lost their embeddings to endpoint failures" — true for 'interrupted' and
    // 'partial', a lie for 'unverified-count', whose pending set is empty and
    // whose only defect is a count nobody could measure (see the `kind` doc in
    // repo-manager.ts).
    reasons.push(
      checkpointKind(meta.embeddingCheckpoint) === 'unverified-count'
        ? 'embedding-count-unverified'
        : 'embedding-checkpoint-pending',
    );
  }
  return reasons;
}
