import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnalyzeOptions, AnalyzeResult } from '../run-analyze.js';
import type { WorkerMessage } from '../../server/analyze-worker-protocol.js';
import { autoHeapCapMb } from '../ingestion/utils/effective-ram.js';

const _require = createRequire(import.meta.url);
export type AutoSyncAnalysisRunner = (
  repoPath: string,
  options: AnalyzeOptions,
  timeoutMs: number,
  signal?: AbortSignal,
  onCancellationRequested?: () => void,
) => Promise<Pick<AnalyzeResult, 'stats'>>;

interface AnalysisWorker extends Pick<ChildProcess, 'send' | 'on'> {
  stdout?: Pick<NodeJS.ReadableStream, 'resume'> | null;
  stderr?: Pick<NodeJS.ReadableStream, 'resume'> | null;
}

export interface AutoSyncAnalysisLaunchDeps {
  forkWorker: (workerPath: string, execArgv: string[]) => AnalysisWorker;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
}

const DEFAULT_DEPS: AutoSyncAnalysisLaunchDeps = {
  forkWorker: (workerPath, execArgv) =>
    fork(workerPath, [], {
      execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }),
  setTimeoutFn: setTimeout,
  clearTimeoutFn: clearTimeout,
};

export function createAutoSyncAnalysisRunner(
  overrides: Partial<AutoSyncAnalysisLaunchDeps> = {},
): AutoSyncAnalysisRunner {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  return (repoPath, options, timeoutMs, signal, onCancellationRequested) =>
    new Promise<Pick<AnalyzeResult, 'stats'>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Analysis cancelled.'));
        return;
      }
      const callerPath = fileURLToPath(import.meta.url);
      const isDev = callerPath.endsWith('.ts');
      const workerPath = path.join(
        path.dirname(callerPath),
        '../../server',
        isDev ? 'analyze-worker.ts' : 'analyze-worker.js',
      );
      if (!existsSync(workerPath)) {
        reject(new Error(`Auto-sync analyze worker is missing: ${workerPath}`));
        return;
      }
      const workerHeapMb = Math.min(8192, autoHeapCapMb());
      const execArgv = isDev
        ? [
            '--import',
            pathToFileURL(_require.resolve('tsx/esm')).href,
            `--max-old-space-size=${workerHeapMb}`,
          ]
        : [`--max-old-space-size=${workerHeapMb}`];
      const child = deps.forkWorker(workerPath, execArgv);
      child.stdout?.resume();
      child.stderr?.resume();

      let terminalOutcome: WorkerMessage | undefined;
      let terminationError: Error | undefined;
      let settled = false;
      const cleanup = () => {
        deps.clearTimeoutFn(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (error?: Error, result?: Pick<AnalyzeResult, 'stats'>) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result!);
      };
      const requestCancellation = (error: Error) => {
        if (settled || terminationError) return;
        terminationError = error;
        deps.clearTimeoutFn(timeout);
        onCancellationRequested?.();
        // IPC has the same semantics on macOS and Windows. The worker exits only
        // after reaching a JS-visible safe point; this parent keeps ownership until then.
        try {
          child.send({ type: 'cancel' });
        } catch {
          // A closed IPC channel still has an exit/error path. Do not force-kill a
          // worker that may be inside native code.
        }
      };
      const timeout = deps.setTimeoutFn(
        () => requestCancellation(new Error(`Analysis timed out after ${timeoutMs}ms.`)),
        timeoutMs,
      );
      const onAbort = () => requestCancellation(new Error('Analysis cancelled.'));
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('message', (message: WorkerMessage) => {
        // Once timeout/cancellation requested shutdown, its reason owns the
        // result. A terminal IPC can already be queued behind cancellation.
        if (message.type === 'progress' || terminalOutcome || terminationError) return;
        terminalOutcome = message;
        deps.clearTimeoutFn(timeout);
      });
      child.on('error', (error) => {
        const workerError = new Error(`Auto-sync analyze worker error: ${error.message}`);
        requestCancellation(workerError);
        settle(workerError);
      });
      child.on('exit', (code, childSignal) => {
        if (settled) return;
        if (terminationError) {
          settle(terminationError);
          return;
        }
        if (terminalOutcome?.type === 'complete') {
          settle(undefined, { stats: terminalOutcome.result.stats });
          return;
        }
        if (terminalOutcome?.type === 'error') {
          settle(new Error(terminalOutcome.message));
          return;
        }
        settle(
          new Error(
            `Auto-sync analyze worker exited before completion (${childSignal ?? code ?? 'unknown'}).`,
          ),
        );
      });
      try {
        child.send({ type: 'start', repoPath, options });
      } catch (error) {
        const startError = new Error(
          `Failed to start auto-sync analyze worker: ${(error as Error).message}`,
        );
        requestCancellation(startError);
        settle(startError);
      }
    });
}

export const runAutoSyncAnalysis = createAutoSyncAnalysisRunner();
