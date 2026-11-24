import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// V8 flags are process-wide: record the lease's flag writes instead of
// applying them to the test process.
// The main isolate's live heap limit is stubbed too, so each case can state
// the limit its flags give.
const setFlags = vi.hoisted(() => vi.fn<(flags: string) => void>());
const mainHeap = vi.hoisted(() => ({ limitMb: 3048 }));
vi.mock('node:v8', async () => {
  const actual = await vi.importActual<typeof import('node:v8')>('node:v8');
  const mocked = {
    ...actual,
    setFlagsFromString: setFlags,
    getHeapStatistics: () => ({
      ...actual.getHeapStatistics(),
      heap_size_limit: mainHeap.limitMb * 1024 * 1024,
    }),
  };
  return { ...mocked, default: mocked };
});

import {
  inheritedHeap,
  percentageOldSpaceMb,
  spawnWithOwnHeapLimit,
  workerHeapCapEnforceable,
} from '../../src/core/ingestion/workers/worker-heap-limit.js';

const MIB = 1024 * 1024;
const fakeWorker = (): Worker => new EventEmitter() as unknown as Worker;

describe('inheritedHeap', () => {
  const heap = (execArgv: string[], nodeOptions: string, limitMb: number) =>
    inheritedHeap(execArgv, nodeOptions, limitMb * MIB, 49_152 * MIB, 0);

  it.each([
    [
      'an execArgv size',
      ['--max-old-space-size=3000'],
      '',
      3048,
      ['--max-old-space-size=3000'],
      { maxOldGenerationSizeMb: 3000, maxYoungGenerationSizeMb: 48 },
    ],
    [
      'execArgv over NODE_OPTIONS',
      ['--max-old-space-size=3000'],
      '--max-old-space-size=2000',
      3096,
      ['--max-old-space-size=3000'],
      { maxOldGenerationSizeMb: 3000, maxYoungGenerationSizeMb: 96 },
    ],
    [
      'old and semi-space flags',
      ['--max-old-space-size=3000', '--max-semi-space-size=128'],
      '',
      3384,
      ['--max-old-space-size=3000', '--max-semi-space-size=128'],
      { maxOldGenerationSizeMb: 3000, maxYoungGenerationSizeMb: 384 },
    ],
    [
      'a semi-space flag V8 rounds up to a power of two',
      [],
      '--max-old-space-size=3000 --max-semi-space-size=10',
      3048,
      ['--max-old-space-size=3000', '--max-semi-space-size=10'],
      { maxOldGenerationSizeMb: 3000, maxYoungGenerationSizeMb: 48 },
    ],
    [
      'a semi-space flag alone, over the default old space',
      ['--max-semi-space-size=64'],
      '',
      4288,
      ['--max-semi-space-size=64'],
      { maxOldGenerationSizeMb: 4096, maxYoungGenerationSizeMb: 192 },
    ],
    [
      '--max-heap-size with a smaller old space, whose young generation fills the rest',
      ['--max-heap-size=3000', '--max-old-space-size=1000'],
      '',
      4072,
      ['--max-old-space-size=1000', '--max-heap-size=3000'],
      { maxOldGenerationSizeMb: 1000, maxYoungGenerationSizeMb: 3072 },
    ],
    [
      '--max-heap-size with a larger old space',
      ['--max-heap-size=3000', '--max-old-space-size=5000'],
      '',
      5001.5,
      ['--max-old-space-size=5000', '--max-heap-size=3000'],
      { maxOldGenerationSizeMb: 5000, maxYoungGenerationSizeMb: 1.5 },
    ],
    [
      '--max-heap-size and a semi-space flag',
      ['--max-heap-size=3000', '--max-semi-space-size=64'],
      '',
      3000,
      ['--max-semi-space-size=64', '--max-heap-size=3000'],
      { maxOldGenerationSizeMb: 2808, maxYoungGenerationSizeMb: 192 },
    ],
    [
      '--max-heap-size alone, as the whole limit in old space',
      ['--max-heap-size=3072'],
      '',
      3072,
      ['--max-heap-size=3072'],
      { maxOldGenerationSizeMb: 3072 },
    ],
    ['no flag', [], '', 4144, [], undefined],
    // V8 ignores a value out of its bounds, so it is no flag at all.
    [
      'an out-of-bounds size V8 ignored',
      ['--max-old-space-size=100000000000000000000'],
      '',
      4144,
      [],
      undefined,
    ],
    [
      'an out-of-bounds --max-heap-size beside a size the limit confirms',
      ['--max-old-space-size=3000', '--max-heap-size=100000000000000000000'],
      '',
      3048,
      ['--max-old-space-size=3000'],
      { maxOldGenerationSizeMb: 3000, maxYoungGenerationSizeMb: 48 },
    ],
    [
      'an explicit zero over NODE_OPTIONS',
      ['--max-old-space-size=0'],
      '--max-old-space-size=800',
      4144,
      [],
      undefined,
    ],
  ])('reads %s', (_label, execArgv, nodeOptions, limitMb, flags, limits) => {
    expect(heap(execArgv, nodeOptions, limitMb)).toEqual({ flags, limits, consistent: true });
  });

  it.each([
    [
      'a size V8 accepts but JavaScript cannot hold exactly',
      ['--max-old-space-size=9007199254740993'],
      '',
      4144,
    ],
    ['a size that leaves no young generation', ['--max-old-space-size=4144'], '', 4144],
    ['a size the live limit contradicts', [], '--max-old-space-size=2000', 3048],
    [
      'a semi-space flag the live limit contradicts',
      ['--max-old-space-size=3000', '--max-semi-space-size=64'],
      '',
      3048,
    ],
    ['a --max-heap-size the live limit contradicts', ['--max-heap-size=3072'], '', 4144],
    [
      'an inexact --max-heap-size beside a size the limit confirms',
      ['--max-old-space-size=3000', '--max-heap-size=9007199254740993'],
      '',
      3048,
    ],
  ])('is not consistent with %s', (_label, execArgv, nodeOptions, limitMb) => {
    expect(heap(execArgv, nodeOptions, limitMb)).toEqual({
      flags: [],
      limits: undefined,
      consistent: false,
    });
  });

  it("restores the old space Node's percentage formula gives, checked against the live limit", () => {
    // 25% of the cgroup limit whenever Node reports one, even above physical RAM.
    const percentage = (limitMb: number, totalMb: number, constrainedMb: number) =>
      inheritedHeap(
        ['--max-old-space-size=3000'],
        '--max-old-space-size-percentage=25',
        limitMb * MIB,
        totalMb * MIB,
        constrainedMb * MIB,
      );
    expect(percentage(12_336, 49_152, 0).flags).toEqual(['--max-old-space-size=12288']);
    expect(percentage(2096, 49_152, 8192).flags).toEqual(['--max-old-space-size=2048']);
    expect(percentage(15_408, 34_304, 61_440)).toEqual({
      flags: ['--max-old-space-size=15360'],
      limits: { maxOldGenerationSizeMb: 15_360, maxYoungGenerationSizeMb: 48 },
      consistent: true,
    });
    // A limit the formula does not explain leaves the flags unread.
    expect(percentage(12_400, 49_152, 0).consistent).toBe(false);
  });
});

