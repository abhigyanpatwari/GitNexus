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

import { runFullAnalysis, type AnalyzeOptions, type AnalyzeResult } from '../core/run-analyze.js';
import { closeLbug } from '../core/lbug/lbug-adapter.js';

interface StartMessage {
  type: 'start';
  repoPath: string;
  options: AnalyzeOptions;
}

interface ProgressMessage {
  type: 'progress';
  phase: string;
  percent: number;
  message: string;
}

interface CompleteMessage {
  type: 'complete';
  result: AnalyzeResult;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type WorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage;

function send(msg: WorkerMessage) {
  process.send?.(msg);
}

// Catch uncaught exceptions and unhandled rejections — report to parent
process.on('uncaughtException', (err) => {
  send({ type: 'error', message: err?.message || 'Uncaught exception in worker' });
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason: any) => {
  send({ type: 'error', message: reason?.message || 'Unhandled rejection in worker' });
  setTimeout(() => process.exit(1), 500);
});

// Handle graceful shutdown — notify parent before exit
process.on('SIGTERM', async () => {
  send({ type: 'error', message: 'Analysis cancelled (worker received SIGTERM)' });
  try {
    await closeLbug();
  } catch {}
  process.exit(0);
});

// Listen for start command from parent — guarded against re-entry
let started = false;
process.on('message', async (msg: StartMessage) => {
  if (msg.type !== 'start' || started) return;
  started = true;

  try {
    const result = await runFullAnalysis(msg.repoPath, msg.options, {
      onProgress: (phase, percent, message) => {
        send({ type: 'progress', phase, percent, message });
      },
      onLog: (message) => {
        send({ type: 'progress', phase: 'log', percent: -1, message });
      },
    });

    send({ type: 'complete', result });
  } catch (err: any) {
    send({ type: 'error', message: err?.message || 'Analysis failed' });
  }

  // LadybugDB's native module prevents clean exit — force it
  // (same reason the CLI uses process.exit(0))
  setTimeout(() => process.exit(0), 500);
});
