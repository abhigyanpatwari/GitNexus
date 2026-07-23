import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pin physical RAM to 32GB so the half-of-RAM-per-worker formula resolves
// deterministically regardless of the host machine.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = { ...actual, totalmem: () => 32 * 1024 * 1024 * 1024 };
  return { ...mocked, default: mocked };
});

describe('resolveWorkerHeapCapMb (#2649 per-worker heap cap)', () => {
  let initialOverride: string | undefined;

  beforeEach(() => {
    initialOverride = process.env.GITNEXUS_WORKER_HEAP_MB;
    delete process.env.GITNEXUS_WORKER_HEAP_MB;
    vi.resetModules();
  });

  afterEach(() => {
    if (initialOverride === undefined) delete process.env.GITNEXUS_WORKER_HEAP_MB;
    else process.env.GITNEXUS_WORKER_HEAP_MB = initialOverride;
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
});