describe('spawnWithOwnHeapLimit', () => {
  let execArgv: string[];
  let nodeOptions: string | undefined;

  beforeEach(() => {
    setFlags.mockClear();
    execArgv = process.execArgv;
    nodeOptions = process.env.NODE_OPTIONS;
    process.execArgv = ['--max-old-space-size=3000'];
    delete process.env.NODE_OPTIONS;
    mainHeap.limitMb = 3048;
  });

  afterEach(() => {
    process.execArgv = execArgv;
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = nodeOptions;
  });

  it('clears the flag once for concurrent spawns and restores it after the last is online', () => {
    const workers = [fakeWorker(), fakeWorker(), fakeWorker()];
    for (const worker of workers) expect(spawnWithOwnHeapLimit(() => worker)).toBe(worker);
    expect(setFlags.mock.calls).toEqual([['--max-old-space-size=0']]);

    workers[0].emit('online');
    workers[1].emit('online');
    expect(setFlags).toHaveBeenCalledTimes(1);
    workers[2].emit('online');
    expect(setFlags.mock.calls).toEqual([
      ['--max-old-space-size=0'],
      ['--max-old-space-size=3000'],
    ]);

    // Later events from the same workers never release the lease twice.
    workers[0].emit('message', { type: 'ready' });
    workers[2].emit('exit', 0);
    expect(setFlags).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['its first message', (worker: Worker) => worker.emit('message', { type: 'ready' })],
    ['exit', (worker: Worker) => worker.emit('exit', 1)],
  ])('releases the lease on %s', (_label, settle) => {
    const worker = spawnWithOwnHeapLimit(fakeWorker);
    settle(worker);
    expect(setFlags.mock.calls).toEqual([
      ['--max-old-space-size=0'],
      ['--max-old-space-size=3000'],
    ]);
  });

  it('keeps the second worker leased when the first reports a message during online', () => {
    const first = spawnWithOwnHeapLimit(fakeWorker);
    const second = spawnWithOwnHeapLimit(fakeWorker);
    // EventEmitter already captured the online listeners when this emits message.
    first.prependOnceListener('online', () => first.emit('message', { type: 'ready' }));
    first.emit('online');
    expect(setFlags.mock.calls).toEqual([['--max-old-space-size=0']]);
    second.emit('online');
    expect(setFlags).toHaveBeenLastCalledWith('--max-old-space-size=3000');
  });

  it('releases the lease when the spawn throws', () => {
    expect(() =>
      spawnWithOwnHeapLimit(() => {
        throw new Error('spawn failed');
      }),
    ).toThrow('spawn failed');
    expect(setFlags.mock.calls).toEqual([
      ['--max-old-space-size=0'],
      ['--max-old-space-size=3000'],
    ]);

    // The released lease opens again for the next spawn.
    const worker = spawnWithOwnHeapLimit(fakeWorker);
    worker.emit('online');
    expect(setFlags).toHaveBeenCalledTimes(4);
  });

  it('leaves no error listener, so an unhandled worker error still surfaces', () => {
    const worker = spawnWithOwnHeapLimit(fakeWorker);
    expect(worker.listenerCount('error')).toBe(0);
    worker.emit('online');
    expect(worker.listenerCount('online')).toBe(0);
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('exit')).toBe(0);
  });

  it('clears and restores the semi-space flag with the old-space flag', () => {
    process.execArgv = ['--max-old-space-size=3000'];
    process.env.NODE_OPTIONS = '--max-semi-space-size=128';
    mainHeap.limitMb = 3000 + 3 * 128;
    const worker = spawnWithOwnHeapLimit(fakeWorker);
    expect(setFlags.mock.calls).toEqual([['--max-old-space-size=0'], ['--max-semi-space-size=0']]);
    worker.emit('online');
    expect(setFlags.mock.calls.slice(2)).toEqual([
      ['--max-old-space-size=3000'],
      ['--max-semi-space-size=128'],
    ]);
  });

  it('clears a semi-space flag set without an old-space flag', () => {
    process.execArgv = ['--max-semi-space-size=64'];
    spawnWithOwnHeapLimit(fakeWorker).emit('exit', 0);
    expect(setFlags.mock.calls).toEqual([
      ['--max-semi-space-size=0'],
      ['--max-semi-space-size=64'],
    ]);
  });

  it('does not touch V8 flags when the process set no heap flag', () => {
    process.execArgv = [];
    const worker = spawnWithOwnHeapLimit(fakeWorker);
    worker.emit('online');
    expect(setFlags).not.toHaveBeenCalled();
    expect(worker.listenerCount('online')).toBe(0);
  });

  it.each([
    [
      'a quoted NODE_OPTIONS value',
      [],
      '--max-old-space-size="3000"',
      3048,
      ['--max-old-space-size=0'],
      ['--max-old-space-size=3000'],
    ],
    [
      '--max-heap-size',
      ['--max-heap-size=3072'],
      '',
      3072,
      ['--max-heap-size=0'],
      ['--max-heap-size=3072'],
    ],
    [
      '--max-heap-size with a smaller old space',
      ['--max-heap-size=3000', '--max-old-space-size=1000'],
      '',
      4072,
      ['--max-old-space-size=0', '--max-heap-size=0'],
      ['--max-old-space-size=1000', '--max-heap-size=3000'],
    ],
  ])('clears and restores %s', (_label, argv, options, limitMb, cleared, restored) => {
    process.execArgv = argv;
    process.env.NODE_OPTIONS = options;
    mainHeap.limitMb = limitMb;
    const worker = spawnWithOwnHeapLimit(fakeWorker);
    expect(setFlags.mock.calls.map(([flags]) => flags)).toEqual(cleared);
    worker.emit('online');
    expect(setFlags.mock.calls.map(([flags]) => flags)).toEqual([...cleared, ...restored]);
  });

  it('does not restore a NODE_OPTIONS heap that an explicit command-line zero overrides', () => {
    process.execArgv = ['--max-old-space-size=0'];
    process.env.NODE_OPTIONS = '--max-old-space-size=800';
    spawnWithOwnHeapLimit(fakeWorker).emit('online');
    expect(setFlags).not.toHaveBeenCalled();
  });

  it('releases each worker once, whichever of online, message and exit comes first', () => {
    const [first, second] = [fakeWorker(), fakeWorker()];
    spawnWithOwnHeapLimit(() => first);
    spawnWithOwnHeapLimit(() => second);
    // All three settle events from one worker count once: the other worker is
    // still starting, so the flags stay cleared.
    first.emit('online');
    first.emit('message', { type: 'ready' });
    first.emit('exit', 0);
    expect(setFlags.mock.calls).toEqual([['--max-old-space-size=0']]);
    second.emit('online');
    expect(setFlags.mock.calls).toEqual([
      ['--max-old-space-size=0'],
      ['--max-old-space-size=3000'],
    ]);
  });

  it('skips the lease when V8 flags are frozen, since any flag write would abort', () => {
    process.execArgv = ['--freeze-flags-after-init', '--max-old-space-size=3000'];
    const worker = spawnWithOwnHeapLimit(fakeWorker);
    worker.emit('online');
    expect(setFlags).not.toHaveBeenCalled();
    expect(worker.listenerCount('online')).toBe(0);
  });

  it('skips the lease when the flags it reads do not explain the main heap', () => {
    // NODE_OPTIONS says 2000, but the main isolate runs with 3000 + 48.
    process.execArgv = [];
    process.env.NODE_OPTIONS = '--max-old-space-size=2000';
    const worker = spawnWithOwnHeapLimit(fakeWorker);
    worker.emit('online');
    expect(setFlags).not.toHaveBeenCalled();
    expect(worker.listenerCount('online')).toBe(0);
  });
});

