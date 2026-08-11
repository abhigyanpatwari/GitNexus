/**
 * `chunk` / `mapBatches` — the shape every query built from a caller-sized array
 * has to take (#2915: one condition per diff hunk overflowed LadybugDB's
 * recursive evaluator copy, a bare SIGBUS with no error output).
 */
import { describe, it, expect, vi } from 'vitest';
import { LBUG_QUERY_BATCH_SIZE, mapConcurrent } from '../../src/core/lbug/query-batch.js';
import { chunk } from '../../src/lib/utils.js';

describe('chunk', () => {
  it('splits into consecutive slices of at most `size`', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns no batches for empty input, so a caller never queries nothing', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('keeps an exact multiple free of a trailing empty batch', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('splits at the shared query batch size', () => {
    expect(
      chunk(
        Array.from({ length: LBUG_QUERY_BATCH_SIZE + 1 }, (_, i) => i),
        LBUG_QUERY_BATCH_SIZE,
      ),
    ).toHaveLength(2);
  });

  it('rejects a size that would loop forever', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe('mapConcurrent', () => {
  it('returns results in batch order regardless of completion order', async () => {
    const order: number[] = [];
    const results = await mapConcurrent(
      [30, 10, 20],
      async (delay) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(delay);
        return delay;
      },
      { concurrency: 3 },
    );

    expect(results).toEqual([30, 10, 20]);
    expect(order).toEqual([10, 20, 30]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 9 }, (_, i) => i),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
      { concurrency: 2 },
    );

    expect(peak).toBe(2);
  });

  it('degrades a failed batch to undefined and keeps the rest', async () => {
    const onError = vi.fn();
    const behavior: Record<string, () => Promise<string>> = {
      'ok-1': async () => 'ok-1',
      boom: async () => {
        throw new Error('query failed');
      },
      'ok-2': async () => 'ok-2',
    };
    const results = await mapConcurrent(['ok-1', 'boom', 'ok-2'], (item) => behavior[item](), {
      concurrency: 3,
      onError,
    });

    expect(results).toEqual(['ok-1', undefined, 'ok-2']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('runs sequentially when concurrency is 1', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(
      [1, 2, 3],
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
      { concurrency: 1 },
    );

    expect(peak).toBe(1);
  });
});
