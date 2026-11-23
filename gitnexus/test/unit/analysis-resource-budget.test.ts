import { describe, expect, it } from 'vitest';
import {
  EmbeddingByteBudget,
  isConstrainedPdgBuild,
  resolveAnalysisResourceBudget,
} from '../../src/core/analysis-resource-budget.js';

const MIB = 1024 * 1024;
const request = { effectiveMemoryBytes: 32_768 * MIB, availableCpus: 24, modelMemoryMb: 2048 };

describe('analysis resource admission', () => {
  it.each([1, 4, 16])(
    'bounds the automatic graph pool while preserving the COPY floor at granule ratio %s',
    (scale) => {
      const automatic = resolveAnalysisResourceBudget({ ...request, graphPoolGranuleRatio: scale });
      expect(automatic.parse.graphPoolBytes).toBe(
        Math.max(256 * scale, Math.floor(24576 * 0.15)) * MIB,
      );
      const explicit = resolveAnalysisResourceBudget({
        ...request,
        totalMb: 16384,
        graphPoolGranuleRatio: scale,
      });
      expect(explicit.parse.graphPoolBytes).toBeGreaterThanOrEqual(256 * scale * MIB);
      expect(explicit.parse.reservedBytes).toBeLessThanOrEqual(explicit.totalBytes);
    },
  );
  it('rejects an explicit family budget that cannot fit the 64 KiB COPY floor', () => {
    expect(() =>
      resolveAnalysisResourceBudget({ ...request, totalMb: 2048, graphPoolGranuleRatio: 16 }),
    ).toThrow('cannot admit');
  });
  it.each([2048, 4096, 8192, 32768])(
    'keeps automatic admission inside RAM on a %s MiB host',
    (memoryMb) => {
      for (const modelMemoryMb of [0, 2048]) {
        for (const graphPoolGranuleRatio of [1, 4, 16]) {
          for (const supervisorBytes of [0, 192 * MIB]) {
            const input = {
              effectiveMemoryBytes: memoryMb * MIB,
              availableCpus: 8,
              preferredWorkers: 16,
              modelMemoryMb,
              graphPoolGranuleRatio,
              supervisorBytes,
            };
            const totalMb = Math.floor(memoryMb * 0.75);
            // Small hosts cannot fit the local model or large-page COPY floor.
            const cannotFit =
              memoryMb === 2048
                ? modelMemoryMb > 0 || graphPoolGranuleRatio > 1 || supervisorBytes > 0
                : memoryMb === 4096
                  ? modelMemoryMb > 0 || graphPoolGranuleRatio === 16
                  : memoryMb === 8192 && graphPoolGranuleRatio === 16;
            if (cannotFit) {
              expect(() => resolveAnalysisResourceBudget(input)).toThrow('cannot admit');
            } else {
              const budget = resolveAnalysisResourceBudget(input);
              expect(budget.totalBytes).toBe(totalMb * MIB);
              expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
              expect(budget.embedding.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
              expect(budget.parse.workers).toBeLessThanOrEqual(7);
              expect(budget.parse.workerHeapMb).toBeGreaterThanOrEqual(512);
            }
          }
        }
      }
    },
  );
  it('rejects an impossible explicit heap without growing the automatic family ceiling', () => {
    expect(() =>
      resolveAnalysisResourceBudget({
        ...request,
        effectiveMemoryBytes: 7500 * MIB,
        modelMemoryMb: 0,
        mainHeapMb: 12000,
      }),
    ).toThrow('cannot admit');
  });

  it.each([undefined, 1])(
    'makes room for a fitting explicit worker heap with %s workers',
    (workers) => {
      const budget = resolveAnalysisResourceBudget({ ...request, workers, workerHeapMb: 9500 });
      expect(budget.mainHeapMb).toBeGreaterThanOrEqual(384);
      expect(budget.mainHeapMb).toBeLessThan(8601);
      expect(budget.parse.workers).toBe(1);
      expect(budget.parse.workerHeapMb).toBe(9500);
      expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
      expect(budget.embedding.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
    },
  );

  it.each([
    [undefined, 576, 8],
    [512, 512, 8],
    [4096, 4096, 1],
  ])(
    'charges each worker its own cap for worker override %s',
    (workerHeapMb, expectedWorkerHeapMb, expectedWorkers) => {
      const budget = resolveAnalysisResourceBudget({
        ...request,
        preferredWorkers: 16,
        workerHeapMb,
      });
      // The pool enforces the worker cap, so the main heap is never charged twice.
      expect(budget.mainHeapMb).toBe(12308);
      expect(budget.parse.workerHeapMb).toBe(expectedWorkerHeapMb);
      expect(budget.parse.workers).toBe(expectedWorkers);
      expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
    },
  );

  it('charges a retained supervisor once per phase, independently of worker thread count', () => {
    const fixed = {
      ...request,
      totalMb: 24576,
      mainHeapMb: 4096,
      workers: 2,
      workerHeapMb: 1024,
      graphPoolBytes: 1024 * MIB,
    };
    const before = resolveAnalysisResourceBudget(fixed);
    const after = resolveAnalysisResourceBudget({ ...fixed, supervisorBytes: 192 * MIB + 1 });
    expect(after.supervisorBytes).toBe(193 * MIB);
    expect(after.mainHeapMb).toBe(before.mainHeapMb);
    expect(after.parse.workers).toBe(before.parse.workers);
    expect(after.parse.workerHeapMb).toBe(before.parse.workerHeapMb);
    expect(after.parse.reservedBytes - before.parse.reservedBytes).toBe(193 * MIB);
    expect(after.embedding.reservedBytes - before.embedding.reservedBytes).toBe(193 * MIB);
  });

  it('rejects an embedding-only process family whose supervisor exceeds its remaining capacity', () => {
    const fixed = {
      ...request,
      totalMb: 1024,
      mainHeapMb: 384,
      graphPoolBytes: 256 * MIB,
      modelMemoryMb: 0,
      includeParsing: false,
    };
    expect(
      resolveAnalysisResourceBudget({ ...fixed, supervisorBytes: 96 * MIB }).embedding
        .reservedBytes,
    ).toBe(1024 * MIB);
    expect(() => resolveAnalysisResourceBudget({ ...fixed, supervisorBytes: 97 * MIB })).toThrow(
      'cannot admit',
    );
  });

  it.each([NaN, Infinity, -1, 0.5])(
    'rejects an invalid supervisor reservation %s',
    (supervisorBytes) => {
      expect(() => resolveAnalysisResourceBudget({ ...request, supervisorBytes })).toThrow(
        'supervisor',
      );
    },
  );

  it('bounds every phase separately and reuses parser capacity for embedding', () => {
    for (const memoryMb of [2048, 4096, 8192, 16384, 32768]) {
      for (const availableCpus of [1, 2, 4, 24]) {
        const budget = resolveAnalysisResourceBudget({
          ...request,
          effectiveMemoryBytes: memoryMb * MIB,
          totalMb: Math.floor(memoryMb * 0.75),
          availableCpus,
          modelMemoryMb: 0,
        });
        expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
        expect(budget.embedding.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
        expect(budget.totalBytes).toBeLessThan(memoryMb * MIB);
        expect(budget.parse.workers).toBeLessThanOrEqual(Math.max(1, availableCpus - 1));
        expect(budget.embedding.nativeThreads).toBeLessThanOrEqual(availableCpus);
      }
    }
  });

  it.each([
    [8192, 6],
    [1024, 6],
  ])('admits a %s MiB main heap with %s fitting workers', (mainHeapMb, workers) => {
    const budget = resolveAnalysisResourceBudget({
      ...request,
      totalMb: 24_576,
      mainHeapMb,
      preferredWorkers: 6,
    });
    expect(budget.mainHeapMb).toBe(mainHeapMb);
    expect(budget.parse.workers).toBe(workers);
    expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
    expect(budget.automatic).toBe(false);
    expect(Object.isFrozen(budget)).toBe(true);
    expect(Object.isFrozen(budget.parse)).toBe(true);
    expect(Object.isFrozen(budget.embedding)).toBe(true);
  });

  it.each([1, 4])(
    'admits an explicit worker override on %s CPU(s) within its memory budget',
    (availableCpus) => {
      const input = { ...request, availableCpus, mainHeapMb: 1024, workers: 12 };
      const budget = resolveAnalysisResourceBudget(input);
      expect(budget.parse.workers).toBe(12);
      expect(budget.parse.workerHeapMb).toBeGreaterThanOrEqual(512);
      expect(budget.parse.nativeThreads).toBe(availableCpus);
      expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
      expect(() =>
        resolveAnalysisResourceBudget({ ...input, totalMb: 24576, workerHeapMb: 4096 }),
      ).toThrow('cannot admit');
    },
  );

  it('admits an HTTP embedding-only resume below the parser minimum', () => {
    const input = { ...request, totalMb: 1024, modelMemoryMb: 0 };
    expect(() => resolveAnalysisResourceBudget(input)).toThrow('cannot admit');
    const budget = resolveAnalysisResourceBudget({ ...input, includeParsing: false });
    expect(budget.parse.workers).toBe(0);
    expect(budget.embedding.reservedBytes).toBeLessThanOrEqual(1024 * MIB);
  });

  it('preserves the heap-only flag minimum without silently raising it', () => {
    const budget = resolveAnalysisResourceBudget({ ...request, mainHeapMb: 200 });
    expect(budget.mainHeapMb).toBe(200);
    expect(budget.parse.nativeThreads).toBe(request.availableCpus);
    expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
    expect(() => resolveAnalysisResourceBudget({ ...request, mainHeapMb: 199 })).toThrow(
      'cannot admit',
    );
  });

  it('lets vector index construction use the CPU allowance beyond the model thread cap', () => {
    const budget = resolveAnalysisResourceBudget({ ...request, embeddingThreads: 2 });
    expect(budget.embedding.nativeThreads).toBe(2);
    expect(budget.embedding.indexThreads).toBe(request.availableCpus);
  });

  it('admits explicit embedding concurrency and includes sidecar heap within the model reservation', () => {
    const budget = resolveAnalysisResourceBudget({ ...request, embeddingThreads: 8 });
    expect(budget.embedding.nativeThreads).toBe(8);
    expect(budget.embedding.modelHeapMb).toBe(512);
    expect(budget.embedding.modelHeapMb * MIB + 48 * MIB).toBeLessThan(budget.embedding.modelBytes);
    expect(() => resolveAnalysisResourceBudget({ ...request, embeddingThreads: 25 })).toThrow(
      'CPU allowance',
    );
  });

  it('admits the full working set of a supported 10 MiB node with a larger budget', () => {
    const budget = resolveAnalysisResourceBudget({
      ...request,
      totalMb: 8192,
      modelMemoryMb: 0,
      includeParsing: false,
    });
    expect(budget.embedding.queueBytes).toBeGreaterThan(18 * 10 * MIB + MIB);
    expect(budget.embedding.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
  });

  it('rejects impossible explicit combinations before work starts', () => {
    expect(() => resolveAnalysisResourceBudget({ ...request, totalMb: 128 })).toThrow(
      'cannot admit',
    );
    expect(() => resolveAnalysisResourceBudget({ ...request, totalMb: 65536 })).toThrow(
      'exceeds effective',
    );
    expect(() =>
      resolveAnalysisResourceBudget({ ...request, totalMb: 4096, mainHeapMb: 8192 }),
    ).toThrow('cannot admit');
    expect(() =>
      resolveAnalysisResourceBudget({ ...request, totalMb: 8192, workers: 4, workerHeapMb: 4096 }),
    ).toThrow('cannot admit');
    expect(() => resolveAnalysisResourceBudget({ ...request, totalMb: 8192, workers: 24 })).toThrow(
      'cannot admit',
    );
    expect(() => resolveAnalysisResourceBudget({ ...request, graphPoolBytes: 0 })).toThrow(
      'graph pool bytes',
    );
    expect(() => resolveAnalysisResourceBudget({ ...request, graphPoolBytes: MIB })).toThrow(
      'graph pool bytes',
    );
    expect(() => resolveAnalysisResourceBudget({ ...request, modelMemoryMb: 128 })).toThrow(
      'model reservation',
    );
  });

  it.each([
    // The limit fits beside the worker reservation: reserve what the process
    // can actually use.
    [15_700, 4144],
    [32_768, 4144],
  ])('treats an unpinned heap limit on a %i MiB host as a ceiling', (ramMb, mainHeapMb) => {
    const budget = resolveAnalysisResourceBudget({
      effectiveMemoryBytes: ramMb * MIB,
      availableCpus: 4,
      modelMemoryMb: 0,
      supervisorBytes: 225 * MIB,
      mainHeapLimitMb: 4144,
    });
    expect(budget.mainHeapMb).toBe(mainHeapMb);
    expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
  });

  it('reports the requirement of explicit main and worker reservations that cannot fit', () => {
    // 8192 main + 1475 headroom + 1024 graph pool + 4 x (1024 + 128) per worker.
    expect(() =>
      resolveAnalysisResourceBudget({
        ...request,
        totalMb: 12288,
        mainHeapMb: 8192,
        workers: 4,
        workerHeapMb: 1024,
        graphPoolBytes: 1024 * MIB,
      }),
    ).toThrow('requires at least 15299 MiB');
  });

  // A 4-CPU container with a resident supervisor and no local model.
  const container = (gib: number, cpus = 4) => ({
    effectiveMemoryBytes: gib * 1024 * MIB,
    availableCpus: cpus,
    preferredWorkers: 16,
    supervisorBytes: 200 * MIB,
    modelMemoryMb: 0,
  });

  it.each([
    [4, undefined, 1403, 1, 512, 3072 * MIB],
    [4, 1, 1403, 1, 512, 3072 * MIB],
    [10, undefined, 4206, 1, 1072, 7680 * MIB],
    [10, 1, 4206, 1, 1072, 7680 * MIB],
    [16, undefined, 6850, 3, 512, 12_288 * MIB],
    [16, 1, 6850, 1, 1792, 12_288 * MIB],
  ])(
    'sizes the main heap first in a %i GiB container with workers %s',
    (gib, workers, mainHeapMb, parseWorkers, workerHeapMb, reservedBytes) => {
      const budget = resolveAnalysisResourceBudget({ ...container(gib), workers });
      expect(budget.mainHeapMb).toBe(mainHeapMb);
      expect(budget.parse.workers).toBe(parseWorkers);
      expect(budget.parse.workerHeapMb).toBe(workerHeapMb);
      expect(budget.parse.reservedBytes).toBe(reservedBytes);
      expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
    },
  );

  it('admits the automatic main-heap ceiling as an explicit reservation and rejects one more MiB', () => {
    expect(resolveAnalysisResourceBudget({ ...container(10), mainHeapMb: 4206 }).mainHeapMb).toBe(
      4206,
    );
    expect(() => resolveAnalysisResourceBudget({ ...container(10), mainHeapMb: 4207 })).toThrow(
      'requires at least 7681 MiB',
    );
  });

  it('admits a 6850 MiB main heap beside three workers in 16 GiB', () => {
    const budget = resolveAnalysisResourceBudget({ ...container(16), mainHeapMb: 6850 });
    expect(budget.parse.workers).toBe(3);
    expect(budget.parse.reservedBytes).toBeLessThanOrEqual(budget.totalBytes);
  });

  it('fills a large host with capped workers after the main-heap cap', () => {
    const budget = resolveAnalysisResourceBudget(container(64, 16));
    expect(budget.mainHeapMb).toBe(16_384);
    expect(budget.parse.workers).toBe(15);
    expect(budget.parse.workerHeapMb).toBe(1376);
  });

  it.each([4, 24])('keeps the measured 6 GiB PDG envelope constrained with %i CPUs', (cpus) => {
    const budget = resolveAnalysisResourceBudget({ ...container(32, cpus), totalMb: 6144 });
    expect(budget.parse.workers).toBe(1);
    expect(isConstrainedPdgBuild(true, budget)).toBe(true);
  });

  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed total budget %s',
    (totalMb) => {
      expect(() => resolveAnalysisResourceBudget({ ...request, totalMb })).toThrow();
    },
  );
});

describe('embedding payload accounting', () => {
  it('accounts an active payload and prefetch together, with a stable peak', () => {
    const budget = new EmbeddingByteBudget(1024);
    for (let i = 0; i < 100_000; i++) {
      const active = budget.reserve(512);
      const prefetched = budget.reserve(512);
      expect(budget.usedBytes).toBe(1024);
      prefetched();
      active();
    }
    expect(budget.usedBytes).toBe(0);
    expect(budget.peakBytes).toBe(1024);
  });

  it('rejects overflow without leaking capacity and detects double release', () => {
    const budget = new EmbeddingByteBudget(1024);
    const release = budget.reserve(768);
    expect(() => budget.reserve(257)).toThrow('256 bytes available');
    expect(budget.usedBytes).toBe(768);
    release();
    expect(() => release()).toThrow('released twice');
    expect(budget.usedBytes).toBe(0);
    expect(() => budget.reserve(-1)).toThrow();
  });
});
