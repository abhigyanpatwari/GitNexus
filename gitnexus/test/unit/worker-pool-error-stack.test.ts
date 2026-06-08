import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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
 * #2068 regression: a worker-side crash must carry its stack across the
 * MessageChannel so the surfaced "Phase 'parse' failed" error points at a real
 * frame instead of a bare one-liner (the issue's `this.#q is not a function`
 * reached the operator with no file:line because the worker only sent
 * `err.message`). These tests assert the worker stack rides through both worker
 * failure channels — the `{type:'error'}` message (a caught worker throw) and
 * the Node `'error'` event (an uncaught worker throw) — into the
 * `WorkerPoolDispatchError` the parse phase rejects with, and that an older
 * worker build that omits the stack still degrades cleanly.
 */

type NodeWorker = import('node:worker_threads').Worker;

type FakeAction =
  | { kind: 'error-message'; error: string; errorStack?: string }
  | { kind: 'error-event'; message: string; stack: string };

const nextActions: FakeAction[] = [];

/**
 * Minimal worker double: emits the readiness handshake on construction, then
 * runs one scripted action per dispatched sub-batch. Unlike the resilience
 * suite's double, this one can emit the `{type:'error', errorStack}` MESSAGE
 * (the worker's own caught-error path) in addition to the Node `'error'` event.
 */
class FakeWorker extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => {
      this.emit('online');
      this.emit('message', { type: 'ready' });
    });
  }

  postMessage(rawMsg: unknown): void {
    const m = rawMsg as { type?: string };
    // Only a real dispatch drives an action; ignore the pool's `flush` reply.
    if (!m || m.type !== 'sub-batch') return;
    const action = nextActions.shift();
    if (!action) return;
    queueMicrotask(() => {
      if (action.kind === 'error-message') {
        this.emit('message', {
          type: 'error',
          error: action.error,
          errorStack: action.errorStack,
        });
      } else {
        const e = new Error(action.message);
        e.stack = action.stack;
        this.emit('error', e);
      }
    });
  }

  async terminate(): Promise<number> {
    this.emit('exit', 0);
    return 0;
  }
}

let tempDir: string;
let workerUrl: URL;

beforeEach(() => {
  nextActions.length = 0;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-error-stack-'));
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

// Trip the breaker on the very first death so the reason string is surfaced
// verbatim in the rejected WorkerPoolDispatchError.
const TRIP_ON_FIRST_DEATH = {
  consecutiveFailureThreshold: 1,
  maxRespawnsPerSlot: 0,
} as const;

async function dispatchAndCatch(pool: ReturnType<typeof createWorkerPool>): Promise<unknown> {
  try {
    await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/a.ts', content: '' },
    ]);
    return undefined;
  } catch (e) {
    return e;
  }
}

describe('worker-pool error stack propagation (#2068)', () => {
  it('embeds the worker stack from a {type:error} message into the surfaced error', async () => {
    const workerStack =
      'TypeError: this.#q is not a function\n' +
      '    at frobnicate (/dist/core/ingestion/workers/parse-worker.js:1234:56)';
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as NodeWorker,
      ...TRIP_ON_FIRST_DEATH,
    });
    nextActions.push({
      kind: 'error-message',
      error: 'this.#q is not a function',
      errorStack: workerStack,
    });

    const caught = await dispatchAndCatch(pool);

    expect(caught).toBeInstanceOf(WorkerPoolDispatchError);
    const msg = (caught as Error).message;
    expect(msg).toContain('this.#q is not a function');
    expect(msg).toContain('worker stack:');
    expect(msg).toContain('frobnicate (/dist/core/ingestion/workers/parse-worker.js:1234:56)');
    await pool.terminate();
  });

  // The Node 'error' event fires on an UNCAUGHT JS throw / async rejection (which
  // carries a real JS stack). A true NATIVE abort (tree-sitter SIGSEGV / OOM kill)
  // instead fires the 'exit' event and is intentionally stackless — no JS frame
  // exists — so it is NOT exercised here.
  it('embeds the worker stack from a Node error event (uncaught throw) into the surfaced error', async () => {
    const workerStack =
      'Error: uncaught worker throw\n' +
      '    at processFileGroup (/dist/core/ingestion/workers/parse-worker.js:777:9)';
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as NodeWorker,
      ...TRIP_ON_FIRST_DEATH,
    });
    nextActions.push({ kind: 'error-event', message: 'uncaught worker throw', stack: workerStack });

    const caught = await dispatchAndCatch(pool);

    expect(caught).toBeInstanceOf(WorkerPoolDispatchError);
    const msg = (caught as Error).message;
    expect(msg).toContain('worker stack:');
    expect(msg).toContain('processFileGroup (/dist/core/ingestion/workers/parse-worker.js:777:9)');
    await pool.terminate();
  });

  it('degrades to message-only when an older worker build omits errorStack', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as NodeWorker,
      ...TRIP_ON_FIRST_DEATH,
    });
    // No errorStack — the wire field is optional for back/forward compat.
    nextActions.push({ kind: 'error-message', error: 'legacy worker failure' });

    const caught = await dispatchAndCatch(pool);

    expect(caught).toBeInstanceOf(WorkerPoolDispatchError);
    const msg = (caught as Error).message;
    expect(msg).toContain('legacy worker failure');
    expect(msg).not.toContain('worker stack:');
    await pool.terminate();
  });
});
