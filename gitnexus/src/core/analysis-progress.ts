import type { EmbeddingJobState } from '../storage/embedding-job-journal.js';

export type GraphAnalysisPhase = 'pending' | 'building' | 'ready' | 'failed';

/** Counts describe durable acknowledgements. Active work is part of pending,
 * never an additional category. Totals remain absent before manifest preflight. */
export interface EmbeddingJobProgress {
  phase: 'preparing' | 'embedding' | 'indexing' | 'ready' | 'preserved' | 'failed' | 'unverified';
  totalUnits?: number;
  completedUnits?: number;
  reusedUnits?: number;
  pendingUnits?: number;
  failedUnits?: number;
  activeUnit?: number | null;
  totalNodes?: number;
  completedNodes?: number;
  reusedNodes?: number;
  pendingNodes?: number;
  failedNodes?: number;
  excludedNodes?: number;
  chunks?: number;
}

/** Additive fields shared by CLI callbacks, worker IPC, and HTTP progress. */
export interface AnalysisPhaseProgress {
  graphPhase?: GraphAnalysisPhase;
  embeddingProgress?: EmbeddingJobProgress;
  modelDownloadPercent?: number;
}

const publicEmbeddingProgress = (
  progress: EmbeddingJobProgress | undefined,
): EmbeddingJobProgress | undefined => {
  if (
    !progress ||
    !['preparing', 'embedding', 'indexing', 'ready', 'preserved', 'failed', 'unverified'].includes(
      progress.phase,
    )
  )
    return undefined;
  const safe: EmbeddingJobProgress = { phase: progress.phase };
  // Explicit numeric allowlist: the source may also contain internal paths,
  // identities, credentials, or values that cannot cross JSON IPC.
  for (const key of [
    'totalUnits',
    'completedUnits',
    'reusedUnits',
    'pendingUnits',
    'failedUnits',
    'totalNodes',
    'completedNodes',
    'reusedNodes',
    'pendingNodes',
    'failedNodes',
    'excludedNodes',
    'chunks',
  ] as const) {
    const value = progress[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
  }
  if (
    progress.activeUnit === null ||
    (typeof progress.activeUnit === 'number' &&
      Number.isSafeInteger(progress.activeUnit) &&
      progress.activeUnit >= 0)
  )
    safe.activeUnit = progress.activeUnit;
  return safe;
};

/** The same allowlist protects worker IPC and public progress feeds. */
export function projectAnalysisPhaseProgress(
  progress: AnalysisPhaseProgress | undefined,
): AnalysisPhaseProgress {
  const result: AnalysisPhaseProgress = {};
  if (!progress) return result;
  if (
    progress.graphPhase &&
    ['pending', 'building', 'ready', 'failed'].includes(progress.graphPhase)
  )
    result.graphPhase = progress.graphPhase;
  const embeddingProgress = publicEmbeddingProgress(progress.embeddingProgress);
  if (embeddingProgress) result.embeddingProgress = embeddingProgress;
  if (
    typeof progress.modelDownloadPercent === 'number' &&
    Number.isFinite(progress.modelDownloadPercent) &&
    progress.modelDownloadPercent >= 0 &&
    progress.modelDownloadPercent <= 100
  )
    result.modelDownloadPercent = progress.modelDownloadPercent;
  return result;
}

export function embeddingProgressFromState(state: EmbeddingJobState): EmbeddingJobProgress {
  const excludedNodes = state.excludedNodes === undefined ? 0 : state.excludedNodes;
  const counts = [
    state.totalUnits,
    state.completedUnits,
    state.reusedUnits,
    state.failedUnits,
    state.totalNodes,
    state.completedNodes,
    state.reusedNodes,
    state.failedNodes,
    excludedNodes,
    state.chunks,
  ];
  const pendingUnits =
    state.totalUnits - state.completedUnits - state.reusedUnits - state.failedUnits;
  const pendingNodes =
    state.totalNodes - state.completedNodes - state.reusedNodes - state.failedNodes - excludedNodes;
  const activeUnit = state.active?.start?.unit ?? null;
  if (
    counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    pendingUnits < 0 ||
    pendingNodes < 0 ||
    state.active === undefined ||
    !['embedding', 'indexing', 'ready'].includes(state.phase) ||
    (state.active !== null &&
      (!Number.isSafeInteger(activeUnit) ||
        activeUnit === null ||
        activeUnit < 0 ||
        activeUnit >= state.totalUnits ||
        pendingUnits < 1 ||
        !Number.isSafeInteger(state.active.nodes) ||
        state.active.nodes < 1 ||
        state.active.nodes > pendingNodes)) ||
    (state.phase !== 'embedding' &&
      (pendingUnits ||
        pendingNodes ||
        state.failedUnits ||
        state.failedNodes ||
        state.active !== null))
  ) {
    throw new Error('Embedding progress accounting is unverified');
  }
  return {
    phase: state.phase,
    totalUnits: state.totalUnits,
    completedUnits: state.completedUnits,
    reusedUnits: state.reusedUnits,
    pendingUnits,
    failedUnits: state.failedUnits,
    activeUnit,
    totalNodes: state.totalNodes,
    completedNodes: state.completedNodes,
    reusedNodes: state.reusedNodes,
    pendingNodes,
    failedNodes: state.failedNodes,
    ...(excludedNodes ? { excludedNodes } : {}),
    chunks: state.chunks,
  };
}
