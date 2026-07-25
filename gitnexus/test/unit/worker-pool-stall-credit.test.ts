import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import { _captureLogger } from '../../src/core/logger.js';

// First worker never answers its sub-batch (looks idle); every later worker
// completes normally so the dispatch still resolves after the retire path.
class StallThenHealthyWorker extends EventEmitter {
  static instances: StallThenHealthyWorker[] = [];

  readonly id: number;
  private currentPaths: string[] = [];

  constructor() {
    super();
    this.id = StallThenHealthyWorker.instances.length;
    StallThenHealthyWorker.instances.push(this);
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
    this.emit('exit', 0);
    return 0;
  }

  unref(): void {}
}

let tempDir: string;
let workerUrl: URL;

beforeEach(() => {
  StallThenHealthyWorker.instances = [];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-stall-credit-'));
  const workerPath = path.join(tempDir, 'fake-worker.js');
  fs.writeFileSync(workerPath, '// fake worker path for createWorkerPool');
  workerUrl = pathToFileURL(workerPath) as URL;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const dispatchWithProbe = async (stallMsProbe: () => number) => {
  const cap = _captureLogger();
  const pool = createWorkerPool(workerUrl, 1, {
    subBatchIdleTimeoutMs: 30,
    maxTimeoutRetries: 1,
    timeoutBackoffFactor: 2,
    shutdownDrainMs: 25,
    stallMsProbe,
    workerFactory: () =>
      new StallThenHealthyWorker() as unknown as import('node:worker_threads').Worker,
  });
  try {
    const results = await pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
      { path: 'src/starved.ts', content: 'const x = 1;' },
    ]);
    return { results, records: cap.records() };
  } finally {
    cap.restore();
    await pool.terminate();
  }
};

describe('worker pool GC-stall credit (#2649)', () => {
  it('credits a main-thread stall >= half the budget with one re-arm before retiring', async () => {
    // Monotonic fake stall clock: every read advances 20ms, so each armed
    // 30ms window observes ~tens of ms of "stall" — always above the 15ms
    // credit threshold. Only ONE credit may be spent regardless.
    let stall = 0;
    const { results, records } = await dispatchWithProbe(() => {
      stall += 20;
      return stall;
    });

    expect(results).toEqual([{ paths: ['src/starved.ts'] }]);
    const creditWarns = records.filter((r) =>
      r.msg.includes('overlapped a main-thread stall (GC pressure); re-arming once'),
    );
    const timeoutWarns = records.filter((r) => r.msg.includes('parse job idle timeout'));
    expect({ credits: creditWarns.length, timeoutsAtLeast: timeoutWarns.length >= 1 }).toEqual({
      credits: 1,
      timeoutsAtLeast: true,
    });
  });

  it('does not credit when the main thread was responsive (probe reads zero stall)', async () => {
    const { results, records } = await dispatchWithProbe(() => 0);

    expect(results).toEqual([{ paths: ['src/starved.ts'] }]);
    const creditWarns = records.filter((r) =>
      r.msg.includes('overlapped a main-thread stall (GC pressure); re-arming once'),
    );
    expect(creditWarns).toEqual([]);
  });
});

describe('startHeartbeatStallTracker (#2649 review — the production probe itself)', () => {
  it('accumulates observed stalls, ignores on-time ticks, and freezes after stop()', async () => {
    const { startHeartbeatStallTracker } =
      await import('../../src/core/ingestion/workers/worker-pool.js');
    vi.useFakeTimers();
    try {
      const tracker = startHeartbeatStallTracker();
      // Two on-time ticks: zero drift, nothing accumulates.
      vi.advanceTimersByTime(500);
      const afterOnTime = tracker.read();
      // Simulate a ~2s main-thread stall: jump the wall clock, then let the
      // delayed tick observe the drift.
      vi.setSystemTime(Date.now() + 2000);
      vi.advanceTimersByTime(250);
      const afterStall = tracker.read();
      tracker.stop();
      vi.setSystemTime(Date.now() + 2000);
      vi.advanceTimersByTime(500);
      expect({
        afterOnTime,
        stallSeen: afterStall >= 1500,
        frozenAfterStop: tracker.read() === afterStall,
      }).toEqual({ afterOnTime: 0, stallSeen: true, frozenAfterStop: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
