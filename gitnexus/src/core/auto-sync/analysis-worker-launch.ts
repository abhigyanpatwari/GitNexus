import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnalyzeOptions, AnalyzeResult } from '../run-analyze.js';
import type {
  WorkerMessage,
  ContinueMessage,
  GraphPreparedMessage,
} from '../../server/analyze-worker-protocol.js';
import {
  analysisMayEmbed,
  analysisSupervisorReservation,
  resolveHostAnalysisResources,
} from '../analysis-host-resources.js';
import { projectPreparedAnalysisHandoff } from '../analysis-phase-supervisor.js';

const _require = createRequire(import.meta.url);
export type AutoSyncAnalysisRunner = (
  repoPath: string,
  options: AnalyzeOptions,
  timeoutMs: number,
  signal?: AbortSignal,
  onCancellationRequested?: () => void,
  concurrency?: number,
  /** Worker progress until the run settles or cancellation begins. */
  onProgress?: (percent: number, message: string) => void,
) => Promise<Pick<AnalyzeResult, 'stats' | 'graphWriteCollapsed'>>;

interface AnalysisWorker extends Pick<ChildProcess, 'send' | 'on'> {
  pid?: number;
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

export class AutoSyncAnalysisError extends Error {
  readonly code?: 'index-lock-timeout';
  readonly retryable?: boolean;
  readonly abandonedWorker: boolean;
  /** Resolves on actual process exit when the request stopped waiting first. */
  readonly workerExited?: Promise<void>;

  constructor(
    message: string,
    options: {
      code?: 'index-lock-timeout';
      retryable?: boolean;
      abandonedWorker?: boolean;
      workerExited?: Promise<void>;
    } = {},
  ) {
    super(message);
    this.name = 'AutoSyncAnalysisError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.abandonedWorker = options.abandonedWorker === true;
    this.workerExited = options.workerExited;
  }
}

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

export function createAutoSyncAnalysisRunner(
  overrides: Partial<AutoSyncAnalysisLaunchDeps> = {},
): AutoSyncAnalysisRunner {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  return async (
    repoPath,
    options,
    timeoutMs,
    signal,
    onCancellationRequested,
    concurrency,
    onProgress,
  ) => {
    signal?.throwIfAborted();
    return new Promise<Pick<AnalyzeResult, 'stats' | 'graphWriteCollapsed'>>((resolve, reject) => {
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
      let analysisOptions: AnalyzeOptions;
      let execArgv: string[];
      let child: AnalysisWorker;

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
        child?.channel?.unref?.();
        child?.unref?.();
      };
      const settle = (
        error?: Error,
        result?: Pick<AnalyzeResult, 'stats' | 'graphWriteCollapsed'>,
      ) => {
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
        if (!child) {
          // Preflight owns no native worker; expire immediately and prevent a late launch.
          settle(error);
          return;
        }
        // IPC has the same semantics on macOS and Windows. The worker exits only
        // after reaching a JS-visible safe point; this parent keeps ownership until then.
        try {
          child?.send({ type: 'cancel' });
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
          const workerExited = new Promise<void>((resolveExited) => {
            child.on('exit', () => resolveExited());
          });
          releaseChild();
          settle(
            new AutoSyncAnalysisError(
              `${error.message} The analyze worker did not exit within ${deps.cancelGraceMs}ms; ` +
                'it was left running so its native work is not interrupted.',
              { abandonedWorker: true, retryable: true, workerExited },
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

      const launch = (continuation?: ContinueMessage) => {
        child = deps.forkWorker(workerPath, execArgv);
        const phaseChild = child;
        let prepared: GraphPreparedMessage | undefined;
        child.stdout?.resume();
        child.stderr?.resume();
        child.on('message', (message: WorkerMessage) => {
          // Once timeout/cancellation requested shutdown, its reason owns the
          // result. A terminal IPC can already be queued behind cancellation.
          if (terminalOutcome || terminationError || settled || child !== phaseChild) return;
          if (message.type === 'progress') {
            // Worker log messages use percent -1 and do not represent progress.
            if (message.percent < 0) return;
            try {
              onProgress?.(message.percent, message.message);
            } catch {
              // A listener failure must not decide the run's outcome.
            }
            return;
          }
          if (message.type === 'graph-ready') {
            // Watch has no serving reader cache. Publication is already verified.
            try {
              child.send({ type: 'graph-visible' });
            } catch (error) {
              requestCancellation(error as Error);
            }
            return;
          }
          if (message.type === 'graph-prepared') {
            try {
              if (prepared || continuation) throw new Error('Repeated graph preparation');
              prepared = { ...message, handoff: projectPreparedAnalysisHandoff(message.handoff) };
            } catch (error) {
              requestCancellation(error as Error);
            }
            return;
          }
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
          if (settled || child !== phaseChild) return;
          if (terminationError) {
            settle(terminationError);
            return;
          }
          if (terminalOutcome?.type === 'complete') {
            if (code === 0 && !childSignal) {
              const { stats, graphWriteCollapsed } = terminalOutcome.result;
              settle(undefined, graphWriteCollapsed ? { stats, graphWriteCollapsed } : { stats });
            } else
              settle(
                new Error(
                  `Auto-sync analyze worker exited unsuccessfully (${childSignal ?? code}).`,
                ),
              );
            return;
          }
          if (!terminalOutcome && prepared && code === 0 && !childSignal && phaseChild.pid) {
            try {
              launch({
                type: 'continue',
                repoPath,
                options: analysisOptions,
                writerPid: phaseChild.pid,
                prepared,
              });
            } catch (error) {
              settle(error as Error);
            }
            return;
          }
          if (terminalOutcome?.type === 'error') {
            settle(
              new AutoSyncAnalysisError(terminalOutcome.message, {
                code: terminalOutcome.code,
                retryable: terminalOutcome.retryable,
              }),
            );
            return;
          }
          settle(
            new Error(
              `Auto-sync analyze worker exited before completion (${childSignal ?? code ?? 'unknown'}).`,
            ),
          );
        });
        try {
          child.send(continuation ?? { type: 'start', repoPath, options: analysisOptions });
        } catch (error) {
          const startError = new Error(
            `Failed to start auto-sync analyze worker: ${(error as Error).message}`,
          );
          requestCancellation(startError);
          releaseChild();
          settle(startError);
        }
      };
      const start = async () => {
        let resources = options.resources;
        if (!resources) {
          const includeEmbeddings = await analysisMayEmbed(repoPath, options);
          if (settled) return;
          resources = resolveHostAnalysisResources({
            includeEmbeddings,
            supervisorBytes: Math.ceil(analysisSupervisorReservation() / (concurrency ?? 1)),
            concurrency,
          });
        }
        analysisOptions = { ...options, graphPublication: 'auto', resources };
        const workerHeapMb = resources.mainHeapMb - 48;
        execArgv = isDev
          ? [
              '--import',
              pathToFileURL(_require.resolve('tsx/esm')).href,
              `--max-old-space-size=${workerHeapMb}`,
              '--max-semi-space-size=16',
            ]
          : [`--max-old-space-size=${workerHeapMb}`, '--max-semi-space-size=16'];
        launch();
      };
      void start().catch((error: Error) => settle(error));
    });
  };
}

export const runAutoSyncAnalysis = createAutoSyncAnalysisRunner();
