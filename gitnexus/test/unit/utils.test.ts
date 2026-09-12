import { describe, it, expect, vi } from 'vitest';
import { generateId, mapConcurrent } from '../../src/lib/utils.js';

describe('generateId', () => {
  it('creates id from label and name', () => {
    expect(generateId('Function', 'main')).toBe('Function:main');
  });

  it('handles labels with various node types', () => {
    expect(generateId('File', 'src/index.ts')).toBe('File:src/index.ts');
    expect(generateId('Class', 'UserService')).toBe('Class:UserService');
    expect(generateId('Method', 'getData')).toBe('Method:getData');
    expect(generateId('Folder', 'src')).toBe('Folder:src');
    expect(generateId('Interface', 'IUser')).toBe('Interface:IUser');
  });

  it('handles special characters in name', () => {
    expect(generateId('Function', 'path/to/file.ts:init')).toBe('Function:path/to/file.ts:init');
  });

  it('handles empty strings', () => {
    expect(generateId('', '')).toBe(':');
    expect(generateId('', 'name')).toBe(':name');
    expect(generateId('label', '')).toBe('label:');
  });

  it('handles relationship IDs', () => {
    expect(generateId('CONTAINS', 'Folder:src->File:src/index.ts')).toBe(
      'CONTAINS:Folder:src->File:src/index.ts',
    );
  });

  it('handles multi-language node types', () => {
    expect(generateId('Struct', 'Point')).toBe('Struct:Point');
    expect(generateId('Trait', 'Display')).toBe('Trait:Display');
    expect(generateId('Impl', 'Display for Point')).toBe('Impl:Display for Point');
    expect(generateId('Enum', 'Color')).toBe('Enum:Color');
    expect(generateId('Namespace', 'std')).toBe('Namespace:std');
    expect(generateId('Constructor', 'User')).toBe('Constructor:User');
  });
});

describe('mapConcurrent', () => {
  /**
   * Yield to the event loop once the microtask queue is drained, which is
   * exactly when `mapConcurrent` has finished awaiting one wave and started the
   * next. `setImmediate` fires after microtasks by definition, so this waits on
   * the scheduler rather than on elapsed time.
   */
  const settleWave = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /**
   * Drive `mapConcurrent` over `itemCount` items whose promises are all held
   * open by hand, releasing everything in flight one batch at a time.
   *
   * Same idea as the ordering test above: real `setTimeout` sleeps only made
   * the same contract slower and jitter-dependent — a loaded shard could let a
   * 5ms item outlive the next scheduling decision. Here nothing settles until
   * this function says so, so `peak` is the scheduler's doing and nothing else.
   *
   * Returns how many items were in flight at the start of each batch, and the
   * highest number ever concurrently in flight.
   */
  async function releaseInWaves(
    itemCount: number,
    concurrency: number,
  ): Promise<{ started: number[]; peak: number }> {
    let inFlight = 0;
    let peak = 0;
    const holds: (() => void)[] = [];
    const settled = mapConcurrent(
      Array.from({ length: itemCount }, (_, i) => i),
      () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          holds.push(() => {
            inFlight -= 1;
            resolve();
          });
        }),
      { concurrency },
    );

    const started: number[] = [];
    for (let wave = 0; wave < Math.ceil(itemCount / concurrency); wave += 1) {
      started.push(holds.length);
      for (const release of holds.splice(0)) release();
      await settleWave();
    }

    await settled;
    return { started, peak };
  }

  it('returns results in INPUT order regardless of completion order', async () => {
    // Deterministic by construction: each item's promise is settled by hand in
    // an order chosen here, so the test cannot depend on how loaded the shard
    // is. Real `setTimeout` deltas would only make the same contract flaky.
    const completed: string[] = [];
    const resolvers: (() => void)[] = [];
    const settled = mapConcurrent(
      ['a', 'b', 'c'],
      (item) =>
        new Promise<string>((resolve) => {
          resolvers.push(() => {
            completed.push(item);
            resolve(item.toUpperCase());
          });
        }),
      { concurrency: 3 },
    );

    // All three `run` calls happen before any of them can settle — otherwise the
    // completion order below would not be ours to choose.
    expect(resolvers).toHaveLength(3);
    for (const index of [2, 0, 1]) resolvers[index]();

    expect(await settled).toEqual(['A', 'B', 'C']);
    expect(completed).toEqual(['c', 'a', 'b']);
  });

  it('never exceeds the concurrency limit', async () => {
    const { started, peak } = await releaseInWaves(9, 2);

    // 9 items at concurrency 2: four full waves and a remainder of one. Nothing
    // ran outside a wave, which is what the peak below rests on — an
    // implementation that ignored `concurrency` would show 9 here and a peak
    // of 9.
    expect(started).toEqual([2, 2, 2, 2, 1]);
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
    const { started, peak } = await releaseInWaves(3, 1);

    expect(started).toEqual([1, 1, 1]);
    expect(peak).toBe(1);
  });

  it('rejects a non-finite concurrency instead of silently returning no results', async () => {
    // `Math.max(1, NaN)` is `NaN`, and an unguarded `chunk` turned that into a
    // single EMPTY wave: no item ever ran, no error was raised, and the caller
    // read the empty result as "nothing matched" (#2915).
    const run = vi.fn(async (item: number) => item);

    await expect(mapConcurrent([1, 2, 3], run, { concurrency: Number.NaN })).rejects.toThrow(
      RangeError,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
