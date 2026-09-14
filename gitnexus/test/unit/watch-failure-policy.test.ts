import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyzeFailureMayHaveMutatedLiveIndex = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/run-analyze.js', () => ({
  analyzeFailureMayHaveMutatedLiveIndex,
  runFullAnalysis: vi.fn(),
}));

import { shouldStopAfterWatchRefreshFailure } from '../../src/cli/analyze-watch.js';
import { IndexLockTimeoutError } from '../../src/storage/index-lock.js';

describe('watch refresh failure policy', () => {
  beforeEach(() => analyzeFailureMayHaveMutatedLiveIndex.mockReset());

  it('retries a queued pre-write failure even when incremental writes are in-place', () => {
    const error = new Error('failed before live graph mutation');
    analyzeFailureMayHaveMutatedLiveIndex.mockReturnValue(false);

    expect(shouldStopAfterWatchRefreshFailure(error, ['src/a.ts'])).toBe(false);
  });

  it('stops only when a queued failure may have mutated the live graph', () => {
    const error = new Error('failed during live graph mutation');
    analyzeFailureMayHaveMutatedLiveIndex.mockReturnValue(true);

    expect(shouldStopAfterWatchRefreshFailure(error, ['src/a.ts'])).toBe(true);
    expect(shouldStopAfterWatchRefreshFailure(error, [])).toBe(false);
  });

  it('stops on an orphan-guard timeout even when the live index was not mutated', () => {
    analyzeFailureMayHaveMutatedLiveIndex.mockReturnValue(false);
    const error = new IndexLockTimeoutError(
      {
        v: 1,
        pid: -1,
        hostname: 'h',
        startTime: null,
        token: '',
        invocationId: '<unreadable>',
        acquiredAt: '',
      },
      30_000,
      false,
      '/tmp/analyze.lock.guard',
    );

    expect(shouldStopAfterWatchRefreshFailure(error, ['src/a.ts'])).toBe(true);
    expect(shouldStopAfterWatchRefreshFailure(error, [])).toBe(true);
  });

  it('retries a live-holder lock timeout', () => {
    analyzeFailureMayHaveMutatedLiveIndex.mockReturnValue(false);
    const error = new IndexLockTimeoutError(
      {
        v: 1,
        pid: 42,
        hostname: 'h',
        startTime: null,
        token: 't',
        invocationId: 'i',
        acquiredAt: '',
      },
      5_000,
      true,
    );

    expect(shouldStopAfterWatchRefreshFailure(error, ['src/a.ts'])).toBe(false);
  });
});
