/**
 * U12 — Per-slot generation counter.
 *
 * worker-pool.ts now tracks a monotonic generation counter per slot,
 * incremented on every successful worker replacement. The dispatch
 * loop's handlers capture the slot's generation at attach time and
 * short-circuit when they fire on a stale generation — defensive
 * insurance against any future refactor that loosens cleanup()
 * ordering or re-attaches handlers across the swap.
 *
 * In the current implementation, cleanup() synchronously removes
 * listeners on a Worker instance the moment a death is observed, so
 * no listener can naturally fire on a stale generation. The test
 * surface is therefore the observable counter via `getStats()`:
 *
 *   - Fresh pool: every slot starts at generation 0
 *   - After a death + successful respawn: that slot's generation is 1
 *   - After a death where the respawn budget is exhausted: that slot's
 *     generation stays at its last successful-respawn value (the
 *     drop-slot path does NOT bump generation, because no new worker
 *     came online for the slot)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
const __sharedDecoder = new TextDecoder('utf-8');
function decodeDispatchedMessage(rawMsg: unknown): unknown {
  if (
    rawMsg !== null &&
    typeof rawMsg === 'object' &&
    (rawMsg as { type?: unknown }).type === 'sub-batch' &&
    Array.isArray((rawMsg as { files?: unknown }).files)
  ) {
    const files = (rawMsg as { files: Array<{ path: string; content: Uint8Array | string }> })
      .files;
    return {
      type: 'sub-batch',
      files: files.map((f) => ({
        path: f.path,
        content: typeof f.content === 'string' ? f.content : __sharedDecoder.decode(f.content),
      })),
    };
  }
  return rawMsg;
}

type FakeAction =
  | { kind: 'crash-after-starting'; startingPath: string; code: number }
  | { kind: 'parse-ok'; files: { path: string }[] };

let nextActions: FakeAction[] = [];

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => {
      this.emit('online');
      this.emit('message', { type: 'ready' });
    });
  }
  postMessage(rawMsg: unknown): void {
    // U17: decode Buffer-encoded dispatches; pool is now strict-encoded.
    const msg = decodeDispatchedMessage(rawMsg);
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: string };
    if (m.type !== 'sub-batch') return;
    const action = nextActions.shift();
    if (!action) return;
    queueMicrotask(() => this.run(action));
  }
  private async run(action: FakeAction): Promise<void> {
    if (action.kind === 'crash-after-starting') {
      this.emit('message', { type: 'starting-file', path: action.startingPath });
      this.emit('exit', action.code);
      return;
    }
    if (action.kind === 'parse-ok') {
      for (const f of action.files) {
        this.emit('message', { type: 'starting-file', path: f.path });
      }
      this.emit('message', { type: 'progress', filesProcessed: action.files.length });
      this.emit('message', { type: 'sub-batch-done' });
      await Promise.resolve();
      this.emit('message', {
        type: 'result',
        data: { fileCount: action.files.length, paths: action.files.map((f) => f.path) },
      });
    }
  }
  async terminate(): Promise<number> {
    this.emit('exit', 0);
    return 0;
  }
}

let tempDir: string;
let workerUrl: URL;

beforeEach(() => {
  nextActions = [];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-slot-generation-'));
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

describe('worker pool slot-generation counter (U12)', () => {
  it('starts every slot at generation 0 on a fresh pool', () => {
    const pool = createWorkerPool(workerUrl, 4, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
    });
    try {
      const stats = pool.getStats?.();
      expect(stats?.slotGenerations).toEqual([0, 0, 0, 0]);
    } finally {
      void pool.terminate();
    }
  });

  it('increments the slot generation exactly once on a successful respawn', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      // Generous budgets so the replacement actually comes online (the
      // happy path for the counter increment).
      maxRespawnsPerSlot: 5,
      consecutiveFailureThreshold: 10,
    });

    // Script: first dispatch crashes the worker; pool's replaceWorker
    // creates a new FakeWorker (generation should bump to 1); the new
    // worker handles the requeued remainder via parse-ok.
    nextActions.push({ kind: 'crash-after-starting', startingPath: 'src/bad.ts', code: 134 });
    nextActions.push({ kind: 'parse-ok', files: [{ path: 'src/ok.ts' }] });

    try {
      await pool.dispatch<{ path: string; content: string }, unknown>([
        { path: 'src/bad.ts', content: '' },
        { path: 'src/ok.ts', content: '' },
      ]);
      const stats = pool.getStats?.();
      expect(stats?.slotGenerations).toEqual([1]);
    } finally {
      await pool.terminate();
    }
  });

  it('leaves the slot generation unchanged when the respawn budget is exhausted (slot dropped, not replaced)', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      // maxRespawnsPerSlot:0 means the first crash drops the slot without
      // creating a replacement worker. No worker comes online for slot 0,
      // so the generation MUST NOT bump (it's incremented in replaceWorker
      // only AFTER a successful waitForWorkerReady).
      maxRespawnsPerSlot: 0,
      consecutiveFailureThreshold: 10,
    });

    nextActions.push({ kind: 'crash-after-starting', startingPath: 'src/bad.ts', code: 134 });

    try {
      // Dispatch rejects when all 1 slot is dropped — that's the
      // breaker-tripped exhaustion path. The rejection is the EXPECTED
      // outcome for this scenario; the load-bearing assertion is the
      // post-rejection stats snapshot showing the generation did NOT
      // bump (no successful respawn happened on the dropped slot).
      await expect(
        pool.dispatch<{ path: string; content: string }, unknown>([
          { path: 'src/bad.ts', content: '' },
        ]),
      ).rejects.toBeDefined();
      const stats = pool.getStats?.();
      // Slot 0 was dropped before any successful respawn; generation
      // stays at 0. droppedSlots == size confirms the slot is gone.
      expect(stats?.slotGenerations).toEqual([0]);
      expect(stats?.droppedSlots).toBe(1);
    } finally {
      await pool.terminate();
    }
  });

  it('increments each slot independently — one slot crashing does not affect another slot generation', async () => {
    const pool = createWorkerPool(workerUrl, 2, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      maxRespawnsPerSlot: 5,
      consecutiveFailureThreshold: 10,
    });

    // Two files dispatched. The pool round-robins them across slots —
    // exact assignment is implementation-detail, but on a 2-slot pool
    // with 2 items the first item goes to one slot and the second to
    // the other. We script BOTH possible orderings via a crash on the
    // first action and parse-ok on the second; whichever slot got the
    // bad file gets respawned (generation 1), the other stays at 0.
    nextActions.push({ kind: 'crash-after-starting', startingPath: 'src/bad.ts', code: 134 });
    nextActions.push({ kind: 'parse-ok', files: [{ path: 'src/ok.ts' }] });
    nextActions.push({ kind: 'parse-ok', files: [{ path: 'src/bad.ts' }] });

    try {
      await pool.dispatch<{ path: string; content: string }, unknown>([
        { path: 'src/bad.ts', content: '' },
        { path: 'src/ok.ts', content: '' },
      ]);
      const stats = pool.getStats?.();
      const gens = stats?.slotGenerations ?? [];
      // Exactly one slot bumped to 1; the other stayed at 0. Sort to
      // make the assertion order-independent across the round-robin
      // assignment.
      expect([...gens].sort()).toEqual([0, 1]);
    } finally {
      await pool.terminate();
    }
  });
});
