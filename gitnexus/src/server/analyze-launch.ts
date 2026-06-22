/**
 * Shared analyze-worker launcher.
 *
 * Forks the analyze worker for an already-resolved repo directory and owns the
 * lock + auto-retry + IPC machinery. Used by both the JSON `/api/analyze` route
 * and the multipart `/api/analyze/upload` route. Dependency-injected (like
 * createAnalyzeUploadHandler) so the seam is testable and api.ts stays smaller.
 *
 * NOTE: this module must live alongside analyze-worker.{ts,js} — the worker
 * path is resolved relative to `import.meta.url`.
 */

import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { getStoragePath } from '../storage/repo-manager.js';
import { logger } from '../core/logger.js';
import type { JobManager } from './analyze-job.js';
import type { WorkerMessage } from './analyze-worker.js';

const _require = createRequire(import.meta.url);

export interface LaunchDeps {
  jobManager: JobManager;
  backend: { init: () => Promise<unknown> };
  acquireRepoLock: (key: string) => string | null;
  releaseRepoLock: (key: string) => void;
}

export interface LaunchOptions {
  force?: boolean;
  embeddings?: boolean;
  dropEmbeddings?: boolean;
  registryName?: string;
}

const MAX_WORKER_RETRIES = 2;

export function createLaunchAnalysisWorker(deps: LaunchDeps) {
  const { jobManager, backend, acquireRepoLock, releaseRepoLock } = deps;

  return function launchAnalysisWorker(
    job: { id: string },
    targetPath: string,
    opts: LaunchOptions,
  ): void {
    // Acquire shared repo lock (keyed on storagePath to match embed handler)
    const analyzeLockKey = getStoragePath(targetPath);
    const lockErr = acquireRepoLock(analyzeLockKey);
    if (lockErr) {
      jobManager.updateJob(job.id, { status: 'failed', error: lockErr });
      return;
    }

    jobManager.updateJob(job.id, { repoPath: targetPath, status: 'analyzing' });

    // ── Worker fork with auto-retry ──────────────────────────────
    const callerPath = fileURLToPath(import.meta.url);
    const isDev = callerPath.endsWith('.ts');
    const workerFile = isDev ? 'analyze-worker.ts' : 'analyze-worker.js';
    const workerPath = path.join(path.dirname(callerPath), workerFile);
    const tsxHookArgs: string[] = isDev
      ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href]
      : [];

    const forkWorker = () => {
      const currentJob = jobManager.getJob(job.id);
      if (!currentJob || currentJob.status === 'complete' || currentJob.status === 'failed') return;

      const child = fork(workerPath, [], {
        execArgv: [...tsxHookArgs, '--max-old-space-size=8192'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      // Capture stderr for crash diagnostics
      let stderrChunks = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks += chunk.toString();
        if (stderrChunks.length > 4096) stderrChunks = stderrChunks.slice(-4096);
      });

      child.on('message', (msg: WorkerMessage) => {
        // Ignore any message once the job is terminal — a late worker message (a
        // SIGTERM-driven `error` after `complete`, or vice versa) must not
        // re-release the repo lock or flip the reported status. Mirrors the `exit`
        // handler guard below; pairs with the worker's terminal-claim (#2264 P3).
        const current = jobManager.getJob(job.id);
        if (!current || current.status === 'complete' || current.status === 'failed') return;

        if (msg.type === 'progress') {
          jobManager.updateJob(job.id, {
            status: 'analyzing',
            progress: { phase: msg.phase, percent: msg.percent, message: msg.message },
          });
        } else if (msg.type === 'complete') {
          releaseRepoLock(analyzeLockKey);
          // Reinitialize backend BEFORE marking complete — ensures the new repo
          // is queryable when the client receives the SSE complete event.
          backend
            .init()
            .then(() => {
              jobManager.updateJob(job.id, { status: 'complete', repoName: msg.result.repoName });
            })
            .catch((err) => {
              logger.error({ err }, 'backend.init() failed after analyze:');
              jobManager.updateJob(job.id, {
                status: 'failed',
                error: 'Server failed to reload after analysis. Try again.',
              });
            });
        } else if (msg.type === 'error') {
          releaseRepoLock(analyzeLockKey);
          jobManager.updateJob(job.id, { status: 'failed', error: msg.message });
        }
      });

      child.on('error', (err) => {
        releaseRepoLock(analyzeLockKey);
        jobManager.updateJob(job.id, {
          status: 'failed',
          error: `Worker process error: ${err.message}`,
        });
      });

      child.on('exit', (code) => {
        const j = jobManager.getJob(job.id);
        if (!j || j.status === 'complete' || j.status === 'failed') return;

        // Worker crashed — attempt retry if under the limit
        if (j.retryCount < MAX_WORKER_RETRIES) {
          j.retryCount++;
          const delay = 1000 * Math.pow(2, j.retryCount - 1); // 1s, 2s
          const lastErr = stderrChunks.trim().split('\n').pop() || '';
          logger.warn(
            `Analyze worker crashed (code ${code}), retry ${j.retryCount}/${MAX_WORKER_RETRIES} in ${delay}ms` +
              (lastErr ? `: ${lastErr}` : ''),
          );
          jobManager.updateJob(job.id, {
            status: 'analyzing',
            progress: {
              phase: 'retrying',
              percent: j.progress.percent,
              message: `Worker crashed, retrying (${j.retryCount}/${MAX_WORKER_RETRIES})...`,
            },
          });
          stderrChunks = '';
          setTimeout(forkWorker, delay);
        } else {
          // Exhausted retries — permanent failure
          releaseRepoLock(analyzeLockKey);
          jobManager.updateJob(job.id, {
            status: 'failed',
            error: `Worker crashed ${MAX_WORKER_RETRIES + 1} times (code ${code})${stderrChunks ? ': ' + stderrChunks.trim().split('\n').pop() : ''}`,
          });
        }
      });

      // Register child for cancellation + timeout tracking
      jobManager.registerChild(job.id, child);

      // Send start command to child
      child.send({
        type: 'start',
        repoPath: targetPath,
        options: {
          force: !!opts.force,
          embeddings: !!opts.embeddings,
          dropEmbeddings: !!opts.dropEmbeddings,
          ...(opts.registryName ? { registryName: opts.registryName } : {}),
        },
      });
    };

    forkWorker();
  };
}
