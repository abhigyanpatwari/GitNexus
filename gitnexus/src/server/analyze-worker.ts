/**
 * Analyze Worker — Forked Child Process
 *
 * This file is the entry point for `child_process.fork()`.
 * It runs runFullAnalysis in an isolated process with 8GB heap.
 *
 * IPC Protocol:
 *   Parent -> Child: { type: 'start', repoPath: string, options: AnalyzeOptions }
 *   Child -> Parent: { type: 'progress', phase: string, percent: number, message: string }
 *   Child -> Parent: { type: 'complete', result: AnalyzeResult }
 *   Child -> Parent: { type: 'error', message: string }
 */

import { runFullAnalysis, type AnalyzeOptions } from '../core/run-analyze.js';
import { type AnalyzeResultIpc } from './analyze-worker-ipc.js';
import { runWorkerAnalysis, createTerminalClaim } from './analyze-worker-core.js';
import { assertAnalysisFinalized } from '../storage/repo-manager.js';
import { boundedCheckpointBeforeExit } from '../core/lbug/shutdown-helpers.js';

interface StartMessage {
  type: 'start';
  repoPath: string;
  options: AnalyzeOptions;
}

export interface ProgressMessage {
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

export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** Child → parent IPC messages. Shared with the parent-side launcher. */
export type WorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage;

function send(msg: WorkerMessage) {
  // No try/catch: if the IPC channel is gone, process.send throws
  // (ERR_IPC_CHANNEL_CLOSED) and that failure must NOT be swallowed. Every caller
  // schedules its process.exit inside a `finally`, so a throw here still tears the
  // worker down deterministically instead of wedging the event loop (#2264 P3).
  process.send?.(msg);
}

// Single terminal-outcome slot shared by the message handler and the SIGTERM
// handler: whoever claims it first reports its complete/error; the other skips its
// terminal send, so a cancel near the finish line can't also report success and a
// late SIGTERM can't flip an already-reported job (#2264 P3).
const claimTerminal = createTerminalClaim();

// Catch uncaught exceptions and unhandled rejections — report them to the parent
// over IPC (the same channel the analysis path uses), then exit. The report runs
// in `try` and the exit in `finally` so a throw from send() on a closed channel
// can't skip the exit and leave the worker wedged (#2264 review P3).
process.on('uncaughtException', (err: unknown) => {
  try {
    const message = err instanceof Error ? err.message : 'Uncaught exception in worker';
    send({ type: 'error', message });
  } finally {
    setTimeout(() => process.exit(1), 500);
  }
});

process.on('unhandledRejection', (reason: unknown) => {
  try {
    const message = reason instanceof Error ? reason.message : 'Unhandled rejection in worker';
    send({ type: 'error', message });
  } finally {
    setTimeout(() => process.exit(1), 500);
  }
});

// Handle cancellation / timeout shutdown (analyze-job.ts `cancelJob` sends
// SIGTERM). Bounded CHECKPOINT-then-exit shared with the CLI SIGINT path (#2264):
// skip the native close (the LadybugDB destructor can double-free after --pdg
// writes), but don't block behind the in-flight COPY's connection lock — so a
// single cancel can't abort or hang the worker. A CHECKPOINT failure is reported
// to the parent over IPC, not swallowed; the exit always fires.
process.on('SIGTERM', () => {
  // Only report the cancellation if the analysis hasn't already reported a
  // terminal outcome (#2264 P3) — otherwise this would flip an already-complete
  // job to failed. The cleanup + exit below run regardless.
  if (claimTerminal()) {
    send({ type: 'error', message: 'Analysis cancelled (worker received SIGTERM)' });
  }
  void boundedCheckpointBeforeExit({
    exitCode: 0,
    onFlushError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : 'Worker checkpoint failed during SIGTERM';
      send({ type: 'error', message });
    },
  });
});

// Listen for start command from parent — guarded against re-entry
let started = false;
process.on('message', async (msg: StartMessage) => {
  if (msg.type !== 'start' || started) return;
  started = true;

  try {
    // The run → finalize → report contract lives in the side-effect-free
    // analyze-worker-core seam (unit-testable without this entry module's
    // process.on side effects). It reports exactly one terminal message and
    // never throws.
    await runWorkerAnalysis(msg.repoPath, msg.options, {
      runFullAnalysis,
      assertAnalysisFinalized,
      send,
      claimTerminal,
    });
  } finally {
    // LadybugDB's native module prevents clean exit — force it (same reason the
    // CLI uses process.exit(0)). In `finally` so the exit still fires even if the
    // report above throws on a closed IPC channel (#2264 review P3).
    setTimeout(() => process.exit(0), 500);
  }
});
