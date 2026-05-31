import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import {
  createWorkerPool,
  WorkerPoolDispatchError,
  resolveWorkerPoolOptions,
  resolveAutoPoolSize,
  workerPoolDisabledByEnv,
  crashSignature,
} from '../../src/core/ingestion/workers/worker-pool.js';
/**
 * The pool now sends sub-batch dispatches via native `worker.postMessage`
 * with the shape `{type:'sub-batch', files:[{path, content: Uint8Array}]}`.
 * Test action logic inspects only `msg.files[*].path`, but the Uint8Array
 * content is decoded back to a string here so any future test that
 * reads it sees the legacy POJO shape.
 */
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

/**
 * Minimal `node:worker_threads` Worker double for unit-testing the pool's
 * resilience layers (auto-respawn, circuit breaker, quarantine, retry
 * budget). Tests script behaviour via `nextActions`: each action runs on
 * the next dispatched sub-batch postMessage. `'crash'` and `'exit'` mimic
 * real worker failures; `'parse-ok'` mimics a healthy completion.
 */
type FakeWorkerAction =
  | { kind: 'parse-ok'; files: { path: string }[]; result?: unknown }
  | { kind: 'crash-exit'; code: number; afterStartingFiles?: number }
  | { kind: 'crash-error'; message: string; afterStartingFiles?: number };

const nextActions: FakeWorkerAction[] = [];
let workerInstances: FakeWorker[] = [];

class FakeWorker extends EventEmitter {
  readonly seenMessages: unknown[] = [];

  constructor() {
    super();
    workerInstances.push(this);
    // Real Worker fires 'online' asynchronously after the runtime is ready;
    // replicate so any code still listening on `online` is satisfied. The
    // pool's `waitForWorkerReady` (post-M4) waits for a `{type:'ready'}`
    // message instead — emit that too so replacement-worker tests don't
    // hit the WORKER_READY_TIMEOUT_MS budget (5s).
    queueMicrotask(() => {
      this.emit('online');
      this.emit('message', { type: 'ready' });
    });
  }

  postMessage(rawMsg: unknown): void {
    // U17: production pool now sends Buffer-encoded dispatch frames.
    // Decode them here so this in-process mock can keep its existing
    // POJO-shaped action-scripting API — the action queue still sees
    // `{type, files}` shapes regardless of whether the pool encoded
    // the message on the way in. Store the DECODED payload in
    // `seenMessages` so test-side introspection assertions (which
    // expect `msg.type` / `msg.files`) keep working after the wire
    // format flipped to Buffer.
    const msg = decodeDispatchedMessage(rawMsg);
    this.seenMessages.push(msg);
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: string; files?: { path: string }[] };
    if (m.type !== 'sub-batch') return;
    const action = nextActions.shift();
    if (!action) {
      // No script set; behave as a hung worker (no reply) — the idle timer
      // will eventually fire. Tests should always script enough actions.
      return;
    }
    queueMicrotask(() => this.runAction(action, m.files ?? []));
  }

  private async runAction(action: FakeWorkerAction, files: { path: string }[]): Promise<void> {
    if (action.kind === 'parse-ok') {
      for (const file of action.files) {
        this.emit('message', { type: 'starting-file', path: file.path });
      }
      this.emit('message', { type: 'progress', filesProcessed: action.files.length });
      this.emit('message', { type: 'sub-batch-done' });
      // sub-batch-done triggers the pool to post {type:'flush'} which we
      // ignore in postMessage above (only 'sub-batch' triggers actions).
      // For the result, wait one microtask so the flush is observed.
      await Promise.resolve();
      this.emit('message', {
        type: 'result',
        data: action.result ?? { fileCount: action.files.length },
      });
      return;
    }
    if (action.kind === 'crash-exit') {
      const upTo = Math.min(action.afterStartingFiles ?? 0, files.length);
      for (let i = 0; i < upTo; i++) {
        this.emit('message', { type: 'starting-file', path: files[i].path });
      }
      this.emit('exit', action.code);
      return;
    }
    if (action.kind === 'crash-error') {
      const upTo = Math.min(action.afterStartingFiles ?? 0, files.length);
      for (let i = 0; i < upTo; i++) {
        this.emit('message', { type: 'starting-file', path: files[i].path });
      }
      this.emit('error', new Error(action.message));
      return;
    }
  }

  async terminate(): Promise<number> {
    this.emit('exit', 0);
    return 0;
  }

  removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.removeListener(event, listener);
  }
}

