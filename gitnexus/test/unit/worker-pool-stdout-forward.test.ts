/**
 * Worker stdout is piped and forwarded, not inherited.
 *
 * The production factory now spawns workers with `{ stdout: true }`: workers
 * with INHERITED stdout have been observed to crash silently during
 * top-of-script init (exit code 1, nothing on stderr, roughly half of a
 * concurrently spawned pool) on macOS 26.5 under both Node 22 and 26.
 * Piping avoids the crash, and `forwardWorkerStdout` mirrors the piped
 * stream back to the parent's stdout so worker logs stay visible — the same
 * tee shape `captureWorkerStderr` uses for stderr (#1741).
 *
 * This test injects a fake worker that writes to its `stdout` stream and
 * asserts the pool forwards it to `process.stdout`; a stdout-less test
 * factory must remain a no-op.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';

const WORKER_LOG_LINE = '{"level":30,"name":"gitnexus","msg":"parse-worker log line"}\n';

/**
 * Worker double that starts cleanly and emits a log line on its piped
 * `stdout` stream, mirroring a production worker spawned with
 * `{ stdout: true }`.
 */
class ReadyWorkerWithStdout extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  constructor() {
    super();
    queueMicrotask(() => {
      this.stdout.emit('data', Buffer.from(WORKER_LOG_LINE));
      this.emit('message', { type: 'ready' });
    });
  }
  postMessage(): void {}
  async terminate(): Promise<number> {
    return 0;
  }
}

/** Worker double with no stdio streams at all (typical test factory shape). */
class ReadyWorkerWithoutStdio extends EventEmitter {
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
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-stdout-forward-'));
  const workerPath = path.join(tempDir, 'fake-worker.js');
  fs.writeFileSync(workerPath, '// fake');
  workerUrl = pathToFileURL(workerPath) as URL;
  // Capture the forwarded worker stdout without polluting test output.
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('worker pool — stdout forwarding', () => {
  it("forwards a worker's piped stdout to the parent process stdout", async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new ReadyWorkerWithStdout() as unknown as Worker,
    });

    // Empty dispatch settles the initial-ready gate; the fake worker's stdout
    // line is emitted in the same microtask turn as its ready handshake.
    await pool.dispatch([]);

    const forwarded = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(forwarded).toContain('parse-worker log line');

    await pool.terminate().catch(() => undefined);
  });

  it('is a no-op for workers without a stdout stream (test factories)', async () => {
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new ReadyWorkerWithoutStdio() as unknown as Worker,
    });

    // Must not throw while wiring stdio on a stream-less worker.
    await pool.dispatch([]);
    expect(pool.getStats().activeSlots).toBe(1);

    await pool.terminate().catch(() => undefined);
  });
});
