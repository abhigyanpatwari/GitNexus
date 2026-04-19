import { Worker } from 'node:worker_threads';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface WorkerPool {
  /**
   * Dispatch items across workers. Items are split into chunks (one per worker),
   * each worker processes its chunk via sub-batches to limit peak memory,
   * and results are concatenated back in order.
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

/** Message shapes sent back by worker threads. */
type WorkerOutgoingMessage =
  | { type: 'progress'; filesProcessed: number }
  | { type: 'warning'; message: string }
  | { type: 'sub-batch-done' }
  | { type: 'error'; error: string }
  | { type: 'result'; data: unknown };

/**
 * Max files to send to a worker in a single postMessage.
 * Keeps structured-clone memory bounded per sub-batch.
 */
const SUB_BATCH_SIZE = 1500;

/** Per sub-batch timeout. If a single sub-batch takes longer than this,
 *  likely a pathological file (e.g. minified 50MB JS). Fail fast. */
const SUB_BATCH_TIMEOUT_MS = 30_000;

/**
 * Create a pool of worker threads.
 */
export const createWorkerPool = (workerUrl: URL, poolSize?: number): WorkerPool => {
  // Validate worker script exists before spawning to prevent uncaught
  // MODULE_NOT_FOUND crashes in worker threads (e.g. when running from src/ via vitest)
  const workerPath = fileURLToPath(workerUrl);
  if (!fs.existsSync(workerPath)) {
    throw new Error(`Worker script not found: ${workerPath}`);
  }

  const size = poolSize ?? Math.min(8, Math.max(1, os.cpus().length - 1));
  const workers: Worker[] = [];

  for (let i = 0; i < size; i++) {
    workers.push(new Worker(workerUrl));
  }

  const dispatch = <TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]> => {
    if (items.length === 0) return Promise.resolve([]);

    const chunkSize = Math.ceil(items.length / size);
    const chunks: TInput[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    const workerProgress = new Array(chunks.length).fill(0);

    const promises = chunks.map((chunk, i) => {
      const worker = workers[i];
      return new Promise<TResult>((resolve, reject) => {
        let settled = false;
        let subBatchTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (subBatchTimer) clearTimeout(subBatchTimer);
          worker.removeListener('message', handler);
          worker.removeListener('error', errorHandler);
          worker.removeListener('exit', exitHandler);
        };

        const resetSubBatchTimer = () => {
          if (subBatchTimer) clearTimeout(subBatchTimer);
          subBatchTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(
                new Error(
                  `Worker ${i} sub-batch timed out after ${SUB_BATCH_TIMEOUT_MS / 1000}s (chunk: ${chunk.length} items).`,
                ),
              );
            }
          }, SUB_BATCH_TIMEOUT_MS);
        };

        let subBatchIdx = 0;

        const sendNextSubBatch = () => {
          const start = subBatchIdx * SUB_BATCH_SIZE;
          if (start >= chunk.length) {
            worker.postMessage({ type: 'flush' });
            return;
          }
          const subBatch = chunk.slice(start, start + SUB_BATCH_SIZE);
          subBatchIdx++;
          resetSubBatchTimer();
          worker.postMessage({ type: 'sub-batch', files: subBatch });
        };

        const handler = (msg: WorkerOutgoingMessage) => {
          if (settled) return;
          if (msg.type === 'progress') {
            workerProgress[i] = msg.filesProcessed;
            if (onProgress) {
              const total = workerProgress.reduce((a, b) => a + b, 0);
              onProgress(total);
            }
          } else if (msg.type === 'warning') {
            console.warn(msg.message);
          } else if (msg.type === 'sub-batch-done') {
            sendNextSubBatch();
          } else if (msg.type === 'error') {
            settled = true;
            cleanup();
            reject(new Error(`Worker ${i} error: ${msg.error}`));
          } else if (msg.type === 'result') {
            settled = true;
            cleanup();
            resolve(msg.data as TResult);
          }
        };

        const errorHandler = (err: Error) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        };

        const exitHandler = (code: number) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `Worker ${i} exited with code ${code}. Likely OOM or native addon failure.`,
              ),
            );
          }
        };

        worker.on('message', handler);
        worker.once('error', errorHandler);
        worker.once('exit', exitHandler);
        sendNextSubBatch();
      });
    });

    return Promise.all(promises);
  };

  const terminate = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.terminate()));
    workers.length = 0;
  };

  return { dispatch, terminate, size };
};
