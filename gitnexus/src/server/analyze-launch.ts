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
import { autoHeapCapMb } from '../core/ingestion/utils/effective-ram.js';
import { isTerminalJobStatus, type JobManager } from './analyze-job.js';
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
  springActuatorPath?: string;
  asyncApiSpecPath?: string;
  registryName?: string;
  /**
   * Index-branch selector, forwarded to `AnalyzeOptions.branch` so a run pins
   * the per-branch slot (`branches/<slug>/`) instead of the flat one. The
   * caller is responsible for having the branch checked out — `resolveWriteTarget`
   * in core refuses a label that disagrees with the working tree, which is what
   * keeps one branch's content out of another's slot (#2106).
   */
  branch?: string;
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

    // Worker heap: 8192MB historical default, but never above what this
    // machine/container actually has (#2649 review — a fixed 8192 inside a
    // smaller cgroup limit died to the kernel with a misleading remedy).
    // GITNEXUS_SERVER_ANALYZE_HEAP_MB overrides as an absolute value.
    const envHeapMb = Number(process.env.GITNEXUS_SERVER_ANALYZE_HEAP_MB);
    const workerHeapMb =
      Number.isInteger(envHeapMb) && envHeapMb > 0 ? envHeapMb : Math.min(8192, autoHeapCapMb());

    const forkWorker = () => {
      const currentJob = jobManager.getJob(job.id);
      if (!currentJob || isTerminalJobStatus(currentJob.status)) return;

      const child = fork(workerPath, [], {
        execArgv: [...tsxHookArgs, `--max-old-space-size=${workerHeapMb}`],
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
        if (!current || isTerminalJobStatus(current.status)) return;

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
          // handle opened before the rewrite reads pre-rewrite state — (3)
          // decide the outcome, and only then (4) reinitialize the backend,
          // which is what PUBLISHES the index. This makes the ordering comment
          // below true in practice: the repo is actually queryable when the
          // client receives the SSE complete event, and an index this run knows
          // to be incomplete is never published at all.
          waitForSettledIndex(targetPath, jobStartMs)
            .then(() => closeDbHandle())
            .catch(() => {}) // best-effort: eviction failure must not fail the job
            .then(() => {
              // PARITY WITH THE CLI, which is what the IPC projection was added
              // for. `analyze-worker-ipc.ts` carries `graphWriteCollapsed`
              // "so a server-side caller sees the same degraded outcome the CLI
              // does" — but nothing here read it, so the comment described an
              // intention rather than the shipped behaviour and every collapsed
              // run reported `complete` to the UI and to every API consumer.
              //
              // `failed` rather than `complete`, because that is the CLI's
              // choice: it prints `Repository indexed INCOMPLETELY` and exits
              // non-zero. The index exists but most of its edges do not, and a
              // consumer that reads "complete" will query it and get confident
              // wrong answers — the precise failure this whole guard exists to
              // stop. The message names the remedy, and a re-run now forces a
              // full rebuild on its own (see the `graphWriteCollapsed` trigger
              // in run-analyze.ts).
              //
              // ── THE CHECK RUNS BEFORE `backend.init()`, AND THAT ORDER IS
              // THE GUARD ── `backend.init()` is the PUBLISH step: it is
              // `refreshRepos()`, which re-reads the registry and swaps the
              // freshly-registered repo into the in-memory map every MCP tool
              // and HTTP route resolves through. Running it first (as this
              // chain used to) made the collapsed database live and queryable
              // before the job was ever marked `failed`, so `status` was a
              // label on an already-published index rather than a gate — and
              // `backend-client.ts` routes the `failed` SSE event to
              // `onError()` without ever calling `onComplete`, so the UI showed
              // an error toast while every query answered from the incomplete
              // graph. Publication cannot be undone from here (nothing on the
              // backend un-registers a repo), so the only correct order is to
              // decide first and publish second.
              //
              // `closeDbHandle()` above still runs on both paths, and must: the
              // worker rewrote the DB files on disk, so a handle opened before
              // the rewrite reads pre-rewrite state whatever the outcome was.
              // Evicting it is not publication — it drops a cached connection,
              // it does not add anything to the repo map.
              const collapse = msg.result.graphWriteCollapsed;
              if (collapse) {
                // NOT published. `repoName` is reported even so: the success
                // path sets it (`api.ts`'s repo-resolution wait matches jobs on
                // `repoName` first and falls back to `repoUrl`/`repoPath`
                // basenames), and a failure that drops it silently costs one of
                // those three match keys for no reason.
                jobManager.updateJob(job.id, {
                  status: 'failed',
                  repoName: msg.result.repoName,
                  error:
                    `Repository indexed INCOMPLETELY: only ${collapse.persisted} of ` +
                    `${collapse.expected} expected relationships are readable. The index was not ` +
                    `marked fresh and was NOT published to this server — a first-time analyze ` +
                    `stays unreachable until a run succeeds (a previously published index for ` +
                    `this repo keeps being served). Re-run the analysis — it will rebuild from ` +
                    `scratch.`,
                });
                return;
              }
              // Healthy run only: publish, then report complete. This keeps the
              // ordering comment above the chain true — the repo really is
              // queryable when the client receives the SSE complete event.
              return backend.init().then(() => {
                jobManager.updateJob(job.id, { status: 'complete', repoName: msg.result.repoName });
              });
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
        if (!j || isTerminalJobStatus(j.status)) return;

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
          ...(opts.springActuatorPath ? { springActuatorPath: opts.springActuatorPath } : {}),
          ...(opts.asyncApiSpecPath ? { asyncApiSpecPath: opts.asyncApiSpecPath } : {}),
          ...(opts.registryName ? { registryName: opts.registryName } : {}),
          ...(opts.branch ? { branch: opts.branch } : {}),
        },
      });
    };

    forkWorker();
  };
}
