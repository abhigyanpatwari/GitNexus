/**
 * Reentrancy-guard test for the manual WAL checkpoint driver.
 *
 * `setInterval` fires on a fixed cadence regardless of whether the previous
 * checkpoint has settled. During a large `--pdg` writeback a CHECKPOINT can
 * outlast the period; without a guard each overdue tick would launch ANOTHER
 * concurrent CHECKPOINT on the singleton connection. The guard (`if (inflight)
 * return`) ensures at most one checkpoint is ever in flight.
 *
 * `tryFlushWAL` is mocked so we can hold a checkpoint "in flight" and drive the
 * interval with fake timers — no native engine involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  tryFlushWAL: vi.fn(),
}));

import { startWalCheckpointDriver } from '../../src/core/lbug/wal-checkpoint-driver.js';
import { tryFlushWAL } from '../../src/core/lbug/lbug-adapter.js';

const mockedTryFlush = vi.mocked(tryFlushWAL);

describe('startWalCheckpointDriver — reentrancy guard', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
    delete process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT; // default = enabled
    vi.useFakeTimers();
    mockedTryFlush.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv === undefined) delete process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
    else process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT = originalEnv;
  });

  it('starts only one checkpoint while a prior one is still in flight, then resumes', async () => {
    let resolveFirst!: () => void;
    mockedTryFlush
      // First checkpoint is held open until we resolve it.
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirst = () => resolve(true);
          }),
      )
      // Any later checkpoint completes immediately.
      .mockImplementation(() => Promise.resolve(true));

    const driver = startWalCheckpointDriver({ periodMs: 10 });

    // ~5 ticks fire while the first checkpoint is still pending.
    await vi.advanceTimersByTimeAsync(55);
    expect(mockedTryFlush).toHaveBeenCalledTimes(1);

    // Let the first settle; subsequent ticks may now fire a new checkpoint.
    resolveFirst();
    await vi.advanceTimersByTimeAsync(25);
    expect(mockedTryFlush.mock.calls.length).toBeGreaterThanOrEqual(2);

    await driver.stop();
  });
});
