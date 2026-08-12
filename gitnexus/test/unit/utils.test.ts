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
