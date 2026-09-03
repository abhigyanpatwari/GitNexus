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
  concurrency?: number,
) => Promise<Pick<AnalyzeResult, 'stats'>>;

interface AnalysisWorker extends Pick<ChildProcess, 'send' | 'on'> {
  stdout?: Pick<NodeJS.ReadableStream, 'resume'> | null;
  stderr?: Pick<NodeJS.ReadableStream, 'resume'> | null;
  unref?: () => void;
  channel?: { unref(): void } | null;
}

/**
 * How long the parent keeps waiting after asking a worker to cancel.
 *
 * Must stay below `stopAutoSyncWatch`'s process-exit budget, or a worker wedged
 * past its safe point still turns `watch stop` into a timeout.
 */
const AUTO_SYNC_CANCEL_GRACE_MS = 5_000;

export interface AutoSyncAnalysisLaunchDeps {
  forkWorker: (workerPath: string, execArgv: string[]) => AnalysisWorker;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  cancelGraceMs: number;
}

const DEFAULT_DEPS: AutoSyncAnalysisLaunchDeps = {
  forkWorker: (workerPath, execArgv) =>
    fork(workerPath, [], {
      execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }),
  setTimeoutFn: setTimeout,
  clearTimeoutFn: clearTimeout,
  cancelGraceMs: AUTO_SYNC_CANCEL_GRACE_MS,
};

/**
 * Per-worker V8 heap cap for one tick.
 *
 * `autoHeapCapMb()` is a whole-machine figure, so handing it to every fork
 * over-commits memory by the parallelism factor. Admission already bounds
 * parallelism to `floor(availableMemoryGB / 2)`, so dividing here keeps the sum
 * of worker heaps inside the machine budget while leaving `max_concurrency`
 * free to mean what it says. The two rules compose to a ~1.5GB per-worker floor.
 */
export function resolveWorkerHeapMb(concurrency = 1): number {
  const slots = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1;
  return Math.max(1, Math.min(8192, Math.floor(autoHeapCapMb() / slots)));
}

export function createAutoSyncAnalysisRunner(
  overrides: Partial<AutoSyncAnalysisLaunchDeps> = {},
): AutoSyncAnalysisRunner {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  return (repoPath, options, timeoutMs, signal, onCancellationRequested, concurrency) =>
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
      const workerHeapMb = resolveWorkerHeapMb(concurrency);
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
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        deps.clearTimeoutFn(timeout);
        deps.clearTimeoutFn(graceTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      // Stop the parent owning a worker it has given up waiting for. An
      // established IPC channel keeps this event loop alive even after unref,
      // so both handles have to go. Never a kill: the child may be inside
      // native work and is left to reach its own safe point.
      const releaseChild = () => {
        child.channel?.unref?.();
        child.unref?.();
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
        // Bounded wait. A worker stuck past its safe point would otherwise leave
        // this promise pending forever, wedging `activeRun` so `stop()` — and the
        // `watch stop` waiting on this process to exit — can never finish. Settle
        // the parent's wait and drop the IPC channel's hold on this event loop;
        // an established channel keeps the parent alive even after unref. The
        // child is deliberately left running rather than killed mid-write.
        graceTimer = deps.setTimeoutFn(() => {
          if (settled) return;
          releaseChild();
          settle(
            new Error(
              `${error.message} The analyze worker did not exit within ${deps.cancelGraceMs}ms; ` +
                'it was left running so its native work is not interrupted.',
            ),
          );
        }, deps.cancelGraceMs);
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
        // This settles immediately rather than waiting out the grace, so the
        // grace timer that would otherwise have released the child is cleared
        // by cleanup(). Release it here instead — an errored channel does not
        // mean the worker stopped.
        releaseChild();
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
