import { Worker } from 'node:worker_threads';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { logger } from '../../logger.js';
export interface WorkerPool {
  /**
   * Dispatch items across workers. Items are split into bounded jobs, each job
   * is committed independently, and stalled jobs are split/retried locally.
   *
   * Files in {@link WorkerPool.getQuarantinedPaths} are filtered out before
   * dispatch — they have already caused a worker death this pool lifetime and
   * are not safe to re-attempt in workers. The caller is responsible for
   * routing them (e.g. to sequential fallback); inspect the quarantine
   * snapshot before and after each dispatch.
   */
  dispatch<TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]>;

  /** Terminate all workers. Must be called when done. */
  terminate(): Promise<void>;

  /** Number of worker slots originally requested for the pool. */
  readonly size: number;

  /**
   * Snapshot of paths quarantined by this pool instance. Populated when a
   * worker dies with an authoritative in-flight file (Layer 4 starting-file
   * message) or a singleton-timeout exclusion. Cleared only by pool teardown
   * — quarantine is session-scoped per `createWorkerPool` invocation.
   */
  getQuarantinedPaths(): readonly string[];
}

export interface WorkerPoolOptions {
  subBatchSize?: number;
  subBatchMaxBytes?: number;
  subBatchIdleTimeoutMs?: number;
  maxTimeoutRetries?: number;
  timeoutBackoffFactor?: number;
  /**
   * Max replacement spawns per worker slot before the slot is dropped from
   * the active rotation. Bounds respawn loops on a slot that consistently
   * crashes the worker (likely a system-level fault rather than a single
   * bad input). Default 3.
   */
  maxRespawnsPerSlot?: number;
  /**
   * Hard ceiling on total wall time the pool will spend retrying / splitting
   * any single job. Combined with `timeoutBackoffFactor`, this prevents
   * exponentially-growing retry waits from accumulating into multi-hour
   * stalls before the pool finally surfaces the bad file to sequential
   * fallback. Default 5x `subBatchIdleTimeoutMs`.
   */
  maxCumulativeTimeoutMs?: number;
  /**
   * Number of consecutive worker deaths (no successful job in between) that
   * trip the pool circuit breaker. Once tripped, the pool rejects every
   * subsequent `dispatch` with `WorkerPoolDispatchError` until a new pool is
   * created. Default `Math.max(3, poolSize)`.
   */
  consecutiveFailureThreshold?: number;
  /**
   * Test-only injection point for the Worker constructor. When provided,
   * the pool uses this factory instead of `new Worker(workerUrl)`. Production
   * code should leave this unset.
   */
  workerFactory?: (workerUrl: URL) => Worker;
}

export class WorkerPoolDispatchError extends Error {
  readonly fallbackExcludePaths: readonly string[];

  constructor(message: string, fallbackExcludePaths: readonly string[] = []) {
    super(message);
    this.name = 'WorkerPoolDispatchError';
    this.fallbackExcludePaths = fallbackExcludePaths;
  }
}

/** Message shapes sent back by worker threads. */
type WorkerOutgoingMessage =
  | { type: 'progress'; filesProcessed: number }
  | { type: 'warning'; message: string }
  | { type: 'sub-batch-done' }
  | { type: 'error'; error: string }
  | { type: 'result'; data: unknown }
  /**
   * Authoritative in-flight signal: worker is about to process this file.
   * Pool records it per slot so worker death can be attributed exactly,
   * instead of guessing from `items[lastProgress]` (which language-grouped
   * worker processing defeats). Optional — older worker builds may not
   * emit it; pool falls back to the heuristic when absent.
   */
  | { type: 'starting-file'; path: string };

interface WorkerJob<TInput> {
  startIndex: number;
  items: TInput[];
  estimatedBytes: number;
  attempt: number;
  splitDepth: number;
  timeoutMs: number;
  /**
   * Running total of timeoutMs across all attempts/splits/respawn-retries
   * for this conceptual unit of work. Tracked separately from `timeoutMs`
   * so we can bound the *total* wait the pool incurs on a single job, not
   * just the current attempt. See {@link WorkerPoolOptions.maxCumulativeTimeoutMs}.
   */
  cumulativeTimeoutMs: number;
}

