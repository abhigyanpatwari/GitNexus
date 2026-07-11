import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';

type FirstWorkerBehavior = 'stall' | 'delayed-safe-return';

class TimeoutThenHealthyWorker extends EventEmitter {
  static instances: TimeoutThenHealthyWorker[] = [];
  static firstWorkerBehavior: FirstWorkerBehavior = 'stall';
  static safeReturnDelayMs = 40;

  readonly id: number;
  terminateCalls = 0;
  unrefCalls = 0;
  private currentPaths: string[] = [];

  constructor() {
    super();
    this.id = TimeoutThenHealthyWorker.instances.length;
    TimeoutThenHealthyWorker.instances.push(this);
    queueMicrotask(() => this.emit('message', { type: 'ready' }));
  }

  postMessage(msg: unknown): void {
    if (msg === null || typeof msg !== 'object') return;
    const type = (msg as { type?: unknown }).type;
    if (type === 'sub-batch') {
      const files = (msg as { files?: Array<{ path: string }> }).files ?? [];
      this.currentPaths = files.map((file) => file.path);
      if (this.id === 0) {
        if (TimeoutThenHealthyWorker.firstWorkerBehavior === 'delayed-safe-return') {
          setTimeout(() => {
            this.emit('message', { type: 'sub-batch-done' });
          }, TimeoutThenHealthyWorker.safeReturnDelayMs);
        }
        return;
      }
      queueMicrotask(() => {
        this.emit('message', { type: 'progress', filesProcessed: this.currentPaths.length });
        this.emit('message', { type: 'sub-batch-done' });
      });
      return;
    }
    if (type === 'flush') {
      const paths = this.currentPaths.slice();
      queueMicrotask(() => this.emit('message', { type: 'result', data: { paths } }));
    }
  }

  async terminate(): Promise<number> {
    this.terminateCalls++;
    this.emit('exit', 0);
    return 0;
  }

  unref(): void {
    this.unrefCalls++;
  }
}

const waitFor = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 250,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
};

let tempDir: string;
let workerUrl: URL;

