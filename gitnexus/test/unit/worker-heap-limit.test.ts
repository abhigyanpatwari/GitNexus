import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// V8 flags are process-wide: record the lease's flag writes instead of
// applying them to the test process.
const setFlags = vi.hoisted(() => vi.fn<(flags: string) => void>());
vi.mock('node:v8', async () => {
  const actual = await vi.importActual<typeof import('node:v8')>('node:v8');
  const mocked = { ...actual, setFlagsFromString: setFlags };
  return { ...mocked, default: mocked };
});

import {
  inheritedOldSpaceMb,
  inheritedSemiSpaceMb,
  inheritedWorkerResourceLimits,
  spawnWithOwnHeapLimit,
} from '../../src/core/ingestion/workers/worker-heap-limit.js';

const MIB = 1024 * 1024;
const fakeWorker = (): Worker => new EventEmitter() as unknown as Worker;

describe('inheritedOldSpaceMb', () => {
  it.each([
    ['an execArgv value', ['--max-old-space-size=3000'], '', 3000],
    ['a NODE_OPTIONS value', [], '--max-old-space-size=2000', 2000],
    [
      'execArgv over NODE_OPTIONS',
      ['--max-old-space-size=3000'],
      '--max-old-space-size=2000',
      3000,
    ],
    [
      'the last repeated value',
      ['--max-old-space-size=1000', '--max-old-space-size=3000'],
      '',
      3000,
    ],
    ['the underscore spelling', ['--max_old_space_size=2500'], '', 2500],
    ['a space-separated value', [], '--max-old-space-size 1800', 1800],
    ['no flag', [], '', 0],
    ['an unrelated semi-space flag', ['--max-semi-space-size=64'], '', 0],
  ])('reads %s', (_label, execArgv, nodeOptions, expected) => {
    expect(inheritedOldSpaceMb(execArgv, nodeOptions, 9999 * MIB)).toBe(expected);
  });

  it('uses the measured main limit under a percentage flag, which beats an explicit size', () => {
    expect(
      inheritedOldSpaceMb(
        ['--max-old-space-size=3000'],
        '--max-old-space-size-percentage=25',
        12336 * MIB,
      ),
    ).toBe(12336);
    expect(inheritedOldSpaceMb(['--max-old-space-size-percentage=25'], '', 12336.7 * MIB)).toBe(
      12336,
    );
  });
});

describe('inheritedSemiSpaceMb', () => {
  it.each([
    ['an execArgv value', ['--max-semi-space-size=128'], '', 128],
    ['a NODE_OPTIONS value', [], '--max-semi-space-size=64', 64],
    ['execArgv over NODE_OPTIONS', ['--max-semi-space-size=128'], '--max-semi-space-size=64', 128],
    ['the underscore spelling', ['--max_semi_space_size=32'], '', 32],
    ['an unrelated old-space flag', ['--max-old-space-size=3000'], '', 0],
  ])('reads %s', (_label, execArgv, nodeOptions, expected) => {
    expect(inheritedSemiSpaceMb(execArgv, nodeOptions)).toBe(expected);
  });
});

describe('inheritedWorkerResourceLimits', () => {
  it.each([
    [
      'both flags',
      ['--max-old-space-size=3000', '--max-semi-space-size=128'],
      '',
      { maxOldGenerationSizeMb: 3000, maxYoungGenerationSizeMb: 384 },
    ],
    ['old space only', [], '--max-old-space-size=2000', { maxOldGenerationSizeMb: 2000 }],
    ['semi-space only', ['--max-semi-space-size=64'], '', { maxYoungGenerationSizeMb: 192 }],
    ['no flag', [], '', undefined],
  ])('reproduces the heap a worker inherits from %s', (_label, execArgv, nodeOptions, expected) => {
    expect(inheritedWorkerResourceLimits(execArgv, nodeOptions)).toEqual(expected);
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
});
