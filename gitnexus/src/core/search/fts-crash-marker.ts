/**
 * FTS-phase dirty-flag policy (KTD4 / KTD6).
 *
 * A native abort during CREATE_FTS_INDEX kills the process before JS can
 * persist a skip reason. The next run infers `native-abort` from this phase
 * value, or from a persisted `capabilities.fts.skipReason` of `native-abort`
 * after recovery clears the dirty flag. Tests induce the flag through
 * saveMeta — they cannot be a green real-abort of analyze.
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

/**
 * Half-written graph, or FTS-phase without a successful checkpoint, blocks
 * `--repair-fts`. FTS-phase + `checkpointSucceeded === true` is admitted
 * (in-place or staging). Staging still must not park.
 */
export const shouldRefuseRepairFtsWhileDirty = (
  dirty: RepoMeta['incrementalInProgress'] | undefined,
): boolean => dirty != null && (!isFtsDirtyPhase(dirty) || dirty.checkpointSucceeded !== true);

export const inferNativeAbortSkip = (
  dirty: RepoMeta['incrementalInProgress'] | undefined,
  skipReason?: string,
): boolean => isFtsDirtyPhase(dirty) || skipReason === 'native-abort';

/**
 * KTD5 conjunctive warrant for parking a live WAL: FTS phase, in-place
 * write plan (Windows full rebuild, POSIX incremental, escalated-in-place),
 * and a successful graph-boundary checkpoint. Staging never qualifies —
 * the live index next to an unpublished staging file must keep its WAL.
 */
export const allowsFtsCrashWalPark = (
  dirty: RepoMeta['incrementalInProgress'] | undefined,
): boolean =>
  isFtsDirtyPhase(dirty) && dirty.writePlan === 'in-place' && dirty.checkpointSucceeded === true;

export const isInPlaceFtsDirty = (
  dirty: RepoMeta['incrementalInProgress'] | undefined,
): dirty is IncrementalDirtyState & { phase: typeof FTS_DIRTY_PHASE; writePlan: 'in-place' } =>
  isFtsDirtyPhase(dirty) && dirty.writePlan === 'in-place';

/** Persisted FTS capability fields used as crash evidence after the dirty flag is cleared. */
export type PersistedFtsCrashEvidence = {
  skipReason?: string;
  writePlan?: FtsWritePlan;
};

export const hasRecoveredInPlaceFtsAbort = (fts: PersistedFtsCrashEvidence | undefined): boolean =>
  fts?.skipReason === 'native-abort' && fts.writePlan === 'in-place';

/**
 * Reader / `--repair-fts` refuse-or-park warrant. Any in-place FTS dirty
 * flag is enough — a failed graph-boundary checkpoint still leaves CREATE
 * able to abort with a live WAL. After persist clears the flag, a
 * `native-abort` skip plus persisted `writePlan: 'in-place'` is the same
 * evidence. Staging persist also writes `native-abort` and must not match.
 */
export const shouldRefuseFtsCrashWal = (
  dirty: RepoMeta['incrementalInProgress'] | undefined,
  fts?: PersistedFtsCrashEvidence,
): boolean => isInPlaceFtsDirty(dirty) || hasRecoveredInPlaceFtsAbort(fts);

export const isFtsStagingDirty = (dirty: RepoMeta['incrementalInProgress'] | undefined): boolean =>
  isFtsDirtyPhase(dirty) && dirty.writePlan === 'staging';

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
