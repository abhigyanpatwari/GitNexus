/**
 * Analyze completion: display vs identity split (PR #2420 review R2/R7).
 *
 * The SSE complete event may carry `repoPath` (the analyzed path). RepoAnalyzer
 * must pass that IDENTITY to onComplete — so the post-analyze reconnect targets
 * the exact repo even when basenames collide — while the done screen keeps
 * rendering the display NAME and never shows an absolute path. Old servers
 * omit repoPath; the name fallback must be preserved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RepoAnalyzer } from '../../src/components/RepoAnalyzer';
import { i18nReady } from '../../src/i18n';
import {
  cancelAnalyze,
  streamAnalyzeProgress,
  uploadFolder,
} from '../../src/services/backend-client';

vi.mock('../../src/services/backend-client', () => ({
  startAnalyze: vi.fn(),
  cancelAnalyze: vi.fn(),
  streamAnalyzeProgress: vi.fn(),
  uploadFolder: vi.fn(),
}));

const JOB = { jobId: 'job-1', status: 'queued' };

type CompleteData = { repoName?: string; repoPath?: string };

beforeEach(async () => {
  await i18nReady;
  vi.clearAllMocks();
  vi.mocked(cancelAnalyze).mockResolvedValue(undefined as never);
  vi.mocked(uploadFolder).mockResolvedValue(JOB);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Render RepoAnalyzer, drive a folder-upload analyze to the SSE stream, and
 * return the onComplete spy plus the captured SSE complete callback. Uses fake
 * timers because completion holds a ~1200ms timer before firing onComplete.
 */
async function startTrackedJob() {
  let sseComplete: ((data: CompleteData) => void) | undefined;
  vi.mocked(streamAnalyzeProgress).mockImplementation((_jobId, _onProgress, onComplete) => {
    sseComplete = onComplete;
    return new AbortController();
  });

  vi.useFakeTimers();
  const onDone = vi.fn<(repoIdentity: string) => void>();
  render(<RepoAnalyzer variant="onboarding" onComplete={onDone} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Local Folder' }));
  fireEvent.change(screen.getByTestId('folder-upload-input'), {
    target: { files: [new File(['x'], 'a.ts')] },
  });
  // Flush the upload promise so trackJob subscribes to the SSE stream.
  await act(async () => {});
  expect(streamAnalyzeProgress).toHaveBeenCalledTimes(1);

  return { onDone, complete: (data: CompleteData) => sseComplete?.(data) };
}

describe('analyze completion identity', () => {
  it('passes repoPath to onComplete but renders only the display name', async () => {
    const { onDone, complete } = await startTrackedJob();

    act(() => {
      complete({ repoName: 'reels', repoPath: '/ws/b/reels' });
    });

    // Done screen shows the display name, never the absolute path.
    expect(screen.getByText('reels')).toBeInTheDocument();
    expect(screen.queryByText('/ws/b/reels')).toBeNull();

    // onComplete fires after the ~1200ms done-screen dwell, with the identity.
    expect(onDone).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('/ws/b/reels');
  });

  it('falls back to the display name when the server omits repoPath', async () => {
    const { onDone, complete } = await startTrackedJob();

    act(() => {
      complete({ repoName: 'reels' });
    });

    expect(screen.getByText('reels')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('reels');
  });
});
