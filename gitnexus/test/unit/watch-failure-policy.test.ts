import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyzeFailureMayHaveMutatedLiveIndex = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/run-analyze.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/run-analyze.js')>();
  return {
    ...actual,
    analyzeFailureMayHaveMutatedLiveIndex,
    runFullAnalysis: vi.fn(),
  };
});

import {
  formatFatalWatchRefreshFailure,
  shouldStopAfterWatchRefreshFailure,
} from '../../src/cli/watch.js';
import { StreamedIncrementalWritebackError } from '../../src/core/run-analyze.js';

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

  it('stops a queued streamed incremental violation even though the index is unchanged', () => {
    const error = new StreamedIncrementalWritebackError(['structural']);
    analyzeFailureMayHaveMutatedLiveIndex.mockReturnValue(false);

    expect(shouldStopAfterWatchRefreshFailure(error, ['src/a.ts'])).toBe(true);
    expect(shouldStopAfterWatchRefreshFailure(error, [])).toBe(false);
  });

  it('renders an unchanged-index reason only for the streamed invariant', () => {
    const streamedError = new StreamedIncrementalWritebackError(['PDG']);
    analyzeFailureMayHaveMutatedLiveIndex.mockReturnValue(false);

    const streamedMessage = formatFatalWatchRefreshFailure(streamedError, ['src/a.ts']);
    expect(streamedMessage).toContain('live index was not changed');
    expect(streamedMessage).not.toContain('may have been updated in place');

    const mutationError = new Error('failed during live graph mutation');
    analyzeFailureMayHaveMutatedLiveIndex.mockReturnValue(true);
    expect(formatFatalWatchRefreshFailure(mutationError, ['src/a.ts'])).toContain(
      'may have been updated in place',
    );
  });
});
