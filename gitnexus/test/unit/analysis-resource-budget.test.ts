import { describe, expect, it } from 'vitest';
import {
  EmbeddingByteBudget,
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

  it.each([undefined, 512, 4096])(
    'reserves inherited main-heap limits for worker override %s',
    (workerHeapMb) => {
      const budget = resolveAnalysisResourceBudget({
        ...request,
        preferredWorkers: 16,
        workerHeapMb,
      });
      expect(budget.parse.workerHeapMb).toBeGreaterThanOrEqual(budget.mainHeapMb);
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
    [8192, 1],
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
    expect(budget.parse.workerHeapMb).toBeGreaterThanOrEqual(mainHeapMb);
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

  it('reports the inherited heap requirement when explicit worker caps cannot constrain it', () => {
    expect(() =>
      resolveAnalysisResourceBudget({
        ...request,
        totalMb: 24576,
        mainHeapMb: 8192,
        workers: 2,
        workerHeapMb: 1024,
        graphPoolBytes: 1024 * MIB,
      }),
    ).toThrow('requires at least 28806 MiB');
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
