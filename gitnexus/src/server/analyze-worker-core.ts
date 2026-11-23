/**
 * Side-effect-free core of the analyze worker's message handler.
 *
 * Extracted from `analyze-worker.ts` — a `fork()` entry module whose top-level
 * `process.on(...)` handlers and `ready` handshake make it unsafe to import in a
 * unit test. This module has no top-level side effects and takes its collaborators
 * by dependency injection, so the worker's run → finalize → report contract is
 * unit-testable without spawning a process. The entry module wires the real deps
 * and owns the `process.exit` lifecycle.
 *
 * The `import type ... typeof import(...)` forms below are erased at runtime, so
 * importing this module does NOT load `run-analyze`, `repo-manager`, or the entry
 * worker — only the lightweight `analyze-worker-ipc` projection helper.
 */
import type { AnalyzeOptions } from '../core/run-analyze.js';
import { projectAnalysisPhaseProgress } from '../core/analysis-progress.js';
// The IPC message protocol lives in a declarations-only leaf, NOT in the
// `analyze-worker.ts` entry module: importing it from the entry made this
// module depend on the very module that depends on it (#cycle). Erased at
// runtime either way; this way the graph is acyclic too.
import type { WorkerMessage, ContinueMessage } from './analyze-worker-protocol.js';
import type { AnalyzerRunnerIdentity } from '../storage/repo-manager.js';
import { projectAnalyzeResultForIpc } from './analyze-worker-ipc.js';
import { projectPreparedAnalysisHandoff } from '../core/analysis-phase-supervisor.js';
// Value import (instanceof): index-lock is a lightweight storage primitive
// (node:fs/net/crypto only), so this does NOT pull in run-analyze/repo-manager.
import { IndexLockTimeoutError, isIndexLockGuardTimeout } from '../storage/index-lock.js';

export interface WorkerAnalysisDeps {
  runFullAnalysis: typeof import('../core/run-analyze.js').runFullAnalysis;
  continuePreparedAnalysis?: typeof import('../core/run-analyze.js').continuePreparedAnalysis;
  onGraphPublished?: () => Promise<void>;
  signal?: AbortSignal;
  assertAnalysisFinalized: typeof import('../storage/repo-manager.js').assertAnalysisFinalized;
  send: (msg: WorkerMessage) => void;
  /**
   * Claim the single terminal-outcome slot. Returns `true` for the first caller
   * (which may then send its `complete`/`error`) and `false` for every caller
   * after — so a SIGTERM cancellation and a near-simultaneous completion can't
   * both report a terminal outcome (#2264 P3). See {@link createTerminalClaim}.
   */
  claimTerminal: () => boolean;
  /** Required for nonterminal graph handoff; never claim the final outcome just
   * to test whether cancellation already owns it. */
  isCancelled?: () => boolean;
}

/**
 * Run the analysis and report the outcome to the parent over IPC. Reports at most
 * one terminal message (`complete` or `error`) — and none if a cancellation
 * already claimed the terminal slot — and never throws; the caller schedules
 * `process.exit` after this resolves.
 */
export async function runWorkerAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  deps: WorkerAnalysisDeps,
  runnerIdentityAtBootstrap?: AnalyzerRunnerIdentity,
  continuation?: ContinueMessage,
): Promise<void> {
  let terminal: WorkerMessage;
  try {
    const bootstrapArgs: [] | [AnalyzerRunnerIdentity] = runnerIdentityAtBootstrap
      ? [runnerIdentityAtBootstrap]
      : [];
    const callbacks: import('../core/run-analyze.js').AnalyzeCallbacks = {
      signal: deps.signal,
      onGraphPublished: deps.onGraphPublished,
      onProgress: (phase, percent, message, details) =>
        deps.send({
          type: 'progress',
          phase,
          percent,
          message,
          ...projectAnalysisPhaseProgress(details),
        }),
      onLog: (message) => deps.send({ type: 'progress', phase: 'log', percent: -1, message }),
    };
    let result: import('../core/run-analyze.js').AnalyzeResult;
    if (continuation) {
      if (!deps.continuePreparedAnalysis) throw new Error('Missing analysis continuation');
      const handoff = projectPreparedAnalysisHandoff(continuation.prepared.handoff);
      if (handoff.repoPath !== repoPath || continuation.prepared.result.repoPath !== repoPath)
        throw new Error('Continuation belongs to a different repository');
      const metadata = await deps.continuePreparedAnalysis(
        handoff,
        continuation.writerPid,
        options,
        callbacks,
        deps.signal,
      );
      result = {
        ...continuation.prepared.result,
        stats: metadata.stats ?? {},
        rebuildReasons: [],
      };
    } else {
      // Native allocations belong to this exit-only graph process.
      result = await deps.runFullAnalysis(
        repoPath,
        { ...options, skipNativeCloseOnExit: true },
        callbacks,
        ...bootstrapArgs,
      );
    }
    if (result.preparedGraph) {
      if (!deps.isCancelled) throw new Error('Graph handoff requires cancellation state');
      if (result.graphWriteCollapsed)
        throw new Error('Collapsed graph cannot be prepared for publication');
      if (!deps.isCancelled()) {
        deps.send({
          type: 'graph-prepared',
          handoff: projectPreparedAnalysisHandoff(result.preparedGraph),
          result: projectAnalyzeResultForIpc(result),
        });
      }
      return;
    }
    // P2 (#2264): a half-finalized repo — meta.json written but the global
    // registry entry missing (e.g. a prior collision-aborted run, or a wiped
    // registry) — must NOT be reported as a successful analysis. Mirror the CLI's
    // assertAnalysisFinalized guard so the worker surfaces it as an error instead
    // of a false `complete` that leaves the repo invisible to list_repos.
    await deps.assertAnalysisFinalized(repoPath, result.storagePath);

    // Send a JSON-safe projection, NOT the raw result: the IPC channel is
    // default-JSON serialization and `result.pipelineResult` carries the live
    // KnowledgeGraph. See analyze-worker-ipc.ts.
    terminal = { type: 'complete', result: projectAnalyzeResultForIpc(result) };
  } catch (err: unknown) {
    // Report the failure to the parent over IPC (the parent surfaces the message).
    const message = err instanceof Error ? err.message : 'Analysis failed';
    // #2658 review M2: a lock-wait timeout is transient contention (another
    // analyze held the single-writer lock), not a broken build — tag it so the
    // parent can surface a retry signal instead of an opaque hard failure.
    // An orphan guard needs quiesced recovery, not automatic retries.
    terminal =
      err instanceof IndexLockTimeoutError
        ? {
            type: 'error',
            message,
            code: 'index-lock-timeout',
            retryable: !isIndexLockGuardTimeout(err),
          }
        : { type: 'error', message };
  }

  // P3 (#2264): only report if a SIGTERM cancellation hasn't already claimed the
  // terminal slot — otherwise a cancel near the finish line would report the
  // analysis as `complete` over the top of the cancellation.
  if (deps.claimTerminal()) deps.send(terminal);
}

/**
 * Create the single-use terminal-outcome claim shared by the worker's message
 * handler and its SIGTERM handler. The first call returns `true`; every later
 * call returns `false`. This is the coordination point that prevents a cancel and
 * a completion from both reporting a terminal status (#2264 P3). Single-threaded
 * JS guarantees the check-and-set is atomic (no preemption mid-call).
 */
export function createTerminalClaim(): () => boolean {
  let claimed = false;
  return () => {
    if (claimed) return false;
    claimed = true;
    return true;
  };
}
