/**
 * U10 (M6 from PR #1693 review) — Cumulative-timeout exhaustion is
 * actually enforced.
 *
 * `worker-pool-resilience.test.ts` already pins the *default value* of
 * `maxCumulativeTimeoutMs` (5x `subBatchIdleTimeoutMs`). What it does
 * NOT verify is that dispatch ACTUALLY aborts the offending job when
 * the cumulative wall-clock budget is exhausted — without this test,
 * a future refactor could remove the exhaustion branch in
 * `requeueAfterTimeout` and the existing suite would stay green while
 * the pool sat in retry loops for an hour on a real production stall.
 *
 * Scenario: single file, every dispatch idle-times-out. The pool's
 * exponential backoff would normally retry forever; the cumulative
 * ceiling should short-circuit on the first timeout retry attempt
 * (the next backoff would exceed the cap) and surface the file via
 * the quarantine snapshot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import {
  createWorkerPool,
  WorkerPoolDispatchError,
} from '../../src/core/ingestion/workers/worker-pool.js';

/**
 * Minimal `Worker` double for this test only. The full FakeWorker in
 * `worker-pool-resilience.test.ts` is action-scripted; here we want the
 * inverse — a worker that NEVER responds to `sub-batch` messages so the
 * pool's idle timer is the only thing that can move the job forward.
 * That is exactly the production failure mode the cumulative-timeout
 * ceiling exists to bound.
 */
class HangingWorker extends EventEmitter {
  constructor() {
    super();
    // Real Worker fires 'online' asynchronously after the runtime is
    // ready, and parse-worker.ts emits {type:'ready'} after init. Mirror
    // both so the pool's `waitForWorkerReady` resolves on replacement.
    queueMicrotask(() => {
      this.emit('online');
      this.emit('message', { type: 'ready' });
    });
  }

  postMessage(_msg: unknown): void {
    // Intentionally drop the message — the pool's idle timer must
    // catch this. No 'starting-file', no 'progress', no 'result'.
  }

  async terminate(): Promise<number> {
    this.emit('exit', 0);
    return 0;
  }
}

let tempDir: string;
let workerUrl: URL;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-cumulative-timeout-'));
  const workerPath = path.join(tempDir, 'fake-worker.js');
  fs.writeFileSync(workerPath, '// fake');
  workerUrl = pathToFileURL(workerPath) as URL;
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('worker pool cumulative-timeout exhaustion (U10 M6)', () => {
  it('quarantines the file when the cumulative-timeout ceiling is reached on a hanging worker', async () => {
    // subBatchIdleTimeoutMs=100, timeoutBackoffFactor=10, maxCumulativeTimeoutMs=300:
    // attempt-1 timeout = 100ms (cumulative = 100ms after the first fire);
    // next backoff would be 100*10 = 1000ms (cumulative = 1100ms > 300ms cap),
    // so requeueAfterTimeout's exhaustion branch must fire on the first
    // timeout instead of letting the exponential retry loop continue.
    const pool = createWorkerPool(workerUrl, 1, {
      subBatchIdleTimeoutMs: 100,
      timeoutBackoffFactor: 10,
      maxCumulativeTimeoutMs: 300,
      // Keep the breaker out of the way — we want to observe the
      // cumulative-timeout branch, not the consecutive-failure trip.
      consecutiveFailureThreshold: 100,
      maxRespawnsPerSlot: 100,
      workerFactory: () => new HangingWorker() as unknown as import('node:worker_threads').Worker,
    });

    try {
      // The dispatch may resolve (with empty results — the single file
      // ended up in quarantine and was filtered out) OR reject with
      // WorkerPoolDispatchError when no slots can make further progress.
      // Both outcomes are valid expressions of "the ceiling fired"; the
      // load-bearing assertion is the quarantine snapshot.
      let dispatchError: unknown = null;
      try {
        await pool.dispatch<{ path: string; content: string }, unknown>([
          { path: 'src/stuck.ts', content: '// hangs forever' },
        ]);
      } catch (err) {
        dispatchError = err;
      }

      const quarantined = pool.getQuarantinedPaths?.() ?? [];
      // The single hanging file MUST be in the session-scoped quarantine
      // by the time dispatch resolves/rejects — otherwise the ceiling
      // didn't fire and the pool would retry indefinitely.
      expect(quarantined.includes('src/stuck.ts')).toBe(true);

      // If dispatch rejected, the error must be a WorkerPoolDispatchError
      // (the typed surface the caller uses to route to sequential
      // fallback). A different error class here would indicate the
      // ceiling fired via the wrong code path.
      if (dispatchError !== null) {
        expect(dispatchError).toBeInstanceOf(WorkerPoolDispatchError);
      }
    } finally {
      await pool.terminate();
    }
  });
});
