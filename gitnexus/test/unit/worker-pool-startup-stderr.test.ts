/**
 * Worker startup failure surfaces the real crash via captured stderr (#1741).
 *
 * Before this, when every worker crashed during top-of-script init the pool
 * rejected dispatch with a generic "did not report ready within 5000ms" and
 * the actual cause (e.g. a broken native binding) was lost to the worker's
 * inherited stderr. The pool now spawns workers with `{ stderr: true }`,
 * tees + captures each worker's stderr, and attaches the tail to its
 * readiness-failure messages — which propagate on
 * `WorkerPoolInitializationError.readinessFailures`.
 *
 * This test injects a fake worker that prints a crash to stderr and exits
 * without ever reporting `ready`, then asserts the captured stderr reaches
 * the dispatch error.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createWorkerPool,
  WorkerPoolInitializationError,
} from '../../src/core/ingestion/workers/worker-pool.js';

const CRASH_STDERR =
  "Error: Cannot find module 'tree-sitter-c-sharp/bindings/node'\n    at parse-worker.ts:10\n";

/**
 * Worker double that crashes during startup: emits a crash to its `stderr`
 * stream, never sends `{type:'ready'}`, then exits non-zero. Mirrors a
 * native-binding load failure in `parse-worker.ts`.
 */
class CrashingWorker extends EventEmitter {
  readonly stderr = new EventEmitter();
  constructor() {
    super();
    queueMicrotask(() => {
      // stderr first so it's captured before the exit builds the message.
      this.stderr.emit('data', Buffer.from(CRASH_STDERR));
      this.emit('exit', 1);
    });
  }
  postMessage(): void {}
  async terminate(): Promise<number> {
    return 1;
  }
}

/** Worker double that starts cleanly: reports `{type:'ready'}` and never dies. */
class ReadyWorker extends EventEmitter {
  readonly stderr = new EventEmitter();
  constructor() {
    super();
    queueMicrotask(() => this.emit('message', { type: 'ready' }));
  }
  postMessage(): void {}
  async terminate(): Promise<number> {
    return 0;
  }
}

let tempDir: string;
let workerUrl: URL;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-startup-stderr-'));
  const workerPath = path.join(tempDir, 'fake-worker.js');
  fs.writeFileSync(workerPath, '// fake');
  workerUrl = pathToFileURL(workerPath) as URL;
  // The tee writes captured worker stderr to process.stderr; silence it so
  // the (intentional) crash text doesn't pollute test output.
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('worker pool — startup stderr surfacing (#1741)', () => {
  it('attaches captured worker stderr to the WorkerPoolInitializationError', async () => {
    const pool = createWorkerPool(workerUrl, 2, {
      workerFactory: () => new CrashingWorker() as unknown as Worker,
    });

    const dispatch = pool.dispatch([{ path: 'src/a.ts', content: 'x' }]);
    await expect(dispatch).rejects.toBeInstanceOf(WorkerPoolInitializationError);

    const err = await dispatch.catch((e: unknown) => e as WorkerPoolInitializationError);
    expect(err.readinessFailures.length).toBeGreaterThan(0);
    // The real crash reason, recovered from the worker's stderr, is present.
    const joined = err.readinessFailures.join('\n');
    expect(joined).toContain('Worker stderr:');
    expect(joined).toContain('tree-sitter-c-sharp');
    // And the captured stderr was teed to process.stderr (visibility preserved).
    expect(stderrSpy).toHaveBeenCalled();

    await pool.terminate().catch(() => undefined);
  });
});

describe('worker pool — startup self-healing (#1741)', () => {
  it('self-heals a transient startup crash: respawns the slot and recovers', async () => {
    let calls = 0;
    const pool = createWorkerPool(workerUrl, 1, {
      // First spawn crashes during init; the bounded retry respawns the slot
      // and the second spawn comes up clean — recovery with no operator action.
      workerFactory: () => {
        calls++;
        return (calls === 1 ? new CrashingWorker() : new ReadyWorker()) as unknown as Worker;
      },
    });

    // Empty dispatch forces the initial-ready gate to settle without needing
    // the full sub-batch protocol.
    await pool.dispatch([]);

    expect(calls).toBeGreaterThanOrEqual(2); // crashed once, respawned
    expect(pool.getStats().activeSlots).toBe(1); // slot recovered and is live
    expect(pool.getStats().poolBroken).toBe(false);
    // R1 (clear-on-settle): the ref'd backoff timer self-cleared when it fired,
    // so no startup timer lingers after the slot's retry loop exited.
    expect(pool.getStats().pendingStartupTimers).toBe(0);

    await pool.terminate().catch(() => undefined);
  });

  it('fails fast on a deterministic crash-loop without burning every slot budget', async () => {
    let calls = 0;
    const pool = createWorkerPool(workerUrl, 3, {
      // Every worker crashes identically — a deterministic fault (the #1741
      // missing-binding case). Retrying cannot help.
      workerFactory: () => {
        calls++;
        return new CrashingWorker() as unknown as Worker;
      },
    });

    const err = await pool
      .dispatch([{ path: 'a.ts', content: 'x' }])
      .catch((e: unknown) => e as WorkerPoolInitializationError);

    expect(err).toBeInstanceOf(WorkerPoolInitializationError);
    expect(err.crashClass).toBe('deterministic-startup');
    // No short-circuit would mean 3 slots × (1 + STARTUP_RESTART_BUDGET=2) = 9
    // spawns; deterministic detection (≥2 identical signatures) gives up well
    // before that, so the fast-fail never approaches the full budget.
    expect(calls).toBeLessThan(9);

    await pool.terminate().catch(() => undefined);
  });

  it('terminate() during startup cancels any pending backoff and spawns nothing after (R2)', async () => {
    let calls = 0;
    const pool = createWorkerPool(workerUrl, 1, {
      // Crashes on every spawn, so the slot is in its bounded retry/backoff loop.
      workerFactory: () => {
        calls++;
        return new CrashingWorker() as unknown as Worker;
      },
    });

    // Let the first crash register and the slot enter its (ref'd) backoff.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsBeforeTerminate = calls;
    expect(callsBeforeTerminate).toBeGreaterThanOrEqual(1);

    // terminate() must cancel the pending backoff (not wait it out) and stop the loop.
    await pool.terminate();
    expect(pool.getStats().terminated).toBe(true);
    // No ref'd backoff timer left pinning the loop after terminate.
    expect(pool.getStats().pendingStartupTimers).toBe(0);
    expect(pool.getStats().activeSlots).toBe(0);

    // No worker is spawned after terminate — the woken loop sees `terminated` and gives up.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(callsBeforeTerminate);
  });
});