describe('workerHeapCapEnforceable', () => {
  it.each([
    ['no flags', [], '', 4144, true],
    [
      'frozen flags with no heap flag, which leave nothing to clear',
      ['--freeze-flags-after-init'],
      '',
      4144,
      true,
    ],
    [
      'frozen flags with a heap flag',
      ['--freeze-flags-after-init', '--max-old-space-size=3000'],
      '',
      3048,
      false,
    ],
    [
      'frozen flags with a NODE_OPTIONS heap flag',
      ['--freeze-flags-after-init'],
      '--max-old-space-size=3000',
      3048,
      false,
    ],
    [
      'frozen, then unfrozen',
      ['--freeze-flags-after-init', '--no-freeze-flags-after-init', '--max-old-space-size=3000'],
      '',
      3048,
      true,
    ],
    ['a heap flag the live limit confirms', ['--max-old-space-size=3000'], '', 3048, true],
    ['a heap flag the live limit contradicts', ['--max-old-space-size=3000'], '', 4144, false],
  ])('is %s -> %s', (_label, argv, nodeOptions, limitMb, expected) => {
    expect(workerHeapCapEnforceable(argv, nodeOptions, limitMb * MIB)).toBe(expected);
  });
});

describe('spawnWithInheritedHeap', () => {
  let execArgv: string[];
  let nodeOptions: string | undefined;

  // Whether a worker already started under the cleared flags is process state,
  // so each case loads a fresh module.
  const freshModule = async () => {
    vi.resetModules();
    return import('../../src/core/ingestion/workers/worker-heap-limit.js');
  };

  beforeEach(() => {
    setFlags.mockClear();
    execArgv = process.execArgv;
    nodeOptions = process.env.NODE_OPTIONS;
    process.execArgv = ['--max-old-space-size=3000', '--max-semi-space-size=64'];
    delete process.env.NODE_OPTIONS;
    mainHeap.limitMb = 3000 + 3 * 64;
  });

  afterEach(() => {
    process.execArgv = execArgv;
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = nodeOptions;
  });

  it('spawns plainly under the inherited flags when no worker has used the cleared ones', async () => {
    const { spawnWithInheritedHeap } = await freshModule();
    const limits: unknown[] = [];
    const worker = spawnWithInheritedHeap((resourceLimits) => {
      limits.push(resourceLimits);
      return fakeWorker();
    });
    worker.emit('online');
    expect(limits).toEqual([undefined]);
    expect(setFlags).not.toHaveBeenCalled();
  });

  it('takes the lease with the inherited limits once a parser worker has used it', async () => {
    const { spawnWithInheritedHeap, spawnWithOwnHeapLimit } = await freshModule();
    spawnWithOwnHeapLimit(fakeWorker).emit('online');
    setFlags.mockClear();

    const writesAtSpawn: string[][] = [];
    const limits: unknown[] = [];
    const worker = spawnWithInheritedHeap((resourceLimits) => {
      limits.push(resourceLimits);
      writesAtSpawn.push(setFlags.mock.calls.map(([flags]) => flags));
      return fakeWorker();
    });
    worker.emit('online');

    const cleared = ['--max-old-space-size=0', '--max-semi-space-size=0'];
    expect(limits).toEqual([{ maxOldGenerationSizeMb: 3000, maxYoungGenerationSizeMb: 192 }]);
    expect(writesAtSpawn).toEqual([cleared]);
    expect(setFlags.mock.calls.map(([flags]) => flags)).toEqual([
      ...cleared,
      '--max-old-space-size=3000',
      '--max-semi-space-size=64',
    ]);
  });

  it('spawns plainly without heap flags, even after a parser worker started', async () => {
    process.execArgv = [];
    const { spawnWithInheritedHeap, spawnWithOwnHeapLimit } = await freshModule();
    spawnWithOwnHeapLimit(fakeWorker).emit('online');
    const limits: unknown[] = [];
    spawnWithInheritedHeap((resourceLimits) => {
      limits.push(resourceLimits);
      return fakeWorker();
    }).emit('online');
    expect(limits).toEqual([undefined]);
    expect(setFlags).not.toHaveBeenCalled();
  });
});

