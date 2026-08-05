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
 * broken" is worse than a missed one.
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
): { expected: number; persisted: number } | undefined {
  // Both sides must be REAL NUMBERS before any comparison. A non-numeric
  // `expected` (a graph implementation that reports no total, a lightweight
  // pipeline result) does not merely skip the guards — it INVERTS them:
  // `undefined < 100` is false, so the min-edges exemption never fires, and
  // `0 >= undefined * 0.5` is `0 >= NaN`, also false, so the ratio check
  // "passes" too and a healthy run is reported as a total collapse. Comparing
  // against a non-number is the one way this check can manufacture the exact
  // false certainty it was written to prevent.
  if (!Number.isFinite(expected) || !Number.isFinite(persisted as number)) return undefined;
  const expectedCount = expected as number;
  const persistedCount = persisted as number;
  if (expectedCount < GRAPH_WRITE_COLLAPSE_MIN_EDGES) return undefined;
  if (persistedCount >= expectedCount * GRAPH_WRITE_COLLAPSE_RATIO) return undefined;
  return { expected: expectedCount, persisted: persistedCount };
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
