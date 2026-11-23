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
  it('retains a live worker when its shutdown termination request rejects', async () => {
    let live!: TimeoutThenHealthyWorker;
    const pool = createWorkerPool(workerUrl, 1, {
      requireDrain: true,
      workerFactory: () => {
        live = new TimeoutThenHealthyWorker();
        live.terminate = async () => {
          live.terminateCalls++;
          throw new Error('termination rejected');
        };
        return live as unknown as import('node:worker_threads').Worker;
      },
    });
    try {
      await expect(pool.terminate()).rejects.toThrow('native resource reservation');
      await expect(pool.terminate()).rejects.toThrow('native resource reservation');
      expect(live.terminateCalls).toBe(1);
      live.emit('exit', 0);
      await expect(pool.terminate()).resolves.toBeUndefined();
    } finally {
      live.emit('exit', 0);
      await pool.terminate();
    }
  });
  it('retains a rejected termination reservation until physical exit, then releases it', async () => {
    let broken: TimeoutThenHealthyWorker | undefined;
    const pool = createWorkerPool(workerUrl, 1, {
      requireDrain: true,
      shutdownDrainMs: 20,
      workerFactory: () => {
        const worker = new TimeoutThenHealthyWorker();
        if (worker.id === 0) {
          broken = worker;
          worker.postMessage = (message: unknown) => {
            if ((message as { type?: string })?.type === 'sub-batch')
              queueMicrotask(() => worker.emit('error', new Error('worker failed')));
          };
          worker.terminate = async () => {
            worker.terminateCalls++;
            throw new Error('termination rejected');
          };
        }
        return worker as unknown as import('node:worker_threads').Worker;
      },
    });
    try {
      await expect(pool.dispatch([{ path: 'src/error.ts', content: '' }])).rejects.toThrow();
      expect(TimeoutThenHealthyWorker.instances).toHaveLength(1);
      await expect(pool.terminate()).rejects.toThrow('native resource reservation');
      broken!.emit('exit', 1);
      await expect(pool.terminate()).resolves.toBeUndefined();
    } finally {
      broken?.emit('exit', 1);
      await pool.terminate().catch(() => {});
    }
  });

  it('keeps an errored retired worker reserved until its physical exit', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      requireDrain: true,
      subBatchIdleTimeoutMs: 10,
      maxTimeoutRetries: 1,
      shutdownDrainMs: 20,
      workerFactory: () => {
        const worker = new TimeoutThenHealthyWorker();
        worker.terminate = async () => {
          worker.terminateCalls++;
          throw new Error('termination rejected');
        };
        return worker as unknown as import('node:worker_threads').Worker;
      },
    });
    try {
      await expect(pool.dispatch([{ path: 'src/stalled.ts', content: '' }])).rejects.toThrow();
      const retired = TimeoutThenHealthyWorker.instances[0];
      retired.emit('error', new Error('error before exit'));
      await expect(pool.terminate()).rejects.toThrow('native resource reservation');
      expect(TimeoutThenHealthyWorker.instances).toHaveLength(1);
      retired.emit('exit', 1);
      await expect(pool.terminate()).resolves.toBeUndefined();
    } finally {
      TimeoutThenHealthyWorker.instances[0]?.emit('exit', 1);
      await pool.terminate().catch(() => {});
    }
  });

  it('refuses replacement and phase handoff while a budgeted native worker has not drained', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      requireDrain: true,
      heapLimitMb: 512,
      subBatchIdleTimeoutMs: 10,
      maxTimeoutRetries: 1,
      shutdownDrainMs: 20,
      workerFactory: () =>
        new TimeoutThenHealthyWorker() as unknown as import('node:worker_threads').Worker,
    });
    try {
      await expect(
        pool.dispatch([{ path: 'src/stalled.ts', content: 'const x = 1;' }]),
      ).rejects.toThrow();
      expect(TimeoutThenHealthyWorker.instances).toHaveLength(1);
      expect(TimeoutThenHealthyWorker.instances[0].terminateCalls).toBe(0);
      await expect(pool.terminate()).rejects.toThrow('native resource reservation');
      expect(TimeoutThenHealthyWorker.instances[0].terminateCalls).toBe(0);
    } finally {
      TimeoutThenHealthyWorker.instances[0].emit('message', { type: 'sub-batch-done' });
      await waitFor(
        () => TimeoutThenHealthyWorker.instances[0].terminateCalls === 1,
        'Worker did not retire',
      );
      await pool.terminate();
    }
  });

  it('replaces a budgeted worker only after its safe point and native termination complete', async () => {
    TimeoutThenHealthyWorker.firstWorkerBehavior = 'delayed-safe-return';
    TimeoutThenHealthyWorker.safeReturnDelayMs = 40;
    let completeTermination: (() => void) | undefined;
    const pool = createWorkerPool(workerUrl, 1, {
      requireDrain: true,
      subBatchIdleTimeoutMs: 10,
      maxTimeoutRetries: 1,
      shutdownDrainMs: 500,
      workerFactory: () => {
        const worker = new TimeoutThenHealthyWorker();
        if (worker.id === 0)
          worker.terminate = () => {
            worker.terminateCalls++;
            return new Promise<number>((resolve) => {
              completeTermination = () => {
                worker.emit('exit', 0);
                resolve(0);
              };
            });
          };
        return worker as unknown as import('node:worker_threads').Worker;
      },
    });
    try {
      const result = pool.dispatch([{ path: 'src/delayed.ts', content: '' }]);
      await waitFor(() => completeTermination !== undefined, 'Missing safe termination');
      expect(TimeoutThenHealthyWorker.instances).toHaveLength(1);
      completeTermination!();
      await expect(result).resolves.toEqual([{ paths: ['src/delayed.ts'] }]);
      expect(TimeoutThenHealthyWorker.instances).toHaveLength(2);
    } finally {
      completeTermination?.();
      await pool.terminate();
    }
  });

  it('replaces a released slot while another slot still awaits physical exit', async () => {
    const release: Array<() => void> = [];
    const dispatched = new Set<number>();
    const pool = createWorkerPool(workerUrl, 2, {
      requireDrain: true,
      shutdownDrainMs: 500,
      subBatchIdleTimeoutMs: 2000,
      workerFactory: () => {
        const worker = new TimeoutThenHealthyWorker();
        if (worker.id < 2) {
          worker.postMessage = (message: unknown) => {
            if ((message as { type?: string })?.type === 'sub-batch') dispatched.add(worker.id);
          };
          worker.terminate = () =>
            new Promise<number>((resolve) => {
              release[worker.id] = () => {
                worker.emit('exit', 1);
                resolve(1);
              };
            });
        }
        return worker as unknown as import('node:worker_threads').Worker;
      },
    });
    const result = pool.dispatch([
      { path: 'a.ts', content: '' },
      { path: 'b.ts', content: '' },
    ]);
    try {
      await waitFor(() => dispatched.size === 2, 'Both slots did not dispatch');
      TimeoutThenHealthyWorker.instances[0].emit('error', new Error('slot zero failed'));
      TimeoutThenHealthyWorker.instances[1].emit('error', new Error('slot one failed'));
      await waitFor(() => release.filter(Boolean).length === 2, 'Missing termination requests');
      release[0]();
      await waitFor(
        () => TimeoutThenHealthyWorker.instances.length === 3,
        'Released slot was blocked by the other slot',
      );
      release[1]();
      await result; // Failed inputs are quarantined; both replacement slots remain usable.
      expect(TimeoutThenHealthyWorker.instances).toHaveLength(4);
      const results = await pool.dispatch([
        { path: 'healthy-a.ts', content: '' },
        { path: 'healthy-b.ts', content: '' },
      ]);
      expect(results).toEqual(
        expect.arrayContaining([{ paths: ['healthy-a.ts'] }, { paths: ['healthy-b.ts'] }]),
      );
    } finally {
      for (const finish of release) finish?.();
      await result.catch(() => undefined);
      await pool.terminate();
    }
  });

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
