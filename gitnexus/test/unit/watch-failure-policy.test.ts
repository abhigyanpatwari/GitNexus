import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyzeFailureMayHaveMutatedLiveIndex = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/run-analyze.js', () => ({
  analyzeFailureMayHaveMutatedLiveIndex,
  runFullAnalysis: vi.fn(),
}));

import { shouldStopAfterWatchRefreshFailure } from '../../src/cli/analyze-watch.js';

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
});
