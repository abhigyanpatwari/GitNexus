import { Worker } from 'node:worker_threads';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface WorkerPool {
  /**
   * Dispatch items across workers. Items are split into bounded jobs, each job
   * is committed independently, and stalled jobs are split/retried locally.
   */
  dispatch<TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]>;

  /** Terminate all workers. Must be called when done. */
  terminate(): Promise<void>;

  /** Number of workers in the pool */
  readonly size: number;
}

export interface WorkerPoolOptions {
  subBatchSize?: number;
  subBatchMaxBytes?: number;
  subBatchIdleTimeoutMs?: number;
  maxTimeoutRetries?: number;
  timeoutBackoffFactor?: number;
}

/** Message shapes sent back by worker threads. */
type WorkerOutgoingMessage =
  | { type: 'progress'; filesProcessed: number }
  | { type: 'warning'; message: string }
  | { type: 'sub-batch-done' }
  | { type: 'error'; error: string }
  | { type: 'result'; data: unknown };

interface WorkerJob<TInput> {
  startIndex: number;
  items: TInput[];
  estimatedBytes: number;
  attempt: number;
  splitDepth: number;
  timeoutMs: number;
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

export function resolveWorkerPoolOptions(
  options: WorkerPoolOptions = {},
): Required<WorkerPoolOptions> {
  return {
    subBatchSize: positiveInteger(options.subBatchSize) ?? SUB_BATCH_SIZE,
    subBatchMaxBytes:
      positiveInteger(options.subBatchMaxBytes) ??
      positiveInteger(process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES) ??
      SUB_BATCH_MAX_BYTES,
    subBatchIdleTimeoutMs:
      positiveInteger(options.subBatchIdleTimeoutMs) ??
      positiveInteger(process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS) ??
      DEFAULT_SUB_BATCH_IDLE_TIMEOUT_MS,
    maxTimeoutRetries: nonNegativeInteger(options.maxTimeoutRetries) ?? DEFAULT_TIMEOUT_RETRIES,
    timeoutBackoffFactor:
      positiveInteger(options.timeoutBackoffFactor) ?? DEFAULT_TIMEOUT_BACKOFF_FACTOR,
  };
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
  const poolOptions = resolveWorkerPoolOptions(options);
  const workers: Worker[] = [];
  let poolBroken = false;
  let poolFailure: Error | undefined;

  for (let i = 0; i < size; i++) {
    workers.push(new Worker(workerUrl));
  }

  const dispatch = <TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]> => {
    if (poolBroken) {
      const reason = poolFailure ? `: ${poolFailure.message}` : '';
      return Promise.reject(
        new Error(`Worker pool is unavailable after a previous failure${reason}`),
      );
    }
    if (items.length === 0) return Promise.resolve([]);
    if (workers.length === 0) return Promise.reject(new Error('Worker pool has no active workers'));

    const jobs = createJobs(
      items,
      poolOptions.subBatchSize,
      poolOptions.subBatchMaxBytes,
      poolOptions.subBatchIdleTimeoutMs,
    );

    return new Promise<TResult[]>((resolve, reject) => {
      const results: WorkerJobResult<TResult>[] = [];
      const inFlightProgress = new Array(workers.length).fill(0);
      let completedFiles = 0;
      let activeWorkers = 0;
      let stopped = false;
      let maxReported = 0;

      const reportProgress = () => {
        if (!onProgress) return;
        const inFlight = inFlightProgress.reduce((sum, value) => sum + value, 0);
        const next = Math.min(items.length, Math.max(maxReported, completedFiles + inFlight));
        if (next === maxReported) return;
        maxReported = next;
        onProgress(next);
      };

      const replaceWorker = async (workerIndex: number) => {
        const worker = workers[workerIndex];
        await worker?.terminate().catch(() => undefined);
        if (!stopped) workers[workerIndex] = new Worker(workerUrl);
      };

      const fail = async (err: Error) => {
        poolBroken = true;
        poolFailure = err;
        if (stopped) return;
        stopped = true;
        await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
        reject(err);
      };

      const maybeDone = () => {
        if (stopped) return;
        if (jobs.length === 0 && activeWorkers === 0) {
          stopped = true;
          results.sort((a, b) => a.startIndex - b.startIndex);
          if (onProgress && maxReported < items.length) onProgress(items.length);
          resolve(results.map((result) => result.data));
        }
      };

      const requeueAfterTimeout = (
        workerIndex: number,
        job: WorkerJob<TInput>,
        lastProgress: number,
      ): boolean => {
        const nextTimeout = Math.ceil(job.timeoutMs * poolOptions.timeoutBackoffFactor);

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
          };
          const second: WorkerJob<TInput> = {
            startIndex: job.startIndex + midpoint,
            items: secondItems,
            estimatedBytes: secondItems.reduce((sum, item) => sum + estimateItemBytes(item), 0),
            attempt: job.attempt,
            splitDepth: job.splitDepth + 1,
            timeoutMs: nextTimeout,
          };
          console.warn(
            `Worker ${workerIndex} parse job idle timeout after ${job.timeoutMs / 1000}s ` +
              `(${job.items.length} items, ${job.estimatedBytes} bytes, last progress: ${lastProgress}). ` +
              `Splitting into ${first.items.length}/${second.items.length} item jobs with ` +
              `${nextTimeout / 1000}s timeout.`,
          );
          // Preserve intuitive retry order; final result order is still enforced by startIndex sort.
          jobs.unshift(first, second);
          return true;
        }

        const nextAttempt = job.attempt + 1;
        if (nextAttempt <= poolOptions.maxTimeoutRetries) {
          console.warn(
            `Worker ${workerIndex} parse job idle timeout after ${job.timeoutMs / 1000}s ` +
              `(single item, attempt ${nextAttempt}/${poolOptions.maxTimeoutRetries + 1}). ` +
              `Retrying with ${nextTimeout / 1000}s timeout.`,
          );
          jobs.unshift({
            ...job,
            attempt: nextAttempt,
            timeoutMs: nextTimeout,
          });
          return true;
        }

        void fail(
          new Error(
            `Worker ${workerIndex} parse job idle timeout after ${job.timeoutMs / 1000}s ` +
              `(single item${itemPath(job.items[0]) ? `: ${itemPath(job.items[0])}` : ''}, ` +
              `${job.estimatedBytes} bytes, last progress: ${lastProgress}). ` +
              `Analyze will retry through sequential fallback. Increase with ` +
              `--worker-timeout or GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS.`,
          ),
        );
        return false;
      };

      const runWorker = (workerIndex: number) => {
        if (stopped) return;
        const job = jobs.shift();
        if (!job) {
          maybeDone();
          return;
        }

        activeWorkers++;
        inFlightProgress[workerIndex] = 0;
        const worker = workers[workerIndex];
        let settled = false;
        let waitingForFlush = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let lastProgress = 0;

        const cleanup = () => {
          if (idleTimer) clearTimeout(idleTimer);
          worker.removeListener('message', handler);
          worker.removeListener('error', errorHandler);
          worker.removeListener('exit', exitHandler);
        };

        const finishJob = () => {
          activeWorkers--;
          inFlightProgress[workerIndex] = 0;
          runWorker(workerIndex);
          maybeDone();
        };

        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(async () => {
            if (!settled) {
              settled = true;
              cleanup();
              activeWorkers--;
              inFlightProgress[workerIndex] = 0;
              const shouldContinue = requeueAfterTimeout(workerIndex, job, lastProgress);
              if (!shouldContinue) return;
              await replaceWorker(workerIndex);
              reportProgress();
              runWorker(workerIndex);
              maybeDone();
            }
          }, job.timeoutMs);
        };

        const handler = (msg: WorkerOutgoingMessage) => {
          if (settled || stopped) return;
          if (msg.type === 'progress') {
            const bounded = Math.min(job.items.length, Math.max(0, msg.filesProcessed));
            inFlightProgress[workerIndex] = bounded;
            lastProgress = bounded;
            resetIdleTimer();
            reportProgress();
          } else if (msg.type === 'warning') {
            resetIdleTimer();
            console.warn(msg.message);
          } else if (msg.type === 'sub-batch-done') {
            waitingForFlush = true;
            resetIdleTimer();
            worker.postMessage({ type: 'flush' });
          } else if (msg.type === 'error') {
            settled = true;
            cleanup();
            void fail(new Error(`Worker ${workerIndex} error: ${msg.error}`));
          } else if (msg.type === 'result') {
            if (!waitingForFlush) {
              settled = true;
              cleanup();
              void fail(new Error(`Worker ${workerIndex} protocol error: result before flush`));
              return;
            }
            settled = true;
            cleanup();
            results.push({ startIndex: job.startIndex, data: msg.data as TResult });
            completedFiles += job.items.length;
            reportProgress();
            finishJob();
          }
        };

        const errorHandler = (err: Error) => {
          if (!settled) {
            settled = true;
            cleanup();
            void fail(err);
          }
        };

        const exitHandler = (code: number) => {
          if (!settled) {
            settled = true;
            cleanup();
            void fail(
              new Error(
                `Worker ${workerIndex} exited with code ${code}. Likely OOM or native addon failure.`,
              ),
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

      for (let i = 0; i < workers.length; i++) runWorker(i);
    });
  };

  const terminate = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.terminate()));
    workers.length = 0;
  };

  return { dispatch, terminate, size };
};