beforeEach(() => {
  TimeoutThenHealthyWorker.instances = [];
  TimeoutThenHealthyWorker.firstWorkerBehavior = 'stall';
  TimeoutThenHealthyWorker.safeReturnDelayMs = 40;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-timeout-retire-'));
  const workerPath = path.join(tempDir, 'fake-worker.js');
  fs.writeFileSync(workerPath, '// fake worker path for createWorkerPool');
  workerUrl = pathToFileURL(workerPath) as URL;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('worker pool timeout retirement', () => {
  it('does not immediately terminate a worker that timed out inside native parsing', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      subBatchIdleTimeoutMs: 20,
      maxTimeoutRetries: 1,
      timeoutBackoffFactor: 2,
      shutdownDrainMs: 25,
      workerFactory: () =>
        new TimeoutThenHealthyWorker() as unknown as import('node:worker_threads').Worker,
    });

    try {
      const results = await pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
        { path: 'src/native-stall.ts', content: 'const x = 1;' },
      ]);

      expect(results).toEqual([{ paths: ['src/native-stall.ts'] }]);
      expect(TimeoutThenHealthyWorker.instances.length).toBeGreaterThanOrEqual(2);
      expect(TimeoutThenHealthyWorker.instances[0].unrefCalls).toBe(1);
      expect(TimeoutThenHealthyWorker.instances[0].terminateCalls).toBe(0);

      // #2432: the retired worker never reached a JS-visible safe point, so
      // shutdown must NOT terminate it (terminating a thread mid-N-API call
      // aborts the whole process). The bounded drain expires and terminate()
      // resolves with the worker left running.
      await pool.terminate();
      expect(TimeoutThenHealthyWorker.instances[0].terminateCalls).toBe(0);

      // Once the worker reaches a safe point, the armed listener terminates it.
      TimeoutThenHealthyWorker.instances[0].emit('message', { type: 'sub-batch-done' });
      await waitFor(
        () => TimeoutThenHealthyWorker.instances[0]?.terminateCalls === 1,
        'Timed out waiting for post-shutdown safe-point terminate',
      );
    } finally {
      await pool.terminate();
    }
  });

  it('terminates a retired worker once it returns to a JS-visible safe point', async () => {
    TimeoutThenHealthyWorker.firstWorkerBehavior = 'delayed-safe-return';
    TimeoutThenHealthyWorker.safeReturnDelayMs = 35;
    const pool = createWorkerPool(workerUrl, 1, {
      subBatchIdleTimeoutMs: 10,
      maxTimeoutRetries: 1,
      timeoutBackoffFactor: 2,
      workerFactory: () =>
        new TimeoutThenHealthyWorker() as unknown as import('node:worker_threads').Worker,
    });

    try {
      const results = await pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
        { path: 'src/native-stall.ts', content: 'const x = 1;' },
      ]);

      expect(results).toEqual([{ paths: ['src/native-stall.ts'] }]);
      expect(TimeoutThenHealthyWorker.instances[0].unrefCalls).toBe(1);
      await waitFor(
        () => TimeoutThenHealthyWorker.instances[0]?.terminateCalls === 1,
        'Timed out waiting for retired worker to terminate after safe signal',
      );

      await pool.terminate();

      expect(TimeoutThenHealthyWorker.instances[0].terminateCalls).toBe(1);
    } finally {
      await pool.terminate();
    }
  });

  it('leaves an unsafe retired worker running on breaker trip, terminating it at its safe point', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      subBatchIdleTimeoutMs: 10,
      maxTimeoutRetries: 1,
      timeoutBackoffFactor: 2,
      consecutiveFailureThreshold: 1,
      shutdownDrainMs: 25,
      workerFactory: () =>
        new TimeoutThenHealthyWorker() as unknown as import('node:worker_threads').Worker,
    });

    try {
      await expect(
        pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
          { path: 'src/native-stall.ts', content: 'const x = 1;' },
        ]),
      ).rejects.toThrow(/circuit breaker/i);

      // #2432: the stalled worker never signalled a safe point — the breaker's
      // background drain must expire WITHOUT terminating it.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(TimeoutThenHealthyWorker.instances[0].terminateCalls).toBe(0);
      expect(TimeoutThenHealthyWorker.instances[0].unrefCalls).toBeGreaterThanOrEqual(1);

      TimeoutThenHealthyWorker.instances[0].emit('message', { type: 'sub-batch-done' });
      await waitFor(
        () => TimeoutThenHealthyWorker.instances[0]?.terminateCalls === 1,
        'Timed out waiting for safe-point terminate after breaker trip',
      );
    } finally {
      await pool.terminate();
    }
  });

  it('retires (not terminates) a busy live worker when the breaker trips from another slot', async () => {
    // Slot 0 stalls mid-job (native-busy); slot 1 dies, tripping the breaker
    // (threshold 1). The breaker must route the BUSY live worker through the
    // retire path — direct terminate would abort the process mid-N-API call.
    class BusyAndDyingWorker extends TimeoutThenHealthyWorker {
      override postMessage(msg: unknown): void {
        if (msg !== null && typeof msg === 'object') {
          const type = (msg as { type?: unknown }).type;
          if (type === 'sub-batch') {
            if (this.id === 0) return; // busy forever, never messages back
            queueMicrotask(() => this.emit('error', new Error('worker crashed')));
            return;
          }
        }
        super.postMessage(msg);
      }
    }

    const pool = createWorkerPool(workerUrl, 2, {
      subBatchSize: 1,
      subBatchIdleTimeoutMs: 5_000,
      consecutiveFailureThreshold: 1,
      shutdownDrainMs: 25,
      workerFactory: () =>
        new BusyAndDyingWorker() as unknown as import('node:worker_threads').Worker,
    });

    try {
      await expect(
        pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
          { path: 'src/busy.ts', content: 'const a = 1;' },
          { path: 'src/dies.ts', content: 'const b = 2;' },
        ]),
      ).rejects.toThrow(/circuit breaker/i);

      const busy = TimeoutThenHealthyWorker.instances[0];
      // Retired, not terminated: unref'd with the safe-point listener armed.
      await waitFor(() => busy.unrefCalls >= 1, 'Timed out waiting for busy worker to be retired');
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(busy.terminateCalls).toBe(0);

      busy.emit('message', { type: 'sub-batch-done' });
      await waitFor(
        () => busy.terminateCalls === 1,
        'Timed out waiting for retired busy worker to terminate at its safe point',
      );
    } finally {
      await pool.terminate();
    }
  });

  it('terminate() drains a retired worker that reaches its safe point mid-drain', async () => {
    TimeoutThenHealthyWorker.firstWorkerBehavior = 'delayed-safe-return';
    TimeoutThenHealthyWorker.safeReturnDelayMs = 5_000; // safe point arrives only via manual emit
    const pool = createWorkerPool(workerUrl, 1, {
      subBatchIdleTimeoutMs: 10,
      maxTimeoutRetries: 1,
      timeoutBackoffFactor: 2,
      shutdownDrainMs: 2_000,
      workerFactory: () =>
        new TimeoutThenHealthyWorker() as unknown as import('node:worker_threads').Worker,
    });

    try {
      const results = await pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
        { path: 'src/native-stall.ts', content: 'const x = 1;' },
      ]);
      expect(results).toEqual([{ paths: ['src/native-stall.ts'] }]);
      expect(TimeoutThenHealthyWorker.instances[0].terminateCalls).toBe(0);

      // Signal the safe point shortly after shutdown starts: the drain must
      // pick it up and terminate promptly instead of waiting out the cap.
      const terminatePromise = pool.terminate();
      setTimeout(() => {
        TimeoutThenHealthyWorker.instances[0].emit('message', { type: 'sub-batch-done' });
      }, 20);
      const start = Date.now();
      await terminatePromise;
      expect(Date.now() - start).toBeLessThan(1_500);
      expect(TimeoutThenHealthyWorker.instances[0].terminateCalls).toBe(1);
    } finally {
      await pool.terminate();
    }
  });
});
