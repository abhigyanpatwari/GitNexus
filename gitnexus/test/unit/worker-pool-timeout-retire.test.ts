import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';

class TimeoutThenHealthyWorker extends EventEmitter {
  static instances: TimeoutThenHealthyWorker[] = [];

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
      if (this.id === 0) return;
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

let tempDir: string;
let workerUrl: URL;

beforeEach(() => {
  TimeoutThenHealthyWorker.instances = [];
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
    } finally {
      await pool.terminate();
    }
  });
});
