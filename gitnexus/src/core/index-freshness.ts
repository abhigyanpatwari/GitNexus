import { checkpointKind } from './embedding-checkpoint.js';
import type { RepoMeta } from '../storage/repo-manager.js';

export const INDEX_INCOMPLETE_REASONS = [
  'incremental-in-progress',
  'embedding-checkpoint-pending',
  'embedding-count-unverified',
  'graph-write-collapsed',
] as const;

export type IndexIncompleteReason = (typeof INDEX_INCOMPLETE_REASONS)[number];

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
