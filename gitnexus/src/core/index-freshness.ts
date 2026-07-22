import type { RepoMeta } from '../storage/repo-manager.js';

export const INDEX_INCOMPLETE_REASONS = [
  'incremental-in-progress',
  'embedding-checkpoint-pending',
] as const;

export type IndexIncompleteReason = (typeof INDEX_INCOMPLETE_REASONS)[number];

/** Stable machine-readable reasons an index cannot be certified complete. */
export function getIndexIncompleteReasons(
  meta: Pick<RepoMeta, 'incrementalInProgress' | 'embeddingCheckpoint'> | null | undefined,
): IndexIncompleteReason[] {
  const reasons: IndexIncompleteReason[] = [];
  if (meta?.incrementalInProgress) reasons.push('incremental-in-progress');
  if (meta?.embeddingCheckpoint) reasons.push('embedding-checkpoint-pending');
  return reasons;
}