interface WorkerJobResult<TResult> {
  startIndex: number;
  data: TResult;
}

/**
 * Max files to send to a worker in a single postMessage.
 * Keeps structured-clone memory bounded per sub-batch.
 */
const SUB_BATCH_SIZE = 1500;
const SUB_BATCH_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_SUB_BATCH_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_RETRIES = 1;
const DEFAULT_TIMEOUT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_RESPAWNS_PER_SLOT = 3;
const DEFAULT_MAX_CUMULATIVE_TIMEOUT_FACTOR = 5;
const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD_FLOOR = 3;

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : undefined;
}

interface ResolvedWorkerPoolOptions {
  subBatchSize: number;
  subBatchMaxBytes: number;
  subBatchIdleTimeoutMs: number;
  maxTimeoutRetries: number;
  timeoutBackoffFactor: number;
  maxRespawnsPerSlot: number;
  maxCumulativeTimeoutMs: number;
  consecutiveFailureThreshold: number;
}

export function resolveWorkerPoolOptions(
  options: WorkerPoolOptions = {},
  poolSize?: number,
): ResolvedWorkerPoolOptions {
  const subBatchIdleTimeoutMs =
    positiveInteger(options.subBatchIdleTimeoutMs) ??
    positiveInteger(process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS) ??
    DEFAULT_SUB_BATCH_IDLE_TIMEOUT_MS;
  return {
    subBatchSize: positiveInteger(options.subBatchSize) ?? SUB_BATCH_SIZE,
    subBatchMaxBytes:
      positiveInteger(options.subBatchMaxBytes) ??
      positiveInteger(process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES) ??
      SUB_BATCH_MAX_BYTES,
    subBatchIdleTimeoutMs,
    maxTimeoutRetries: nonNegativeInteger(options.maxTimeoutRetries) ?? DEFAULT_TIMEOUT_RETRIES,
    timeoutBackoffFactor:
      positiveInteger(options.timeoutBackoffFactor) ?? DEFAULT_TIMEOUT_BACKOFF_FACTOR,
    maxRespawnsPerSlot:
      nonNegativeInteger(options.maxRespawnsPerSlot) ??
      nonNegativeInteger(process.env.GITNEXUS_WORKER_MAX_RESPAWNS_PER_SLOT) ??
      DEFAULT_MAX_RESPAWNS_PER_SLOT,
    maxCumulativeTimeoutMs:
      positiveInteger(options.maxCumulativeTimeoutMs) ??
      positiveInteger(process.env.GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS) ??
      subBatchIdleTimeoutMs * DEFAULT_MAX_CUMULATIVE_TIMEOUT_FACTOR,
    consecutiveFailureThreshold:
      positiveInteger(options.consecutiveFailureThreshold) ??
      positiveInteger(process.env.GITNEXUS_WORKER_CONSECUTIVE_FAILURE_THRESHOLD) ??
      Math.max(DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD_FLOOR, poolSize ?? 0),
  };
}

