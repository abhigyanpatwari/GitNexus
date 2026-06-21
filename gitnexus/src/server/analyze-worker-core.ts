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
import type { WorkerMessage } from './analyze-worker.js';
import { projectAnalyzeResultForIpc } from './analyze-worker-ipc.js';

export interface WorkerAnalysisDeps {
  runFullAnalysis: typeof import('../core/run-analyze.js').runFullAnalysis;
  assertAnalysisFinalized: typeof import('../storage/repo-manager.js').assertAnalysisFinalized;
  send: (msg: WorkerMessage) => void;
}

/**
 * Run the analysis and report the outcome to the parent over IPC. Always reports
 * exactly one terminal message (`complete` or `error`) and never throws — the
 * caller schedules `process.exit` after this resolves.
 */
export async function runWorkerAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  deps: WorkerAnalysisDeps,
): Promise<void> {
  try {
    const result = await deps.runFullAnalysis(
      repoPath,
      // This worker force-exits right after reporting, so skip the native close
      // (it can double-free in LadybugDB's ClientContext destructor after --pdg
      // writes); flushWAL still persists the index, process.exit reclaims handles.
      { ...options, skipNativeCloseOnExit: true },
      {
        onProgress: (phase, percent, message) =>
          deps.send({ type: 'progress', phase, percent, message }),
        onLog: (message) => deps.send({ type: 'progress', phase: 'log', percent: -1, message }),
      },
    );
    // P2 (#2264): a half-finalized repo — meta.json written but the global
    // registry entry missing (e.g. a prior collision-aborted run, or a wiped
    // registry) — must NOT be reported as a successful analysis. Mirror the CLI's
    // assertAnalysisFinalized guard so the worker surfaces it as an error instead
    // of a false `complete` that leaves the repo invisible to list_repos.
    await deps.assertAnalysisFinalized(repoPath);

    // Send a JSON-safe projection, NOT the raw result: the IPC channel is
    // default-JSON serialization and `result.pipelineResult` carries the live
    // KnowledgeGraph. See analyze-worker-ipc.ts.
    deps.send({ type: 'complete', result: projectAnalyzeResultForIpc(result) });
  } catch (err: unknown) {
    // Report the failure to the parent over IPC (the parent surfaces the message).
    const message = err instanceof Error ? err.message : 'Analysis failed';
    deps.send({ type: 'error', message });
  }
}
