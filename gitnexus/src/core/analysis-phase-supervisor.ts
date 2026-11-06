/** Filesystem-only handoff from an exit-only graph writer. No model/native imports. */
import path from 'node:path';
import type { RepoMeta } from '../storage/repo-meta.js';
import { requireExclusiveIndexLock } from '../storage/index-lock.js';
import { acquireAnalysisSlotLock } from '../storage/analysis-slot-lock.js';
import { embeddingJobDirectory } from '../storage/embedding-job.js';
import { loadMeta } from '../storage/repo-meta.js';
import {
  publishPreparedAnalysis,
  readPreparedAnalysis,
  type AnalysisPublicationActions,
} from './analysis-publication.js';

export interface AnalysisPhaseTarget {
  repoPath: string;
  storagePath: string;
  metadataDirectory: string;
  repoName: string;
  commit: string;
}

/** Only this bounded receipt crosses IPC; the live graph stays in its child. */
export interface PreparedAnalysisHandoff extends AnalysisPhaseTarget {
  version: 1;
  publicationId: string;
}

export function projectPreparedAnalysisHandoff(value: unknown): PreparedAnalysisHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid prepared analysis handoff');
  const input = value as Record<string, unknown>;
  const text = (name: string, maximum: number, allowEmpty = false): string => {
    const value = input[name];
    if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.length > maximum)
      throw new Error(`Invalid prepared analysis ${name}`);
    return value;
  };
  const projected: PreparedAnalysisHandoff = {
    version: 1,
    publicationId: text('publicationId', 32),
    repoPath: text('repoPath', 32768),
    storagePath: text('storagePath', 32768),
    metadataDirectory: text('metadataDirectory', 32768),
    repoName: text('repoName', 1024),
    commit: text('commit', 64, true),
  };
  if (
    input.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(projected.publicationId) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})?$/.test(projected.commit) ||
    ![projected.repoPath, projected.storagePath, projected.metadataDirectory].every(path.isAbsolute)
  )
    throw new Error('Invalid prepared analysis identity or location');
  return projected;
}

export interface AnalysisPhasePublicationActions extends AnalysisPublicationActions {
  /** Re-resolve checkout placement, current HEAD and the registered name. */
  resolveTarget: () => Promise<AnalysisPhaseTarget>;
  /** Finish registry/shared-store/cache bookkeeping and reader refresh. Called
   * under the ordinary slot lock after native verification and publication.
   * A cancellation after publication must still leave this graph available. */
  finalizeGraph: (metadata: RepoMeta) => Promise<RepoMeta>;
  signal?: AbortSignal;
  log?: (message: string) => void;
  onWaitStart?: () => void;
}

function requireSameTarget(expected: AnalysisPhaseTarget, actual: AnalysisPhaseTarget): void {
  if (
    expected.repoName !== actual.repoName ||
    expected.commit !== actual.commit ||
    (['repoPath', 'storagePath', 'metadataDirectory'] as const).some(
      (key) => path.resolve(expected[key]) !== path.resolve(actual[key]),
    )
  )
    throw new Error(
      'Analysis slot, checkout or registered name changed during the graph handoff; retry before embedding',
    );
}

/** The launcher calls this only after its actual-exit promise resolves. The
 * persisted writer-PID guard independently rejects an early or stale handoff.
 * No borrowed lock: acquire normally, re-resolve under ownership, then finish
 * the exact prepared attempt. An embedding continuation must acquire its own
 * lock and recheck this returned generation before making paid requests. */
export async function publishAnalysisAfterProcessExit(
  handoff: PreparedAnalysisHandoff,
  writerPid: number,
  actions: AnalysisPhasePublicationActions,
): Promise<RepoMeta> {
  const expected = projectPreparedAnalysisHandoff(handoff);
  if (!Number.isSafeInteger(writerPid) || writerPid < 1)
    throw new Error('Missing graph writer PID');
  actions.signal?.throwIfAborted();
  requireSameTarget(expected, await actions.resolveTarget());
  const root = await embeddingJobDirectory(expected.metadataDirectory);
  const lock = await acquireAnalysisSlotLock(root, {
    sweep: false,
    log: actions.log,
    onWaitStart: actions.onWaitStart,
  });
  try {
    requireExclusiveIndexLock(
      lock,
      'Graph publication requires exclusive ownership of its index slot',
    );
    actions.signal?.throwIfAborted();
    requireSameTarget(expected, await actions.resolveTarget());
    const prepared = await readPreparedAnalysis(root);
    if (prepared && (prepared.id !== expected.publicationId || prepared.writerPid !== writerPid))
      throw new Error(
        'Prepared graph attempt changed during handoff; artifacts retained; retry analysis',
      );
    const metadata = prepared
      ? await publishPreparedAnalysis(root, {
          saveMetadata: actions.saveMetadata,
          verify: async (file, metadata) => {
            if (metadata.repoPath !== expected.repoPath || metadata.lastCommit !== expected.commit)
              throw new Error('Prepared graph belongs to a different checkout');
            actions.signal?.throwIfAborted();
            await actions.verify(file, metadata);
            actions.signal?.throwIfAborted();
          },
        })
      : await loadMeta(root);
    // Another waiting writer may recover this exact receipt after the graph
    // child exits. Adopt only the clean, already-published generation.
    if (
      !metadata ||
      metadata.graphGeneration?.id !== expected.publicationId ||
      metadata.repoPath !== expected.repoPath ||
      metadata.lastCommit !== expected.commit ||
      metadata.incrementalInProgress ||
      metadata.graphWriteCollapsed
    )
      throw new Error(
        'Prepared graph attempt changed during handoff; artifacts retained; retry analysis',
      );
    // Once publication starts, complete discoverability even if cancellation
    // arrived during its filesystem operations. Paid work remains inadmissible.
    const finalized = await actions.finalizeGraph(metadata);
    requireSameTarget(expected, await actions.resolveTarget());
    if (
      finalized.graphGeneration?.id !== expected.publicationId ||
      finalized.repoPath !== expected.repoPath ||
      finalized.incrementalInProgress ||
      finalized.graphWriteCollapsed
    )
      throw new Error('Graph finalization did not retain the published generation');
    actions.signal?.throwIfAborted();
    return finalized;
  } finally {
    lock.release();
  }
}
