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
import { existsSync, statSync } from 'node:fs';
import { fork } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import {
  canonicalizePath,
  getStoragePath,
  INDEX_METADATA_FILE,
  listRegisteredRepos,
  registryPathEquals,
} from '../storage/repo-manager.js';
import { logger } from '../core/logger.js';
import type { JobManager } from './analyze-job.js';
import type { WorkerMessage } from './analyze-worker.js';

const _require = createRequire(import.meta.url);

export interface LaunchDeps {
  jobManager: JobManager;
  backend: { init: () => Promise<unknown> };
  acquireRepoLock: (key: string) => string | null;
  releaseRepoLock: (key: string) => void;
  /**
   * Drops the server's cached LadybugDB handle (closeLbug). The worker
   * process rewrites the repo's DB files on disk, so a connection opened
   * before the rewrite keeps reading the pre-rewrite state until evicted.
   */
  closeDbHandle: () => Promise<void>;
}

export interface LaunchOptions {
  force?: boolean;
  embeddings?: boolean;
  dropEmbeddings?: boolean;
  registryName?: string;
}

const MAX_WORKER_RETRIES = 2;

/**
 * The worker reports `complete` over IPC before its on-disk finalization
 * (LadybugDB checkpoint + native handle release + metadata write) is visible
 * at `getStoragePath(targetPath)` — observed up to ~6.5s behind the IPC
 * message. Opening the database inside that window is what the pre-IPC
 * ordering was meant to prevent and is actively dangerous: reads fail with
 * binder errors or return an empty graph, the open can quarantine the
 * in-flight WAL, and the native layer racing the rewrite has crashed the
 * whole server (SIGSEGV-class exit, no output) on slow CI runners.
 */
const FINALIZE_SETTLE_TIMEOUT_MS = 60_000;
const FINALIZE_SETTLE_POLL_MS = 200;

/**
 * Resolve once the analyzed repo's index is settled at `storagePath`: the
 * LadybugDB file and metadata both exist AND were (re)written by THIS job
 * (mtime >= jobStartMs — bare existence is not enough, a re-analysis leaves
 * the previous index in place while it works), and no transient WAL/shadow/
 * checkpoint sidecars remain (the worker's native close has finished).
 *
 * Never rejects. Timing out logs and proceeds (pre-gate behavior) rather
 * than failing a job whose analysis genuinely succeeded — e.g. a no-op
 * non-force analyze legitimately rewrites nothing.
 */
/**
 * Look up the analyzed repo's registered storage path. The request's
 * user-provided path is used only as a comparison key; the filesystem probes
 * below run against the registry's own `storagePath` — the server-owned
 * record readers resolve through, and not a user-controlled value
 * (CodeQL js/path-injection).
 */
const registeredStoragePath = async (targetPath: string): Promise<string | null> => {
  const target = canonicalizePath(path.resolve(targetPath));
  const entries = await listRegisteredRepos();
  const entry = entries.find((e) => registryPathEquals(canonicalizePath(e.path), target));
  return entry?.storagePath ?? null;
};

const waitForSettledIndex = async (targetPath: string, jobStartMs: number): Promise<void> => {
  const settled = (storagePath: string): boolean => {
    try {
      const lbugStat = statSync(path.join(storagePath, 'lbug'));
      const metaStat = statSync(path.join(storagePath, INDEX_METADATA_FILE));
      return (
        lbugStat.mtimeMs >= jobStartMs &&
        metaStat.mtimeMs >= jobStartMs &&
        ['lbug.wal', 'lbug.shadow', 'lbug.wal.checkpoint'].every(
          (f) => !existsSync(path.join(storagePath, f)),
        )
      );
    } catch {
      return false; // not written yet
    }
  };
  const deadline = Date.now() + FINALIZE_SETTLE_TIMEOUT_MS;
  for (;;) {
    // Re-resolved each round: the worker registers the repo as part of the
    // finalization this gate is waiting out.
    const storagePath = await registeredStoragePath(targetPath);
    if (storagePath && settled(storagePath)) return;
    if (Date.now() > deadline) {
      logger.warn(
        { targetPath },
        'analyze finalization not visible after timeout; completing job anyway',
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, FINALIZE_SETTLE_POLL_MS));
  }
};

export function createLaunchAnalysisWorker(deps: LaunchDeps) {
  const { jobManager, backend, acquireRepoLock, releaseRepoLock, closeDbHandle } = deps;

  return function launchAnalysisWorker(
    job: { id: string },
    targetPath: string,
    opts: LaunchOptions,
  ): void {
    // For waitForSettledIndex: files (re)written by this job have mtimes at or
    // after this instant. Taken before the fork so no worker write predates it.
    const jobStartMs = Date.now();
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
          // Before marking complete: (1) wait for the worker's on-disk
          // finalization to settle (see waitForSettledIndex), (2) evict the
          // cached DB handle — same invalidation DELETE /api/repo performs, a
          // handle opened before the rewrite reads pre-rewrite state — and
          // only then (3) reinitialize the backend. This makes the ordering
          // comment below true in practice: the repo is actually queryable
          // when the client receives the SSE complete event.
          waitForSettledIndex(targetPath, jobStartMs)
            .then(() => closeDbHandle())
            .catch(() => {}) // best-effort: eviction failure must not fail the job
            .then(() => backend.init())
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
          // A failed (force) analyze may still have rewritten DB files first.
          void closeDbHandle().catch(() => {});
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