describe('percentageOldSpaceMb', () => {
  it('applies the percentage to physical RAM, or to the cgroup limit', () => {
    const total = 32_768 * MIB;
    expect(percentageOldSpaceMb(['--max-old-space-size-percentage=25'], '', total, 0)).toBe(8192);
    expect(percentageOldSpaceMb([], '--max-old-space-size-percentage=12.5', total, 0)).toBe(4096);
    expect(
      percentageOldSpaceMb(['--max-old-space-size-percentage=50'], '', total, 8192 * MIB),
    ).toBe(4096);
    expect(percentageOldSpaceMb(['--max-old-space-size=3000'], '', total, 0)).toBeUndefined();
    // Node takes a cgroup limit even above physical RAM, but not UINT64_MAX.
    expect(
      percentageOldSpaceMb(['--max-old-space-size-percentage=25'], '', total, 61_440 * MIB),
    ).toBe(15_360);
    expect(percentageOldSpaceMb(['--max-old-space-size-percentage=25'], '', total, 2 ** 64)).toBe(
      8192,
    );
    // Whole MB first, as Node does: 60% of 1.9 MiB is 60% of 1 MB, so 0.
    expect(percentageOldSpaceMb(['--max-old-space-size-percentage=60'], '', 1.9 * MIB, 0)).toBe(0);
    // Read by argument: the name inside an --eval source is not the flag.
    expect(
      percentageOldSpaceMb(['--eval', 'f("--max-old-space-size-percentage=50")'], '', total, 0),
    ).toBeUndefined();
  });
});
