/**
 * Analyze Worker — Forked Child Process
 *
 * This file is the entry point for `child_process.fork()`.
 * It runs runFullAnalysis in an isolated process with 8GB heap.
 *
 * IPC Protocol:
 *   Parent -> Child: { type: 'start', repoPath: string, options: AnalyzeOptions }
 *   Parent -> Child: { type: 'cancel' }
 *   Child -> Parent: { type: 'progress', phase: string, percent: number, message: string }
 *   Child -> Parent: { type: 'complete', result: AnalyzeResult }
 *   Child -> Parent: { type: 'error', message: string }
 */

import type { ParentMessage, WorkerMessage } from './analyze-worker-protocol.js';
import { runWorkerAnalysis, createTerminalClaim } from './analyze-worker-core.js';
type BoundedCheckpointBeforeExit =
  typeof import('../core/lbug/shutdown-helpers.js').boundedCheckpointBeforeExit;

// The message shapes live in `analyze-worker-protocol.ts` — a declarations-only
// leaf neither this entry module nor `analyze-worker-core.ts` sits downstream
// of, which is what breaks the entry ⇄ core import cycle. The two shapes that
// are imported from HERE are re-exported (as types, so the re-export is erased
// at runtime): `WorkerMessage` by `analyze-launch.ts`, `CompleteMessage` by
// `analyze-launch-collapse.test.ts`. Everything else imports the protocol module
// directly, so nothing else belongs in this list.
export type { CompleteMessage, WorkerMessage } from './analyze-worker-protocol.js';

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
let boundedCheckpointBeforeExit: BoundedCheckpointBeforeExit | null = null;

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

// IPC cancellation is the cross-platform control path. It only records the
// request while analysis is active; cleanup waits until the analysis promise has
// returned to JS. SIGTERM is retained only for local process shutdown.
let cancellationRequested = false;
let started = false;
function requestWorkerCancellation(source: string): void {
  if (cancellationRequested) return;
  cancellationRequested = true;
  if (claimTerminal()) {
    send({ type: 'error', message: `Analysis cancelled (${source})` });
  }
  if (!started) {
    // No analysis has started, so no native work needs a safe-point handshake.
    process.exit(0);
  }
}

function exitAfterCancellation(): void {
  if (!boundedCheckpointBeforeExit) {
    process.exit(0);
    return;
  }
  void boundedCheckpointBeforeExit({
    exitCode: 0,
    onFlushError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Worker checkpoint failed during cancellation';
      send({ type: 'error', message });
    },
  });
}

process.on('SIGTERM', () => requestWorkerCancellation('worker received SIGTERM'));

// Listen for parent commands — guarded against re-entry.
process.on('message', async (msg: ParentMessage) => {
  if (msg.type === 'cancel') {
    requestWorkerCancellation('parent requested cancellation');
    return;
  }
  if (started) return;
  started = true;

  try {
    // Capture the complete build/dependency receipt before evaluating the
    // analyzer graph or loading LadybugDB. A replacement racing this boundary
    // is compared against this receipt again immediately before metadata commit.
    const identityModule = await import('../core/analyzer-identity.js');
    const prepared = await identityModule.captureAnalyzerIdentityBeforeLoad(
      import.meta.url,
      async () => {
        const [analysisModule, repoManager, shutdownHelpers] = await Promise.all([
          import('../core/run-analyze.js'),
          import('../storage/repo-manager.js'),
          import('../core/lbug/shutdown-helpers.js'),
        ]);
        return { analysisModule, repoManager, shutdownHelpers };
      },
    );
    boundedCheckpointBeforeExit = prepared.loaded.shutdownHelpers.boundedCheckpointBeforeExit;
    // A cancel can arrive while the dynamic imports are resolving. Do not begin
    // a new analysis after that request; the finally block performs safe cleanup.
    if (cancellationRequested) return;
    // The run → finalize → report contract lives in the side-effect-free
    // analyze-worker-core seam (unit-testable without this entry module's
    // process.on side effects). It reports exactly one terminal message and
    // never throws.
    await runWorkerAnalysis(
      msg.repoPath,
      msg.options,
      {
        runFullAnalysis: prepared.loaded.analysisModule.runFullAnalysis,
        assertAnalysisFinalized: prepared.loaded.repoManager.assertAnalysisFinalized,
        send,
        claimTerminal,
      },
      prepared.runnerIdentity,
    );
  } catch (error) {
    if (claimTerminal()) {
      send({
        type: 'error',
        message: error instanceof Error ? error.message : 'Analysis worker bootstrap failed',
      });
    }
  } finally {
    // A cancel must not end the process while runFullAnalysis may still be in
    // native code. This continuation runs only after that promise has settled.
    if (cancellationRequested) exitAfterCancellation();
    // Normal terminal outcomes still need the existing process exit because
    // LadybugDB stays live.
    else setTimeout(() => process.exit(0), 500);
  }
});
