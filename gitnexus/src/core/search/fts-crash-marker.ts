/**
 * FTS-phase dirty-flag policy (KTD4 / KTD6).
 *
 * A native abort during CREATE_FTS_INDEX kills the process before JS can
 * persist a skip reason. The next run infers `native-abort` from this phase
 * value. Tests induce the flag through saveMeta — they cannot be a green
 * real-abort of analyze.
 */
import type { RepoMeta } from '../../storage/repo-meta.js';

export const FTS_DIRTY_PHASE = 'fts' as const;

export type FtsWritePlan = 'in-place' | 'staging';

export type IncrementalDirtyState = NonNullable<RepoMeta['incrementalInProgress']>;

export const resolveFtsWritePlan = (buildPath: string, livePath: string): FtsWritePlan =>
  buildPath === livePath ? 'in-place' : 'staging';

export const shouldStampFtsDirtyPhase = (writePlan: FtsWritePlan): boolean =>
  writePlan === 'in-place';

/** Staging throws (abandons the unpublished file). In-place is best-effort. */
export const isBoundaryCheckpointFatal = (writePlan: FtsWritePlan): boolean =>
  writePlan === 'staging';

export const isFtsDirtyPhase = (
  dirty: RepoMeta['incrementalInProgress'] | undefined,
): dirty is IncrementalDirtyState & { phase: typeof FTS_DIRTY_PHASE } =>
  dirty?.phase === FTS_DIRTY_PHASE;

/** Half-written graph still blocks `--repair-fts`. An FTS-phase crash does not. */
export const shouldRefuseRepairFtsWhileDirty = (
  dirty: RepoMeta['incrementalInProgress'] | undefined,
): boolean => dirty != null && !isFtsDirtyPhase(dirty);

export const inferNativeAbortSkip = (
  dirty: RepoMeta['incrementalInProgress'] | undefined,
): boolean => isFtsDirtyPhase(dirty);

export const buildFtsDirtyStamp = (args: {
  prior?: IncrementalDirtyState;
  now?: number;
  writePlan: 'in-place';
  checkpointSucceeded: boolean;
}): IncrementalDirtyState => {
  const now = args.now ?? Date.now();
  const prior = args.prior;
  return {
    startedAt: prior?.startedAt ?? now,
    updatedAt: now,
    toWriteCount: prior?.toWriteCount ?? 0,
    phase: FTS_DIRTY_PHASE,
    writePlan: args.writePlan,
    checkpointSucceeded: args.checkpointSucceeded,
    ...(prior?.directWriteCount !== undefined ? { directWriteCount: prior.directWriteCount } : {}),
    ...(prior?.importerExpansion !== undefined
      ? { importerExpansion: prior.importerExpansion }
      : {}),
    ...(prior?.effectiveWriteCount !== undefined
      ? { effectiveWriteCount: prior.effectiveWriteCount }
      : {}),
    ...(prior?.deleteCount !== undefined ? { deleteCount: prior.deleteCount } : {}),
    ...(prior?.shadowSeedCount !== undefined ? { shadowSeedCount: prior.shadowSeedCount } : {}),
    ...(prior?.droppedImporterChunks !== undefined
      ? { droppedImporterChunks: prior.droppedImporterChunks }
      : {}),
  };
};
