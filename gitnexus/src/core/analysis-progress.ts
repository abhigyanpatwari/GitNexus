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
  chunks?: number;
}

/** Additive fields shared by CLI callbacks, worker IPC, and HTTP progress. */
export interface AnalysisPhaseProgress {
  graphPhase?: GraphAnalysisPhase;
  embeddingProgress?: EmbeddingJobProgress;
  modelDownloadPercent?: number;
}

export function embeddingProgressFromState(state: EmbeddingJobState): EmbeddingJobProgress {
  const counts = [
    state.totalUnits,
    state.completedUnits,
    state.reusedUnits,
    state.failedUnits,
    state.totalNodes,
    state.completedNodes,
    state.reusedNodes,
    state.failedNodes,
    state.chunks,
  ];
  const pendingUnits =
    state.totalUnits - state.completedUnits - state.reusedUnits - state.failedUnits;
  const pendingNodes =
    state.totalNodes - state.completedNodes - state.reusedNodes - state.failedNodes;
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
    chunks: state.chunks,
  };
}
