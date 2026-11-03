import { describe, expect, it } from 'vitest';
import {
  EmbeddingByteBudget,
  resolveAnalysisResourceBudget,
} from '../../src/core/analysis-resource-budget.js';

const MIB = 1024 * 1024;
const request = { effectiveMemoryBytes: 32_768 * MIB, availableCpus: 24, modelMemoryMb: 2048 };

describe('analysis resource admission', () => {
  it('bounds every phase separately and reuses parser capacity for embedding', () => {
    for (const memoryMb of [2048, 4096, 8192, 16384, 32768]) {
      for (const availableCpus of [1, 2, 4, 24]) {
        const budget = resolveAnalysisResourceBudget({
          ...request,
          effectiveMemoryBytes: memoryMb * MIB,
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

  it('preserves explicit main-heap semantics and preferred concurrency when they fit', () => {
    const budget = resolveAnalysisResourceBudget({
      ...request,
      totalMb: 24_576,
      mainHeapMb: 8192,
      preferredWorkers: 6,
    });
    expect(budget.mainHeapMb).toBe(8192);
    expect(budget.parse.workers).toBe(6);
    expect(budget.automatic).toBe(false);
    expect(Object.isFrozen(budget)).toBe(true);
    expect(Object.isFrozen(budget.parse)).toBe(true);
    expect(Object.isFrozen(budget.embedding)).toBe(true);
  });

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
    ).toThrow('do not fit');
    expect(() => resolveAnalysisResourceBudget({ ...request, workers: 24 })).toThrow(
      'CPU allowance',
    );
    expect(() => resolveAnalysisResourceBudget({ ...request, graphPoolBytes: 0 })).toThrow(
      'graph pool bytes',
    );
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