// Create a real on-disk worker script so createWorkerPool's existsSync gate
// passes. The script is never actually executed because we inject
// FakeWorker via workerFactory; it just has to exist as a file path.
let tempDir: string;
let workerUrl: URL;

beforeEach(() => {
  nextActions.length = 0;
  workerInstances = [];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-pool-resilience-'));
  const workerPath = path.join(tempDir, 'fake-worker.js');
  fs.writeFileSync(workerPath, '// fake');
  workerUrl = pathToFileURL(workerPath) as URL;
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup — directory may already be gone if a test removed it
  }
});

describe('worker pool resilience', () => {
  it('seeds an empty quarantine on a fresh pool', () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
    });
    expect(pool.getQuarantinedPaths()).toEqual([]);
    void pool.terminate();
  });

  it('exposes a healthy stats snapshot on a fresh pool', () => {
    const pool = createWorkerPool(workerUrl, 3, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
    });
    expect(pool.getStats?.()).toEqual({
      size: 3,
      activeSlots: 3,
      droppedSlots: 0,
      quarantined: 0,
      poolBroken: false,
      // Code-review F16: `terminated` distinguishes graceful shutdown
      // from a circuit-breaker trip. Fresh pool has not been
      // terminated.
      terminated: false,
      // #1741: no startup backoff is pending once every slot reached ready.
      pendingStartupTimers: 0,
      // U12: every slot starts at generation 0; no respawns yet on a
      // fresh pool. Per-slot zeros (not a single scalar) because each
      // slot tracks its own respawn history independently.
      slotGenerations: [0, 0, 0],
    });
    void pool.terminate();
  });

  it('reports droppedSlots + quarantined after a recoverable death', async () => {
    const pool = createWorkerPool(workerUrl, 2, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 10,
      maxRespawnsPerSlot: 0,
    });
    // Slot 0 dies on its only job; budget=0 means it gets dropped.
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/ok.ts' }],
      result: { fileCount: 1 },
    });
    await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/bad.ts', content: '' },
      { path: 'src/ok.ts', content: '' },
    ]);

    expect(pool.getStats?.()).toEqual({
      size: 2,
      activeSlots: 1,
      droppedSlots: 1,
      quarantined: 1,
      poolBroken: false,
      // F16: pool is still alive (just lost a slot); terminated=false.
      terminated: false,
      // #1741: a runtime death is unrelated to startup backoff timers.
      pendingStartupTimers: 0,
      // U12: slot 0 was dropped before any successful respawn (budget=0),
      // so its generation stays at 0. Slot 1 never died, also 0.
      slotGenerations: [0, 0],
    });
    await pool.terminate();
  });

  it('quarantines the in-flight file on worker exit and respawns the slot', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 3,
    });
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/good.ts' }],
      result: { fileCount: 1 },
    });

    const results = await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/bad.ts', content: '' },
      { path: 'src/good.ts', content: '' },
    ]);

    expect(results).toEqual([{ fileCount: 1 }]);
    expect(pool.getQuarantinedPaths()).toEqual(['src/bad.ts']);
    // First FakeWorker died; second is the respawn. Total = 2.
    expect(workerInstances.length).toBe(2);
    await pool.terminate();
  });

  it('drops a slot after maxRespawnsPerSlot exceeded and continues on other slots', async () => {
    const pool = createWorkerPool(workerUrl, 2, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 10,
      maxRespawnsPerSlot: 1,
    });
    // Slot 0 dies twice, exceeding budget=1; slot 1 succeeds with the
    // requeued remainder.
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/c.ts' }, { path: 'src/d.ts' }],
      result: { fileCount: 2 },
    });

    const results = await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/a.ts', content: '' },
      { path: 'src/b.ts', content: '' },
      { path: 'src/c.ts', content: '' },
      { path: 'src/d.ts', content: '' },
    ]);

    expect(results).toEqual([{ fileCount: 2 }]);
    // Two bad files quarantined; both pre-crash 'starting-file' targets.
    expect(pool.getQuarantinedPaths().sort()).toEqual(['src/a.ts', 'src/b.ts']);
    await pool.terminate();
  });

  it('trips the circuit breaker after consecutiveFailureThreshold deaths', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 2,
      maxRespawnsPerSlot: 5,
    });
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });

    await expect(
      pool.dispatch<{ path: string; content: string }, unknown>([
        { path: 'src/x.ts', content: '' },
        { path: 'src/y.ts', content: '' },
      ]),
    ).rejects.toBeInstanceOf(WorkerPoolDispatchError);

    expect(pool.getQuarantinedPaths().sort()).toEqual(['src/x.ts', 'src/y.ts']);
    // Subsequent dispatch on a tripped pool rejects without running anything.
    await expect(
      pool.dispatch<{ path: string; content: string }, unknown>([
        { path: 'src/z.ts', content: '' },
      ]),
    ).rejects.toBeInstanceOf(WorkerPoolDispatchError);
    await pool.terminate();
  });

  it('resets consecutive-failure counter on a successful job', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 2,
      maxRespawnsPerSlot: 5,
    });
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/recovered.ts' }],
      result: { fileCount: 1 },
    });

    const r1 = await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/bad.ts', content: '' },
      { path: 'src/recovered.ts', content: '' },
    ]);
    expect(r1).toEqual([{ fileCount: 1 }]);

    // Second dispatch: another death. Counter was reset by the prior success,
    // so this single failure should not trip the breaker (threshold=2).
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/ok.ts' }],
      result: { fileCount: 1 },
    });
    const r2 = await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/bad2.ts', content: '' },
      { path: 'src/ok.ts', content: '' },
    ]);
    expect(r2).toEqual([{ fileCount: 1 }]);
    expect(pool.getQuarantinedPaths().sort()).toEqual(['src/bad.ts', 'src/bad2.ts']);
    await pool.terminate();
  });

  it('filters already-quarantined paths from new dispatches', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 3,
    });
    // First dispatch: quarantine 'src/poison.ts'
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/a.ts' }],
      result: { fileCount: 1 },
    });
    await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/poison.ts', content: '' },
      { path: 'src/a.ts', content: '' },
    ]);
    expect(pool.getQuarantinedPaths()).toEqual(['src/poison.ts']);

    // Second dispatch including the quarantined file: pool filters before
    // workers see it. The action should never be popped because the only
    // dispatchable item is src/b.ts.
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/b.ts' }],
      result: { fileCount: 1 },
    });
    const results = await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/poison.ts', content: '' },
      { path: 'src/b.ts', content: '' },
    ]);
    expect(results).toEqual([{ fileCount: 1 }]);
    // The most recent sub-batch the pool dispatched is the dispatch-2
    // payload. With poison already in the quarantine when dispatch 2 ran,
    // the pool must have filtered it out before reaching a worker.
    const allSubBatches = workerInstances
      .flatMap((w) => w.seenMessages)
      .filter(
        (m): m is { type: string; files: { path: string }[] } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'sub-batch',
      );
    const lastSubBatch = allSubBatches[allSubBatches.length - 1];
    expect(lastSubBatch.files.map((f) => f.path)).toEqual(['src/b.ts']);
    await pool.terminate();
  });

  it('returns an empty result without dispatching when every item is quarantined', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 3,
    });
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/a.ts' }],
      result: { fileCount: 1 },
    });
    await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/poison.ts', content: '' },
      { path: 'src/a.ts', content: '' },
    ]);
    const baselineWorkers = workerInstances.length;

    const results = await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/poison.ts', content: '' },
    ]);
    expect(results).toEqual([]);
    expect(workerInstances.length).toBe(baselineWorkers);
    await pool.terminate();
  });

  it('quarantines on worker `error` event (errorHandler path)', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 3,
    });
    nextActions.push({ kind: 'crash-error', message: 'segfault', afterStartingFiles: 1 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/ok.ts' }],
      result: { fileCount: 1 },
    });

    const results = await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/bad.ts', content: '' },
      { path: 'src/ok.ts', content: '' },
    ]);

    expect(results).toEqual([{ fileCount: 1 }]);
    expect(pool.getQuarantinedPaths?.() ?? []).toEqual(['src/bad.ts']);
    await pool.terminate();
  });

  it('drops the job on second unattributable death when items have no paths (F5 drop branch)', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 5,
    });
    // Items without a `path` field — itemPath returns undefined, so
    // inFlightExcludePath returns [] and F5's unattributed-death branch
    // is the only path that fires. First death re-queues intact; second
    // death drops the job entirely to break the loop (no identifiable
    // file to quarantine).
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 0 });
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 0 });

    const results = await pool.dispatch<{ content: string }, unknown>([
      { content: 'no-path-1' },
      { content: 'no-path-2' },
    ]);

    // F5 dropped the job; no results, no quarantine (no path to quarantine).
    expect(results).toEqual([]);
    expect(pool.getQuarantinedPaths?.() ?? []).toEqual([]);
    await pool.terminate();
  });

  it('common-case unattributable crash falls back to the items[0] heuristic for attribution', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 5,
    });
    // Worker dies BEFORE emitting starting-file or progress. The pool's
    // heuristic attributes to items[0] (lastProgress=0, items.length>0,
    // path-bearing item). Validates the heuristic fallback before F5
    // would take over — confirms today's behavior for the most common
    // unattributable-crash mode.
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 0 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/clean.ts' }],
      result: { fileCount: 1 },
    });

    const results = await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/heuristic-target.ts', content: '' },
      { path: 'src/clean.ts', content: '' },
    ]);

    expect(results).toEqual([{ fileCount: 1 }]);
    expect(pool.getQuarantinedPaths?.() ?? []).toEqual(['src/heuristic-target.ts']);
    await pool.terminate();
  });

  it('drops slot when waitForWorkerOnline rejects (replaceWorker failure path)', async () => {
    let factoryCallCount = 0;
    const pool = createWorkerPool(workerUrl, 2, {
      workerFactory: () => {
        factoryCallCount++;
        const worker = new FakeWorker();
        // Slot 0's initial worker is healthy; the replacement (3rd factory
        // call after slot 0 dies once) exits before emitting 'online'.
        if (factoryCallCount === 3) {
          // Override the queued 'online' microtask with an immediate 'exit'.
          queueMicrotask(() => worker.emit('exit', 1));
        }
        return worker as unknown as import('node:worker_threads').Worker;
      },
      consecutiveFailureThreshold: 10,
      maxRespawnsPerSlot: 5,
    });
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({
      kind: 'parse-ok',
      files: [{ path: 'src/b.ts' }, { path: 'src/c.ts' }],
      result: { fileCount: 2 },
    });

    const results = await pool.dispatch<{ path: string; content: string }, unknown>([
      { path: 'src/a.ts', content: '' },
      { path: 'src/b.ts', content: '' },
      { path: 'src/c.ts', content: '' },
    ]);

    expect(results).toEqual([{ fileCount: 2 }]);
    expect(pool.getQuarantinedPaths?.() ?? []).toEqual(['src/a.ts']);
    // Initial 2 workers + 1 failed replacement = 3 factory calls.
    expect(factoryCallCount).toBe(3);
    await pool.terminate();
  });

  it('trips the breaker when all slots exhaust their respawn budget', async () => {
    const pool = createWorkerPool(workerUrl, 2, {
      workerFactory: () => new FakeWorker() as unknown as import('node:worker_threads').Worker,
      consecutiveFailureThreshold: 100,
      maxRespawnsPerSlot: 0,
    });
    // Both slots die on first job: budget=0 means slot is dropped on first death.
    // After both slots dropped, activeSlots.size === 0 trips the breaker.
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });
    nextActions.push({ kind: 'crash-exit', code: 134, afterStartingFiles: 1 });

    await expect(
      pool.dispatch<{ path: string; content: string }, unknown>([
        { path: 'src/x.ts', content: '' },
        { path: 'src/y.ts', content: '' },
      ]),
    ).rejects.toBeInstanceOf(WorkerPoolDispatchError);

    // After breaker, no respawns happen so workerInstances === initial 2.
    expect(workerInstances.length).toBe(2);
    await pool.terminate();
  });
});

