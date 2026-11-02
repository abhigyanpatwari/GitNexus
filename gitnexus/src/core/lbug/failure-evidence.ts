import { describeFileEvidence } from './sidecar-recovery.js';
import { readCheckpointActivity, type CheckpointActivity } from './wal-checkpoint-driver.js';

export interface FailureEvidenceTargets {
  /** The live index file. */
  liveIndex: string;
  /** The staging copy this run wrote into; omitted for an in-place build. */
  stagingCopy?: string;
}

/** Sidecars LadybugDB keeps beside a database file (`inspectLbugSidecars`' naming). */
const STAGING_SIDECAR_SUFFIXES = ['.wal', '.shadow', '.wal.checkpoint'] as const;

const formatCheckpointActivity = (activity: CheckpointActivity, now: number): string => {
  const completed =
    activity.lastCompletedAt === null
      ? 'none completed'
      : `${activity.completed} completed, last ${Math.max(0, now - activity.lastCompletedAt)} ms before failure`;
  return `checkpoints: ${completed}, ${activity.inFlight} in flight`;
};

/**
 * The evidence lines (#3530) a classified analyze failure logs, WITHOUT the
 * `Failure evidence — ` prefix (the caller owns presentation). Never throws, and
 * waits at most one file-evidence deadline however many mounts stall.
 *
 * The lines separate three readings of a failed write: the main file is short
 * (the `live index` / `staging copy` sizes), pages are still pending in the
 * staging sidecars (`.wal`, `.shadow`, `.wal.checkpoint` — absent reads
 * `absent`), or GitNexus's own CHECKPOINT ran around the failure (`checkpoints`).
 *
 * `since` is the {@link readCheckpointActivity} snapshot taken when this run
 * began: the counters are process-global, and `analyze --watch` runs analyze
 * repeatedly in one process, so only the difference belongs to the failing run.
 *
 * The checkpoint snapshot is taken before the first `await`. The caller halts the
 * periodic checkpoint driver before calling, so no new tick can checkpoint the
 * staging files while the stats run (async stats rather than `statSync`, which
 * would block the event loop on a stalled mount and could not be timed out).
 */
export const collectFailureEvidence = async (
  targets: FailureEvidenceTargets,
  since: CheckpointActivity,
): Promise<string[]> => {
  const now = Date.now();
  const current = readCheckpointActivity();
  const completed = current.completed - since.completed;
  const activity: CheckpointActivity = {
    completed,
    lastCompletedAt: completed > 0 ? current.lastCompletedAt : null,
    inFlight: current.inFlight,
  };
  const { liveIndex, stagingCopy } = targets;
  const fileLines = await Promise.all([
    describeFileEvidence('live index', liveIndex),
    ...(stagingCopy
      ? [
          describeFileEvidence('staging copy', stagingCopy),
          ...STAGING_SIDECAR_SUFFIXES.map((suffix) =>
            describeFileEvidence(`staging copy ${suffix}`, `${stagingCopy}${suffix}`),
          ),
        ]
      : []),
  ]);
  return [...fileLines, formatCheckpointActivity(activity, now)];
};
