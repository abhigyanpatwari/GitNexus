import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnalyzeOptions, AnalyzeResult } from '../run-analyze.js';
import type { WorkerMessage } from '../../server/analyze-worker.js';

const _require = createRequire(import.meta.url);
const TERMINATION_GRACE_MS = 10_000;

export type AutoSyncAnalysisRunner = (
  repoPath: string,
  options: AnalyzeOptions,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<Pick<AnalyzeResult, 'stats'>>;

interface AnalysisWorker extends Pick<ChildProcess, 'send' | 'kill' | 'on'> {
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
  return (repoPath, options, timeoutMs, signal) =>
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
      const execArgv = isDev
        ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href, '--max-old-space-size=8192']
        : ['--max-old-space-size=8192'];
      const child = deps.forkWorker(workerPath, execArgv);
      child.stdout?.resume();
      child.stderr?.resume();

      let terminalOutcome: WorkerMessage | undefined;
      let terminationGrace: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = () => {
        deps.clearTimeoutFn(timeout);
        if (terminationGrace) deps.clearTimeoutFn(terminationGrace);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (error?: Error, result?: Pick<AnalyzeResult, 'stats'>) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result!);
      };
      const timeout = deps.setTimeoutFn(() => {
        child.kill('SIGTERM');
        terminationGrace = deps.setTimeoutFn(() => {
          child.kill('SIGKILL');
          settle(new Error(`Analysis timed out after ${timeoutMs}ms.`));
        }, TERMINATION_GRACE_MS);
      }, timeoutMs);
      const onAbort = () => {
        child.kill('SIGKILL');
        settle(new Error('Analysis cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('message', (message: WorkerMessage) => {
        if (message.type !== 'progress') terminalOutcome ??= message;
      });
      child.on('error', (error) => {
        settle(new Error(`Auto-sync analyze worker error: ${error.message}`));
      });
      child.on('exit', (code, childSignal) => {
        if (settled) return;
        if (terminationGrace) {
          settle(
            new Error(
              `Analysis timed out after ${timeoutMs}ms and worker exited (${childSignal ?? code ?? 'unknown'}).`,
            ),
          );
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
        child.kill('SIGKILL');
        settle(new Error(`Failed to start auto-sync analyze worker: ${(error as Error).message}`));
      }
    });
}

export const runAutoSyncAnalysis = createAutoSyncAnalysisRunner();