describe('worker pool option resolution', () => {
  it('resolves maxRespawnsPerSlot from explicit options', () => {
    const opts = resolveWorkerPoolOptions({ maxRespawnsPerSlot: 7 }, 4);
    expect(opts.maxRespawnsPerSlot).toBe(7);
  });

  it('defaults consecutiveFailureThreshold to max(3, poolSize)', () => {
    expect(resolveWorkerPoolOptions({}, 1).consecutiveFailureThreshold).toBe(3);
    expect(resolveWorkerPoolOptions({}, 8).consecutiveFailureThreshold).toBe(8);
  });

  it('defaults maxCumulativeTimeoutMs to 5x subBatchIdleTimeoutMs', () => {
    const opts = resolveWorkerPoolOptions({ subBatchIdleTimeoutMs: 1000 }, 1);
    expect(opts.maxCumulativeTimeoutMs).toBe(5000);
  });

  it('reads GITNEXUS_WORKER_MAX_RESPAWNS_PER_SLOT env override', () => {
    vi.stubEnv('GITNEXUS_WORKER_MAX_RESPAWNS_PER_SLOT', '2');
    try {
      expect(resolveWorkerPoolOptions({}, 1).maxRespawnsPerSlot).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads GITNEXUS_WORKER_CONSECUTIVE_FAILURE_THRESHOLD env override', () => {
    vi.stubEnv('GITNEXUS_WORKER_CONSECUTIVE_FAILURE_THRESHOLD', '12');
    try {
      expect(resolveWorkerPoolOptions({}, 1).consecutiveFailureThreshold).toBe(12);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS env override', () => {
    vi.stubEnv('GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS', '60000');
    try {
      expect(resolveWorkerPoolOptions({}, 1).maxCumulativeTimeoutMs).toBe(60000);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('resolveAutoPoolSize', () => {
  it('honors GITNEXUS_WORKER_POOL_SIZE env override (positive integer)', () => {
    vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', '12');
    try {
      expect(resolveAutoPoolSize()).toBe(12);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('honors GITNEXUS_WORKER_POOL_SIZE=0 (sequential-fallback signal)', () => {
    vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', '0');
    try {
      expect(resolveAutoPoolSize()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('honors GITNEXUS_WORKER_POOL_SIZE override above the auto cap', () => {
    vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', '32');
    try {
      expect(resolveAutoPoolSize()).toBe(32);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores invalid env values and falls back to the auto formula', () => {
    vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', 'abc');
    try {
      const expected = Math.min(16, Math.max(1, os.cpus().length - 1));
      expect(resolveAutoPoolSize()).toBe(expected);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('matches the auto formula min(16, max(1, cores - 1)) with no env override', () => {
    // Exact-count per DoD §2.7: compute the expected value the same
    // way the resolver does so the assertion stays deterministic on
    // any machine.
    const expected = Math.min(16, Math.max(1, os.cpus().length - 1));
    expect(resolveAutoPoolSize()).toBe(expected);
  });

  it('returns an integer (never a float)', () => {
    expect(Number.isInteger(resolveAutoPoolSize())).toBe(true);
  });
});

describe('workerPoolDisabledByEnv (#1741 — env=0 → sequential signal)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true only for a literal GITNEXUS_WORKER_POOL_SIZE=0', () => {
    vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', '0');
    expect(workerPoolDisabledByEnv()).toBe(true);
  });

  it('is false for a positive env size (the pool is used)', () => {
    vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', '4');
    expect(workerPoolDisabledByEnv()).toBe(false);
  });

  it('treats empty/whitespace as unset (not a disable signal — auto formula applies)', () => {
    vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', '');
    expect(workerPoolDisabledByEnv()).toBe(false);
    vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', '   ');
    expect(workerPoolDisabledByEnv()).toBe(false);
  });

  it('is false for an invalid value', () => {
    vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', 'abc');
    expect(workerPoolDisabledByEnv()).toBe(false);
  });
});

describe('crashSignature (#1741 — deterministic-loop fingerprint normalization)', () => {
  it('collapses Windows backslash temp paths that differ only in a random token', () => {
    const a = crashSignature("Cannot find module 'C:\\Users\\ci\\Temp\\worker-7f3a.js'");
    const b = crashSignature("Cannot find module 'C:\\Users\\ci\\Temp\\worker-2b9c.js'");
    expect(a).toBe(b);
  });

  it('collapses bare (no-0x) hex backtrace tokens', () => {
    expect(crashSignature('SIGSEGV at 00007f8a2b1c4d')).toBe(
      crashSignature('SIGSEGV at 00007fcc3d2e5a'),
    );
  });

  it('collapses POSIX paths and exit codes (stderr-less crashes still group)', () => {
    expect(crashSignature('Worker exited with code 1 (/tmp/pool-9/w.js)')).toBe(
      crashSignature('Worker exited with code 139 (/tmp/pool-4/w.js)'),
    );
  });

  it('keeps genuinely different crashes distinct', () => {
    expect(crashSignature('Error: Cannot find module tree-sitter-c-sharp')).not.toBe(
      crashSignature('Error: out of memory'),
    );
  });
});
