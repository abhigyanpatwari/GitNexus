/**
 * Analyze-worker IPC message protocol — the shapes that cross the
 * `child_process.fork()` boundary between `analyze-launch.ts` (parent) and
 * `analyze-worker.ts` (child).
 *
 * This module exists so the protocol has a home that neither participant sits
 * downstream of. The types previously lived in `analyze-worker.ts`, the fork
 * ENTRY module — which meant `analyze-worker-core.ts` (the entry's own
 * side-effect-free core) had to import them back from the entry, forming an
 * `analyze-worker ⇄ analyze-worker-core` import cycle. The edge was type-only
 * and therefore erased at runtime, but it still made the entry module a
 * dependency of its own core in every static reader of the graph (bundlers,
 * cycle detectors, `gitnexus check`).
 *
 * Declarations only — no values, no imports of anything that holds a value at
 * runtime. Every consumer reaches this module through `import type`, so the
 * emitted `analyze-worker-protocol.js` is never loaded by the running worker.
 * That matters here specifically: `analyze-worker.ts` is spawned by path from
 * build output (`dist/server/analyze-worker.js`, see `analyze-launch.ts`), so a
 * module-resolution mistake in this directory surfaces as a worker that never
 * sends `ready`, not as a compile error.
 *
 * `analyze-worker.ts` re-exports the child→parent types so existing import
 * sites (`analyze-launch.ts`, tests) keep working unchanged.
 */
import type { AnalyzeOptions } from '../core/run-analyze.js';
import type { AnalysisPhaseProgress } from '../core/analysis-progress.js';
import type { AnalyzeResultIpc } from './analyze-worker-ipc.js';
import type { PreparedAnalysisHandoff } from '../core/analysis-phase-supervisor.js';

/** Parent → child: start one analysis run. */
export interface StartMessage {
  type: 'start';
  repoPath: string;
  options: AnalyzeOptions;
}

/** A new process may continue only after the graph writer actually exited. */
export interface ContinueMessage {
  type: 'continue';
  repoPath: string;
  options: AnalyzeOptions;
  writerPid: number;
  prepared: GraphPreparedMessage;
}

export interface GraphVisibleMessage {
  type: 'graph-visible';
}

/** Parent → child: request safe cancellation at the next JS-visible checkpoint. */
export interface CancelMessage {
  type: 'cancel';
}

export type ParentMessage = StartMessage | ContinueMessage | CancelMessage | GraphVisibleMessage;

export interface ProgressMessage extends AnalysisPhaseProgress {
  type: 'progress';
  phase: string;
  percent: number;
  message: string;
}

export interface CompleteMessage {
  type: 'complete';
  // JSON-safe projection (no `pipelineResult` / live KnowledgeGraph). This
  // channel is default-JSON child_process IPC — see analyze-worker-ipc.ts.
  result: AnalyzeResultIpc;
}

/** Nonterminal: the graph process still owns its native allocations. */
export interface GraphPreparedMessage {
  type: 'graph-prepared';
  handoff: PreparedAnalysisHandoff;
  result: AnalyzeResultIpc;
}

/** Wait for the serving parent to refresh readers before making paid requests. */
export interface GraphReadyMessage {
  type: 'graph-ready';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  /**
   * Machine-readable failure code for a parent that wants to branch instead of
   * only surfacing the string. `index-lock-timeout` (#2658 review M2) means
   * acquisition waited past a wait ceiling. Ordinary lock contention is
   * transient (`retryable: true`). An orphan acquisition/reclaim guard
   * (`IndexLockTimeoutError.guardPath` set) is not — retries re-hit the 30s
   * cap and need quiesced recovery (RUNBOOK.md), so `retryable` is false.
   * Absent for a generic failure.
   */
  code?: 'index-lock-timeout';
  /**
   * True when the failure is expected to clear on retry (e.g. lock contention).
   * False when `code` is `index-lock-timeout` because of guard contention.
   */
  retryable?: boolean;
}

/** Child → parent IPC messages. Shared with the parent-side launcher. */
export type WorkerMessage =
  | ProgressMessage
  | GraphPreparedMessage
  | GraphReadyMessage
  | CompleteMessage
  | ErrorMessage;