function waitForWorkerOnline(worker: Worker): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      worker.removeListener('online', onOnline);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Replacement worker exited with code ${code} before coming online`));
    };
    worker.once('online', onOnline);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });
}

function estimateItemBytes(item: unknown): number {
  if (typeof item !== 'object' || item === null) return 0;
  const content = (item as { content?: unknown }).content;
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0;
}

function itemPath(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const path = (item as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

/**
 * Best-guess path of the file in flight when a worker dies mid-job — used as
 * the fallback when the authoritative `starting-file` message hasn't been
 * observed yet (very early job-startup crash, or older worker build that
 * doesn't emit the signal).
 *
 * `lastProgress` is the number of files the worker has acknowledged via
 * `progress` messages, so `items[lastProgress]` is the next file it was
 * about to process — the most likely culprit when the worker crashes
 * (OOM, native addon SIGSEGV) or reports an error.
 *
 * Returns `[]` when no path is determinable so the caller retries the whole
 * job.
 */
function inFlightExcludePath<TInput>(job: WorkerJob<TInput>, lastProgress: number): string[] {
  if (lastProgress >= job.items.length) return [];
  const path = itemPath(job.items[lastProgress]);
  return path ? [path] : [];
}

function createJobs<TInput>(
  items: TInput[],
  maxItems: number,
  maxBytes: number,
  timeoutMs: number,
): WorkerJob<TInput>[] {
  const jobs: WorkerJob<TInput>[] = [];
  let startIndex = 0;
  let batch: TInput[] = [];
  let batchBytes = 0;

  const flush = () => {
    if (batch.length === 0) return;
    jobs.push({
      startIndex,
      items: batch,
      estimatedBytes: batchBytes,
      attempt: 0,
      splitDepth: 0,
      timeoutMs,
      cumulativeTimeoutMs: timeoutMs,
    });
    startIndex += batch.length;
    batch = [];
    batchBytes = 0;
  };

  for (const item of items) {
    const itemBytes = estimateItemBytes(item);
    const wouldExceedItems = batch.length >= maxItems;
    const wouldExceedBytes = batch.length > 0 && batchBytes + itemBytes > maxBytes;
    if (wouldExceedItems || wouldExceedBytes) flush();
    batch.push(item);
    batchBytes += itemBytes;
  }
  flush();
  return jobs;
}

/**
 * Create a pool of worker threads.
 *
 * Resilience model (PR #1693 / 1694):
 * - Layer 1 (auto-respawn): a worker `error`/`exit` triggers a replacement on
 *   the same slot, bounded by {@link WorkerPoolOptions.maxRespawnsPerSlot}.
 *   The slot is dropped from the rotation when its budget is exhausted.
 * - Layer 2 (circuit breaker): `consecutiveFailureThreshold` consecutive
 *   worker deaths (no successful job between) — OR all slots exhausting their
 *   respawn budget — trip the breaker. Every subsequent dispatch rejects
 *   with `WorkerPoolDispatchError` and the caller must build a new pool.
 * - Layer 3 (quarantine): a path identified as the in-flight file at the
 *   time of a worker death is added to `quarantined` and filtered out of
 *   future dispatches. Snapshot via {@link WorkerPool.getQuarantinedPaths}.
 * - Layer 4 (authoritative in-flight): the worker emits a `starting-file`
 *   message before each parse attempt; the pool prefers this for crash
 *   attribution and falls back to {@link inFlightExcludePath} only when no
 *   signal has been observed yet.
 * - Layer 5 (cumulative timeout budget): each job tracks the total wall
 *   time spent across all attempts/splits/retries. When the budget is
 *   exhausted, the pool surfaces the in-flight path via `WorkerPoolDispatchError`
 *   instead of letting timeouts compound indefinitely.
 */
export const createWorkerPool = (
  workerUrl: URL,
  poolSize?: number,
  options?: WorkerPoolOptions,
): WorkerPool => {
  // Validate worker script exists before spawning to prevent uncaught
  // MODULE_NOT_FOUND crashes in worker threads (e.g. when running from src/ via vitest)
  const workerPath = fileURLToPath(workerUrl);
  if (!fs.existsSync(workerPath)) {
    throw new Error(`Worker script not found: ${workerPath}`);
  }

  const size = poolSize ?? Math.min(8, Math.max(1, os.cpus().length - 1));
  const poolOptions = resolveWorkerPoolOptions(options, size);
  const spawnWorker = options?.workerFactory ?? ((url: URL) => new Worker(url));
  const workers: (Worker | undefined)[] = new Array(size);
  const respawnCount: number[] = new Array(size).fill(0);
  const activeSlots: Set<number> = new Set();
  const quarantined: Set<string> = new Set();
  let consecutiveFailures = 0;
  let poolBroken = false;
  let poolFailure: Error | undefined;

  for (let i = 0; i < size; i++) {
    workers[i] = spawnWorker(workerUrl);
    activeSlots.add(i);
  }

  const dispatch = <TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]> => {
    if (poolBroken) {
      const reason = poolFailure ? `: ${poolFailure.message}` : '';
      return Promise.reject(
        new WorkerPoolDispatchError(
          `Worker pool circuit breaker tripped${reason}. ` +
            `Subsequent dispatches require a fresh pool instance.`,
          [],
        ),
      );
    }
    if (items.length === 0) return Promise.resolve([]);
    if (activeSlots.size === 0) {
      return Promise.reject(new WorkerPoolDispatchError('Worker pool has no active workers', []));
    }

    // Layer 3: filter out quarantined paths so a known-bad file never reaches
    // a worker again this pool lifetime. The caller queries
    // `getQuarantinedPaths` after dispatch to route filtered items.
    const dispatchableItems: TInput[] = [];
    for (const item of items) {
      const path = itemPath(item);
      if (path !== undefined && quarantined.has(path)) continue;
      dispatchableItems.push(item);
    }
    if (dispatchableItems.length === 0) return Promise.resolve([]);

    const jobs = createJobs(
      dispatchableItems,
      poolOptions.subBatchSize,
      poolOptions.subBatchMaxBytes,
      poolOptions.subBatchIdleTimeoutMs,
    );

    return new Promise<TResult[]>((resolve, reject) => {
      const results: WorkerJobResult<TResult>[] = [];
      const inFlightProgress = new Array(size).fill(0);
      // Tracks which slots are currently mid-job so the "wake idle slots"
      // pass after a requeue doesn't double-dispatch to a busy slot.
      const busySlots: Set<number> = new Set();
      let completedFiles = 0;
      let activeWorkers = 0;
      let stopped = false;
      let maxReported = 0;

      const wakeIdleSlots = () => {
        if (stopped || jobs.length === 0) return;
        for (const slot of activeSlots) {
          if (busySlots.has(slot)) continue;
          if (jobs.length === 0) break;
          runWorker(slot);
        }
      };

      const reportProgress = () => {
        if (!onProgress) return;
        const inFlight = inFlightProgress.reduce((sum, value) => sum + value, 0);
        const next = Math.min(
          dispatchableItems.length,
          Math.max(maxReported, completedFiles + inFlight),
        );
        if (next === maxReported) return;
        maxReported = next;
        onProgress(next);
      };

      const replaceWorker = async (workerIndex: number): Promise<boolean> => {
        const existing = workers[workerIndex];
        await existing?.terminate().catch(() => undefined);
        workers[workerIndex] = undefined;
        if (stopped) return false;
        const replacement = spawnWorker(workerUrl);
        try {
          await waitForWorkerOnline(replacement);
        } catch (err) {
          await replacement.terminate().catch(() => undefined);
          logger.warn(
            { workerIndex, error: err instanceof Error ? err.message : String(err) },
            `Worker ${workerIndex} replacement failed to come online; dropping slot.`,
          );
          return false;
        }
        if (stopped) {
          await replacement.terminate().catch(() => undefined);
          return false;
        }
        workers[workerIndex] = replacement;
        return true;
      };

      // Terminal failure path: trip the pool circuit breaker and reject the
      // outer dispatch promise with the cumulative exclude paths. This is the
      // ONLY place that sets `poolBroken = true` — recoverable single-worker
      // failures stay local to `handleWorkerDeath`.
      const tripBreaker = async (err: WorkerPoolDispatchError) => {
        poolBroken = true;
        poolFailure = err;
        if (stopped) return;
        stopped = true;
        await Promise.all(workers.map((worker) => worker?.terminate().catch(() => undefined)));
        for (let i = 0; i < workers.length; i++) workers[i] = undefined;
        activeSlots.clear();
        reject(err);
      };

      const maybeDone = () => {
        if (stopped) return;
        if (jobs.length === 0 && activeWorkers === 0) {
          stopped = true;
          results.sort((a, b) => a.startIndex - b.startIndex);
          if (onProgress && maxReported < dispatchableItems.length)
            onProgress(dispatchableItems.length);
          resolve(results.map((result) => result.data));
        }
      };

      // Re-queue the non-quarantined remainder of a dead worker's job so a
      // healthy worker can finish the work. Earlier items in the dead job
      // were never flushed back to the main thread, so they must be
      // re-processed. The new job carries the existing job's startIndex so
      // result ordering is preserved.
      const requeueRemainder = (job: WorkerJob<TInput>, excluded: readonly string[]) => {
        if (excluded.length === 0) {
          jobs.unshift(job);
          return;
        }
        const excludeSet = new Set(excluded);
        const filtered = job.items.filter((item) => {
          const p = itemPath(item);
          return p === undefined || !excludeSet.has(p);
        });
        if (filtered.length === 0) return;
        const requeueTimeoutMs = job.timeoutMs;
        jobs.unshift({
          startIndex: job.startIndex,
          items: filtered,
          estimatedBytes: filtered.reduce((sum, item) => sum + estimateItemBytes(item), 0),
          attempt: job.attempt,
          splitDepth: job.splitDepth,
          timeoutMs: requeueTimeoutMs,
          cumulativeTimeoutMs: job.cumulativeTimeoutMs + requeueTimeoutMs,
        });
      };

      // Recoverable worker death — quarantine the in-flight path, attempt
      // to respawn the slot, re-queue the rest of the job, and continue.
      // Trips the circuit breaker only when consecutiveFailures crosses the
      // threshold OR all slots have exhausted their respawn budget.
      const handleWorkerDeath = async (
        workerIndex: number,
        reason: string,
        excludePaths: readonly string[],
      ) => {
        if (stopped) return;
        consecutiveFailures++;
        for (const p of excludePaths) {
          if (p) quarantined.add(p);
        }
        if (consecutiveFailures >= poolOptions.consecutiveFailureThreshold) {
          void tripBreaker(
            new WorkerPoolDispatchError(
              `${reason}. Pool circuit breaker tripped after ${consecutiveFailures} ` +
                `consecutive failures (threshold: ${poolOptions.consecutiveFailureThreshold}).`,
              Array.from(quarantined),
            ),
          );
          return;
        }
        respawnCount[workerIndex]++;
        if (respawnCount[workerIndex] > poolOptions.maxRespawnsPerSlot) {
          logger.warn(
            {
              workerIndex,
              respawnCount: respawnCount[workerIndex],
              maxRespawns: poolOptions.maxRespawnsPerSlot,
              reason,
            },
            `Worker ${workerIndex} exceeded respawn budget; dropping slot.`,
          );
          const dead = workers[workerIndex];
          await dead?.terminate().catch(() => undefined);
          workers[workerIndex] = undefined;
          activeSlots.delete(workerIndex);
          if (activeSlots.size === 0) {
            void tripBreaker(
              new WorkerPoolDispatchError(
                `${reason}. All ${size} worker slot(s) exhausted their respawn budget.`,
                Array.from(quarantined),
              ),
            );
            return;
          }
          return;
        }
        logger.warn(
          {
            workerIndex,
            respawnCount: respawnCount[workerIndex],
            reason,
            excludePaths,
          },
          `Worker ${workerIndex} died; respawning slot (attempt ${respawnCount[workerIndex]}/${poolOptions.maxRespawnsPerSlot}).`,
        );
        const respawned = await replaceWorker(workerIndex);
        if (!respawned) {
          activeSlots.delete(workerIndex);
          if (activeSlots.size === 0) {
            void tripBreaker(
              new WorkerPoolDispatchError(
                `${reason}. Replacement worker startup failed and no slots remain.`,
                Array.from(quarantined),
              ),
            );
          }
          return;
        }
      };

      const requeueAfterTimeout = (
        workerIndex: number,
        job: WorkerJob<TInput>,
        lastProgress: number,
        inFlightPath: string | undefined,
      ): boolean => {
        const nextTimeout = Math.ceil(job.timeoutMs * poolOptions.timeoutBackoffFactor);
        const nextCumulative = job.cumulativeTimeoutMs + nextTimeout;

        // Layer 5: respect the per-job cumulative timeout budget. Once
        // exhausted, surface the in-flight file via WorkerPoolDispatchError
        // instead of letting exponential backoff stall further.
        if (nextCumulative > poolOptions.maxCumulativeTimeoutMs) {
          const exhausted =
            inFlightPath !== undefined
              ? [inFlightPath]
              : itemPath(job.items[0])
                ? [itemPath(job.items[0]) as string]
                : [];
          logger.warn(
            {
              workerIndex,
              cumulativeMs: job.cumulativeTimeoutMs,
              nextCumulativeMs: nextCumulative,
              maxCumulativeMs: poolOptions.maxCumulativeTimeoutMs,
              exhausted,
            },
            `Worker ${workerIndex} parse job exhausted cumulative timeout budget. Surfacing in-flight file(s).`,
          );
          void handleWorkerDeath(
            workerIndex,
            `Worker ${workerIndex} parse job exhausted cumulative timeout budget ` +
              `(${(nextCumulative / 1000).toFixed(0)}s > ${(poolOptions.maxCumulativeTimeoutMs / 1000).toFixed(0)}s cap)`,
            exhausted,
          );
          return false;
        }

        if (job.items.length > 1) {
          const midpoint = Math.ceil(job.items.length / 2);
          const firstItems = job.items.slice(0, midpoint);
          const secondItems = job.items.slice(midpoint);
          const first: WorkerJob<TInput> = {
            startIndex: job.startIndex,
            items: firstItems,
            estimatedBytes: firstItems.reduce((sum, item) => sum + estimateItemBytes(item), 0),
            attempt: job.attempt,
            splitDepth: job.splitDepth + 1,
            timeoutMs: nextTimeout,
            cumulativeTimeoutMs: nextCumulative,
          };
          const second: WorkerJob<TInput> = {
            startIndex: job.startIndex + midpoint,
            items: secondItems,
            estimatedBytes: secondItems.reduce((sum, item) => sum + estimateItemBytes(item), 0),
            attempt: job.attempt,
            splitDepth: job.splitDepth + 1,
            timeoutMs: nextTimeout,
            cumulativeTimeoutMs: nextCumulative,
          };
          logger.warn(
            {
              workerIndex,
              timeoutSec: job.timeoutMs / 1000,
              items: job.items.length,
              estimatedBytes: job.estimatedBytes,
              lastProgress,
              firstSplitItems: first.items.length,
              secondSplitItems: second.items.length,
              nextTimeoutSec: nextTimeout / 1000,
            },
            `Worker ${workerIndex} parse job idle timeout. Splitting into ${first.items.length}/${second.items.length} item jobs.`,
          );
          // Preserve intuitive retry order; final result order is still enforced by startIndex sort.
          jobs.unshift(first, second);
          return true;
        }

        const nextAttempt = job.attempt + 1;
        if (nextAttempt <= poolOptions.maxTimeoutRetries) {
          logger.warn(
            {
              workerIndex,
              timeoutSec: job.timeoutMs / 1000,
              attempt: nextAttempt,
              maxAttempts: poolOptions.maxTimeoutRetries + 1,
              nextTimeoutSec: nextTimeout / 1000,
            },
            `Worker ${workerIndex} parse job idle timeout (single item). Retrying with ${nextTimeout / 1000}s timeout.`,
          );
          jobs.unshift({
            ...job,
            attempt: nextAttempt,
            timeoutMs: nextTimeout,
            cumulativeTimeoutMs: nextCumulative,
          });
          return true;
        }

        const stalledPath = inFlightPath ?? itemPath(job.items[0]);
        const excludes = stalledPath ? [stalledPath] : [];
        logger.warn(
          {
            workerIndex,
            timeoutSec: job.timeoutMs / 1000,
            stalledPath,
            cumulativeMs: job.cumulativeTimeoutMs,
          },
          `Worker ${workerIndex} parse job idle timeout exhausted retries; quarantining file and respawning slot.`,
        );
        void handleWorkerDeath(
          workerIndex,
          `Worker ${workerIndex} parse job idle timeout after ${job.timeoutMs / 1000}s ` +
            `(single item${stalledPath ? `: ${stalledPath}` : ''}, ` +
            `${job.estimatedBytes} bytes, last progress: ${lastProgress})`,
          excludes,
        );
        return false;
      };

      const runWorker = (workerIndex: number) => {
        if (stopped) return;
        if (!activeSlots.has(workerIndex)) return;
        const job = jobs.shift();
        if (!job) {
          maybeDone();
          return;
        }

        // Drop quarantined items that may have been re-queued before a death
        // added them to quarantine — keeps the worker from ever seeing a
        // known-bad file.
        if (quarantined.size > 0) {
          const dispatchable = job.items.filter((item) => {
            const p = itemPath(item);
            return p === undefined || !quarantined.has(p);
          });
          if (dispatchable.length === 0) {
            // Whole job was quarantined; drop and try next.
            runWorker(workerIndex);
            return;
          }
          if (dispatchable.length !== job.items.length) {
            job.items = dispatchable;
            job.estimatedBytes = dispatchable.reduce(
              (sum, item) => sum + estimateItemBytes(item),
              0,
            );
          }
        }

        activeWorkers++;
        busySlots.add(workerIndex);
        inFlightProgress[workerIndex] = 0;
        const worker = workers[workerIndex];
        if (!worker) {
          // Slot was dropped between scheduling and execution; requeue the
          // job for another slot and bail.
          activeWorkers--;
          busySlots.delete(workerIndex);
          jobs.unshift(job);
          wakeIdleSlots();
          maybeDone();
          return;
        }
        let settled = false;
        let waitingForFlush = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let lastProgress = 0;
        // Authoritative in-flight file from the worker's `starting-file`
        // message. Cleared on `progress` so a between-files crash falls
        // back to the `items[lastProgress]` heuristic, which then points
        // at the next file (the one about to start) — the right guess.
        let inFlightPath: string | undefined;

        const resolveExcludePaths = (): readonly string[] => {
          if (inFlightPath !== undefined) return [inFlightPath];
          return inFlightExcludePath(job, lastProgress);
        };

        const cleanup = () => {
          if (idleTimer) clearTimeout(idleTimer);
          worker.removeListener('message', handler);
          worker.removeListener('error', errorHandler);
          worker.removeListener('exit', exitHandler);
        };

        const finishJob = () => {
          activeWorkers--;
          busySlots.delete(workerIndex);
          inFlightProgress[workerIndex] = 0;
          runWorker(workerIndex);
          maybeDone();
        };

        // Recover-and-resume flow shared by all in-pool worker death sites
        // (`error`, `exit`, msg-channel error). Bridges the per-job teardown
        // into the pool-level handleWorkerDeath recovery + breaker logic.
        const recoverAndResume = async (reason: string, excludePaths: readonly string[]) => {
          activeWorkers--;
          busySlots.delete(workerIndex);
          inFlightProgress[workerIndex] = 0;
          requeueRemainder(job, excludePaths);
          await handleWorkerDeath(workerIndex, reason, excludePaths);
          if (stopped) return;
          // Slot may have been dropped or respawned. Kick the current slot
          // if still active, then wake any other idle live slots so the
          // requeued remainder can be picked up immediately (without this,
          // dropped-slot scenarios can deadlock when no other slot is
          // currently busy and the next finishJob never fires).
          if (activeSlots.has(workerIndex)) {
            runWorker(workerIndex);
          }
          wakeIdleSlots();
          maybeDone();
        };

        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              inFlightProgress[workerIndex] = 0;
              const stalledPath = inFlightPath;
              const shouldContinue = requeueAfterTimeout(
                workerIndex,
                job,
                lastProgress,
                stalledPath,
              );
              if (!shouldContinue) {
                // handleWorkerDeath path was taken by requeueAfterTimeout;
                // recover the slot (respawn if budget allows) and continue.
                void (async () => {
                  activeWorkers--;
                  busySlots.delete(workerIndex);
                  if (stopped) return;
                  if (activeSlots.has(workerIndex)) {
                    const respawned = await replaceWorker(workerIndex);
                    if (!respawned) activeSlots.delete(workerIndex);
                  }
                  if (stopped) return;
                  if (activeSlots.has(workerIndex)) {
                    runWorker(workerIndex);
                  }
                  wakeIdleSlots();
                  maybeDone();
                })();
                return;
              }
              // Timeout-retry path: spawn a fresh worker on this slot to
              // pick up the next attempt.
              void (async () => {
                try {
                  const respawned = await replaceWorker(workerIndex);
                  if (!respawned) {
                    activeSlots.delete(workerIndex);
                  }
                } finally {
                  activeWorkers--;
                  busySlots.delete(workerIndex);
                }
                if (stopped) return;
                reportProgress();
                if (activeSlots.has(workerIndex)) runWorker(workerIndex);
                wakeIdleSlots();
                maybeDone();
              })();
            }
          }, job.timeoutMs);
        };

        const handler = (msg: WorkerOutgoingMessage) => {
          if (settled || stopped) return;
          if (msg.type === 'starting-file') {
            inFlightPath = msg.path;
            resetIdleTimer();
          } else if (msg.type === 'progress') {
            const bounded = Math.min(job.items.length, Math.max(0, msg.filesProcessed));
            inFlightProgress[workerIndex] = bounded;
            lastProgress = bounded;
            inFlightPath = undefined;
            resetIdleTimer();
            reportProgress();
          } else if (msg.type === 'warning') {
            resetIdleTimer();
            logger.warn(msg.message);
          } else if (msg.type === 'sub-batch-done') {
            waitingForFlush = true;
            resetIdleTimer();
            worker.postMessage({ type: 'flush' });
          } else if (msg.type === 'error') {
            settled = true;
            cleanup();
            void recoverAndResume(
              `Worker ${workerIndex} error: ${msg.error}`,
              resolveExcludePaths(),
            );
          } else if (msg.type === 'result') {
            if (!waitingForFlush) {
              settled = true;
              cleanup();
              void tripBreaker(
                new WorkerPoolDispatchError(
                  `Worker ${workerIndex} protocol error: result before flush`,
                  Array.from(quarantined),
                ),
              );
              return;
            }
            settled = true;
            cleanup();
            results.push({ startIndex: job.startIndex, data: msg.data as TResult });
            completedFiles += job.items.length;
            // Layer 2: a successful job resets the consecutive-failure
            // counter so transient bursts of bad files don't trip the
            // breaker prematurely.
            consecutiveFailures = 0;
            reportProgress();
            finishJob();
          }
        };

        const errorHandler = (err: Error) => {
          if (!settled) {
            settled = true;
            cleanup();
            void recoverAndResume(
              `Worker ${workerIndex} error: ${err.message}`,
              resolveExcludePaths(),
            );
          }
        };

        const exitHandler = (code: number) => {
          if (!settled) {
            settled = true;
            cleanup();
            const excludes = resolveExcludePaths();
            const inFlightSuffix = excludes.length > 0 ? ` (in-flight: ${excludes[0]})` : '';
            void recoverAndResume(
              `Worker ${workerIndex} exited with code ${code}. ` +
                `Likely OOM or native addon failure${inFlightSuffix}.`,
              excludes,
            );
          }
        };

        worker.on('message', handler);
        worker.once('error', errorHandler);
        worker.once('exit', exitHandler);
        resetIdleTimer();
        if (stopped) {
          cleanup();
          return;
        }
        worker.postMessage({ type: 'sub-batch', files: job.items });
      };

      for (const slotIndex of activeSlots) runWorker(slotIndex);
    });
  };

  const terminate = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w?.terminate()));
    workers.length = 0;
    activeSlots.clear();
  };

  return {
    dispatch,
    terminate,
    size,
    getQuarantinedPaths: () => Array.from(quarantined),
  };
};
