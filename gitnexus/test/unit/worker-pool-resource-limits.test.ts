import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Pin physical RAM to 32GB so the half-of-RAM-per-worker formula resolves
// deterministically regardless of the host machine.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = { ...actual, totalmem: () => 32 * 1024 * 1024 * 1024 };
  return { ...mocked, default: mocked };
});

// Capture the exact options the pool's PRODUCTION factory passes to the
// Worker constructor — the formula alone doesn't prove the wiring, and a
// typo'd resourceLimits key would silently uncap workers again (#2649).
// vi.mock factories are hoisted above imports, so the capture array must be
// hoisted too and EventEmitter imported inside the factory.
const workerCtorOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('node:worker_threads', async () => {
  const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads');
  const { EventEmitter } = await import('node:events');
  class CapturingWorker extends EventEmitter {
    private currentPaths: string[] = [];
    constructor(_url: unknown, options: unknown) {
      super();
      workerCtorOptions.push(options);
      queueMicrotask(() => this.emit('message', { type: 'ready' }));
    }
    postMessage(msg: unknown): void {
      if (msg === null || typeof msg !== 'object') return;
      const type = (msg as { type?: unknown }).type;
      if (type === 'sub-batch') {
        const files = (msg as { files?: Array<{ path: string }> }).files ?? [];
        this.currentPaths = files.map((file) => file.path);
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
  return { ...actual, Worker: CapturingWorker };
});

const setConstrainedMemory = (value: number): (() => void) => {
  const desc = Object.getOwnPropertyDescriptor(process, 'constrainedMemory');
  Object.defineProperty(process, 'constrainedMemory', { configurable: true, value: () => value });
  return () => {
    if (desc) Object.defineProperty(process, 'constrainedMemory', desc);
    else delete (process as { constrainedMemory?: unknown }).constrainedMemory;
  };
};

describe('resolveWorkerHeapCapMb (#2649 per-worker heap cap)', () => {
  let initialOverride: string | undefined;
  let restoreConstrained: (() => void) | undefined;

  beforeEach(() => {
    initialOverride = process.env.GITNEXUS_WORKER_HEAP_MB;
    delete process.env.GITNEXUS_WORKER_HEAP_MB;
    // Unconstrained by default so the mocked 32GB totalmem governs.
    restoreConstrained = setConstrainedMemory(0);
    workerCtorOptions.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    if (initialOverride === undefined) delete process.env.GITNEXUS_WORKER_HEAP_MB;
    else process.env.GITNEXUS_WORKER_HEAP_MB = initialOverride;
    restoreConstrained?.();
    restoreConstrained = undefined;
  });

  it('splits half of RAM across the pool, clamped to the 4096 ceiling', async () => {
    const { resolveWorkerHeapCapMb } = await import(
      '../../src/core/ingestion/workers/worker-pool.js'
    );
    // 32GB -> half = 16384MB; /16 workers = 1024; /4 workers = 4096 (at ceiling);
    // /2 workers = 8192 -> clamped to 4096.
    expect([16, 4, 2].map((n) => resolveWorkerHeapCapMb(n))).toEqual([1024, 4096, 4096]);
  });

  it('never drops below the 512MB floor on small shares', async () => {
    const { resolveWorkerHeapCapMb } = await import(
      '../../src/core/ingestion/workers/worker-pool.js'
    );
    // 32GB half-share across 64 workers = 256 -> floored to 512.
    expect(resolveWorkerHeapCapMb(64)).toBe(512);
  });

  it('GITNEXUS_WORKER_HEAP_MB overrides the formula', async () => {
    process.env.GITNEXUS_WORKER_HEAP_MB = '768';
    const { resolveWorkerHeapCapMb } = await import(
      '../../src/core/ingestion/workers/worker-pool.js'
    );
    expect([1, 16].map((n) => resolveWorkerHeapCapMb(n))).toEqual([768, 768]);
  });

  it('honors a real cgroup limit instead of host RAM (#2649 review — container overcommit)', async () => {
    // 8GB cgroup limit on the mocked 32GB host, pool of 4: the cap must come
    // from the container (8192/2/4 = 1024), not the host (32768/2/4 = 4096 —
    // which would let one worker outgrow a quarter of the whole container).
    restoreConstrained?.();
    restoreConstrained = setConstrainedMemory(8 * 1024 * 1024 * 1024);
    const { resolveWorkerHeapCapMb } = await import(
      '../../src/core/ingestion/workers/worker-pool.js'
    );
    expect(resolveWorkerHeapCapMb(4)).toBe(1024);
  });

  it('wires the cap into the production Worker resourceLimits (#2649 review)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-limits-'));
    const workerPath = path.join(tempDir, 'fake-worker.js');
    fs.writeFileSync(workerPath, '// fake worker path for createWorkerPool');
    try {
      const { createWorkerPool, resolveWorkerHeapCapMb } = await import(
        '../../src/core/ingestion/workers/worker-pool.js'
      );
      const pool = createWorkerPool(pathToFileURL(workerPath) as URL, 2, {
        shutdownDrainMs: 25,
      });
      try {
        await pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
          { path: 'src/a.ts', content: 'const a = 1;' },
        ]);
      } finally {
        await pool.terminate();
      }
      expect(workerCtorOptions.length).toBeGreaterThan(0);
      expect(workerCtorOptions[0]).toMatchObject({
        resourceLimits: { stackSizeMb: 16, maxOldGenerationSizeMb: resolveWorkerHeapCapMb(2) },
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
