import { afterEach, describe, expect, it, vi } from 'vitest';
import { WATCH_FULL_REFRESH_PATH, WatchRefreshQueue } from '../../src/cli/watch-queue.js';

afterEach(() => vi.useRealTimers());

describe('WatchRefreshQueue', () => {
  it('propagates an initial refresh failure without reporting it as retryable', async () => {
    const onError = vi.fn();
    const queue = new WatchRefreshQueue(
      async () => {
        throw new Error('initial analyze failed');
      },
      onError,
      10,
    );

    await expect(queue.runInitial()).rejects.toThrow('initial analyze failed');
    expect(onError).not.toHaveBeenCalled();
    await queue.close();
  });

  it('debounces and deduplicates rapid writes', async () => {
    vi.useFakeTimers();
    const batches: readonly string[][] = [];
    const mutable = batches as string[][];
    const queue = new WatchRefreshQueue(
      async (paths) => mutable.push([...paths]),
      () => {},
      100,
    );

    queue.enqueue('src/a.ts');
    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(50);
    queue.enqueue('src/b.ts');
    await vi.advanceTimersByTimeAsync(99);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await queue.waitForIdle();

    expect(batches).toEqual([['src/a.ts', 'src/b.ts']]);
  });

  it('queues edits made during a refresh and never overlaps writers', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    let active = 0;
    let peak = 0;
    const batches: string[][] = [];
    const queue = new WatchRefreshQueue(
      async (paths) => {
        active++;
        peak = Math.max(peak, active);
        batches.push([...paths]);
        if (batches.length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        active--;
      },
      () => {},
      100,
    );

    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(100);
    queue.enqueue('src/b.ts');
    queue.enqueue('src/c.ts');
    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await queue.waitForIdle();

    expect(peak).toBe(1);
    expect(batches).toEqual([['src/a.ts'], ['src/b.ts', 'src/c.ts']]);
  });

  it('retries a failed refresh without dropping its batch', async () => {
    vi.useFakeTimers();
    const errors: string[][] = [];
    const successful: string[][] = [];
    let attempts = 0;
    const queue = new WatchRefreshQueue(
      async (paths) => {
        attempts++;
        if (attempts === 1) throw new Error('failed');
        successful.push([...paths]);
      },
      (_error, paths) => errors.push([...paths]),
      10,
    );

    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toEqual([['src/a.ts']]);
    expect(successful).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    await queue.waitForIdle();

    expect(errors).toEqual([['src/a.ts']]);
    expect(successful).toEqual([['src/a.ts']]);
  });

  it('parks pre-ready events until the initial refresh completes', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const queue = new WatchRefreshQueue(
      async (paths) => batches.push([...paths]),
      () => {},
      50,
      { holdEventsUntilInitialRefresh: true },
    );

    queue.enqueue('src/during-walk.ts');
    await vi.advanceTimersByTimeAsync(80);
    expect(batches).toEqual([]);

    await queue.runInitial();
    expect(batches).toEqual([[]]);
    await vi.advanceTimersByTimeAsync(50);
    await queue.waitForIdle();
    expect(batches).toEqual([[], ['src/during-walk.ts']]);
  });

  it('backs off repeated failures instead of spinning at the debounce interval', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const queue = new WatchRefreshQueue(
      async () => {
        attempts++;
        if (attempts < 4) throw new Error('still unavailable');
      },
      () => {},
      10,
      { retryBaseDelayMs: 100, retryMaxDelayMs: 400 },
    );

    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(10);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(399);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await queue.waitForIdle();
    expect(attempts).toBe(4);
  });

  it('merges an event during retry backoff without shortening the retry delay', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    let attempts = 0;
    const queue = new WatchRefreshQueue(
      async (paths) => {
        attempts++;
        if (attempts === 1) throw new Error('failed');
        batches.push([...paths]);
      },
      () => {},
      10,
      { retryBaseDelayMs: 1_000 },
    );

    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(10);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    queue.enqueue('src/b.ts');
    await vi.advanceTimersByTimeAsync(899);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await queue.waitForIdle();

    expect(attempts).toBe(2);
    expect(batches).toEqual([['src/a.ts', 'src/b.ts']]);
  });

  it('contains a throwing error reporter for a detached refresh', async () => {
    vi.useFakeTimers();
    const queue = new WatchRefreshQueue(
      async () => {
        throw new Error('refresh failed');
      },
      async () => {
        throw new Error('reporting failed');
      },
      10,
    );

    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(10);

    await queue.close();
    await expect(queue.waitForIdle()).resolves.toBeUndefined();
  });

  it('contains a synchronously throwing refresh and retries its batch', async () => {
    vi.useFakeTimers();
    const errors: string[][] = [];
    const successful: string[][] = [];
    let attempts = 0;
    const queue = new WatchRefreshQueue(
      (paths) => {
        attempts++;
        if (attempts === 1) throw new Error('synchronous refresh failure');
        successful.push([...paths]);
        return Promise.resolve();
      },
      (_error, paths) => errors.push([...paths]),
      10,
    );

    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toEqual([['src/a.ts']]);
    await vi.advanceTimersByTimeAsync(250);
    await queue.waitForIdle();

    expect(attempts).toBe(2);
    expect(successful).toEqual([['src/a.ts']]);
  });

  it('closes cleanly when a refresh failure triggers shutdown', async () => {
    vi.useFakeTimers();
    let closePromise: Promise<void> | undefined;
    const queue = new WatchRefreshQueue(
      async () => {
        throw new Error('stop after failure');
      },
      () => {
        closePromise = queue.close();
      },
      10,
    );

    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(10);

    expect(closePromise).toBeDefined();
    await expect(closePromise).resolves.toBeUndefined();
  });

  it('flushes by max wait even when writes never become quiet', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const queue = new WatchRefreshQueue(
      async (paths) => batches.push([...paths]),
      () => {},
      100,
      { maxWaitMs: 250 },
    );

    queue.enqueue('src/0.ts');
    await vi.advanceTimersByTimeAsync(90);
    queue.enqueue('src/1.ts');
    await vi.advanceTimersByTimeAsync(90);
    queue.enqueue('src/2.ts');
    await vi.advanceTimersByTimeAsync(70);
    await queue.waitForIdle();

    expect(batches).toEqual([['src/0.ts', 'src/1.ts', 'src/2.ts']]);
  });

  it('bounds high-cardinality paths while retaining priority control files', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const queue = new WatchRefreshQueue(
      async (paths) => batches.push([...paths]),
      () => {},
      10,
      {
        maxPendingPaths: 2,
        isPriorityPath: (filePath) => filePath === '.gitnexusrc',
      },
    );

    for (let index = 0; index < 20; index++) queue.enqueue(`src/${index}.ts`);
    queue.enqueue('.gitnexusrc');
    await vi.advanceTimersByTimeAsync(10);
    await queue.waitForIdle();

    expect(batches).toEqual([[WATCH_FULL_REFRESH_PATH, '.gitnexusrc', 'src/1.ts']]);
  });

  it('bounds a flood of distinct priority paths', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const queue = new WatchRefreshQueue(
      async (paths) => batches.push([...paths]),
      () => {},
      10,
      {
        maxPendingPaths: 2,
        isPriorityPath: (filePath) => filePath.endsWith('/.gitignore'),
      },
    );

    for (let index = 0; index < 20; index++) queue.enqueue(`packages/${index}/.gitignore`);
    await vi.advanceTimersByTimeAsync(10);
    await queue.waitForIdle();

    expect(batches).toEqual([
      [WATCH_FULL_REFRESH_PATH, 'packages/0/.gitignore', 'packages/1/.gitignore'],
    ]);
  });

  it('does not report overflow for a duplicate at capacity', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const queue = new WatchRefreshQueue(
      async (paths) => batches.push([...paths]),
      () => {},
      10,
      { maxPendingPaths: 2 },
    );

    queue.enqueue('src/a.ts');
    queue.enqueue('src/b.ts');
    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(10);
    await queue.waitForIdle();

    expect(batches).toEqual([['src/a.ts', 'src/b.ts']]);
  });

  it('runs a full refresh when the pending-path limit is zero', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const queue = new WatchRefreshQueue(
      async (paths) => batches.push([...paths]),
      () => {},
      10,
      { maxPendingPaths: 0 },
    );

    queue.enqueue('src/a.ts');
    await vi.advanceTimersByTimeAsync(10);
    await queue.waitForIdle();

    expect(batches).toEqual([[WATCH_FULL_REFRESH_PATH]]);
  });
});
