// gitnexus/test/unit/move/concurrency.test.ts
import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../../src/core/move/concurrency.js';

describe('mapWithConcurrency', () => {
  it('never exceeds the concurrency limit and reaches it', async () => {
    let inFlight = 0,
      peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBe(2);
  });

  it('fail-fast returns first error and stops scheduling new work', async () => {
    const started: number[] = [];
    const { failure } = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      1,
      async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
      },
      { failFast: true },
    );
    expect(failure?.error).toBeInstanceOf(Error);
    expect(failure?.item).toBe(2);
    expect(started).toEqual([1, 2]); // 3..6 never scheduled
  });

  it('fail-fast with limit=2: awaits in-flight workers, stops new scheduling, captures first error', async () => {
    let resolveA!: () => void;
    const latchA = new Promise<void>((r) => {
      resolveA = r;
    });
    const aCompleted: boolean[] = [];
    const started: number[] = [];

    const resultPromise = mapWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (n) => {
        started.push(n);
        if (n === 1) {
          await latchA;
          aCompleted.push(true);
          return;
        }
        if (n === 2) throw new Error('worker-B-fail');
      },
      { failFast: true },
    );

    // Allow microtasks to run so both workers start and worker B's rejection settles.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Worker B has rejected; worker A is still blocked on latchA.
    // Release A so mapWithConcurrency can resolve.
    resolveA();

    const { failure } = await resultPromise;

    // (a) Worker A completed before the result resolved.
    expect(aCompleted).toHaveLength(1);
    // (b) Items after the failing index were never scheduled.
    expect(started).not.toContain(3);
    expect(started).not.toContain(4);
    expect(started).not.toContain(5);
    // (c) The failure captures the first (and only) error.
    expect(failure?.error).toBeInstanceOf(Error);
    expect((failure?.error as Error).message).toBe('worker-B-fail');
    expect(failure?.item).toBe(2);
  });

  it('reports the earliest scheduled in-flight failure, not the first rejection to settle', async () => {
    let releaseFirst!: () => void;
    const firstCanFail = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const resultPromise = mapWithConcurrency(
      ['causal', 'collateral', 'never-started'],
      2,
      async (item) => {
        if (item === 'causal') {
          await firstCanFail;
          throw new Error('causal failure');
        }
        if (item === 'collateral') {
          releaseFirst();
          throw new Error('collateral failure settled first');
        }
      },
      { failFast: true },
    );

    const { failure } = await resultPromise;
    expect(failure?.item).toBe('causal');
    expect((failure?.error as Error).message).toBe('causal failure');
  });

  it('without failFast, first worker rejection rejects the returned promise', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('non-failfast-rejection');
      }),
    ).rejects.toThrow('non-failfast-rejection');
  });

  it('limit=1 runs sequentially in order', async () => {
    const order: number[] = [];
    const { results } = await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      order.push(n);
      return n * 2;
    });
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([2, 4, 6]);
  });
});
