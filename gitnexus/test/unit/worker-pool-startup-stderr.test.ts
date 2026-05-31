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
