/**
 * Stale-request guards in RepoAnalyzer (PR #1850 review 4470339833).
 *
 * An analyze request (folder upload or URL analyze) that is still in flight
 * when the user switches modes, cancels, or unmounts must not drive state
 * when it later settles: no SSE stream, no phase/error flip — and a
 * stale-but-created server job gets a fire-and-forget cancel so the single
 * analyze slot is freed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RepoAnalyzer } from '../../src/components/RepoAnalyzer';
import { i18nReady } from '../../src/i18n';
import {
  cancelAnalyze,
  startAnalyze,
  streamAnalyzeProgress,
  uploadFolder,
} from '../../src/services/backend-client';

vi.mock('../../src/services/backend-client', () => ({
  startAnalyze: vi.fn(),
  cancelAnalyze: vi.fn(),
  streamAnalyzeProgress: vi.fn(),
  uploadFolder: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const JOB = { jobId: 'job-1', status: 'queued' };

/** Gate uploadFolder on a deferred promise and expose the signal it received. */
function mockUploadWith(d: { promise: Promise<typeof JOB> }) {
  let captured: AbortSignal | undefined;
  vi.mocked(uploadFolder).mockImplementation((_files, _manifest, signal) => {
    captured = signal;
    return d.promise;
  });
  return { signal: () => captured };
}

/** Render, switch to Local Folder mode, and fire a folder selection. */
function startUpload() {
  const view = render(<RepoAnalyzer variant="onboarding" onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Local Folder' }));
  fireEvent.change(screen.getByTestId('folder-upload-input'), {
    target: { files: [new File(['x'], 'a.ts')] },
  });
  return view;
}

beforeEach(async () => {
  await i18nReady;
  vi.clearAllMocks();
  vi.mocked(cancelAnalyze).mockResolvedValue(undefined as never);
  vi.mocked(streamAnalyzeProgress).mockImplementation(() => new AbortController());
});

describe('folder upload', () => {
  it('a mode switch mid-upload makes the resolution inert and cancels the job', async () => {
    const d = deferred<typeof JOB>();
    const upload = mockUploadWith(d);

    startUpload();
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub URL' }));

    // The wire abort happened at mode-switch time, not at resolution time.
    expect(upload.signal()?.aborted).toBe(true);

    await act(async () => {
      d.resolve(JOB);
    });

    expect(streamAnalyzeProgress).not.toHaveBeenCalled();
    expect(cancelAnalyze).toHaveBeenCalledWith('job-1');
    // The GitHub form is clean and submittable (phase back to 'input').
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(screen.queryByTestId('upload-progress')).not.toBeInTheDocument();
  });

  it.each([
    ['BackendError shape', new Error('Request aborted')],
    ['raw AbortError shape', new DOMException('The operation was aborted.', 'AbortError')],
  ])('an aborted rejection is silent — %s', async (_label, err) => {
    const d = deferred<typeof JOB>();
    vi.mocked(uploadFolder).mockReturnValue(d.promise);

    startUpload();
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub URL' }));
    await act(async () => {
      d.reject(err);
    });

    expect(screen.queryByText('Request aborted')).not.toBeInTheDocument();
    expect(screen.queryByText('The operation was aborted.')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('a same-tab click does not abort the in-flight upload', async () => {
    const d = deferred<typeof JOB>();
    const upload = mockUploadWith(d);

    startUpload();
    fireEvent.click(screen.getByRole('tab', { name: 'Local Folder' }));

    expect(upload.signal()?.aborted).toBe(false);
    await act(async () => {
      d.resolve(JOB);
    });

    expect(streamAnalyzeProgress).toHaveBeenCalledTimes(1);
    expect(cancelAnalyze).not.toHaveBeenCalled();
  });

  it('an unmount mid-upload makes the resolution inert', async () => {
    const d = deferred<typeof JOB>();
    const upload = mockUploadWith(d);

    const { unmount } = startUpload();
    unmount();

    expect(upload.signal()?.aborted).toBe(true);
    await act(async () => {
      d.resolve(JOB);
    });

    expect(streamAnalyzeProgress).not.toHaveBeenCalled();
  });

  it('the happy path still tracks the job', async () => {
    const d = deferred<typeof JOB>();
    vi.mocked(uploadFolder).mockReturnValue(d.promise);

    startUpload();
    await act(async () => {
      d.resolve(JOB);
    });

    expect(streamAnalyzeProgress).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamAnalyzeProgress).mock.calls[0][0]).toBe('job-1');
    expect(cancelAnalyze).not.toHaveBeenCalled();
  });

  it('a genuine error still surfaces', async () => {
    const d = deferred<typeof JOB>();
    vi.mocked(uploadFolder).mockReturnValue(d.promise);

    startUpload();
    await act(async () => {
      d.reject(new Error('upload exploded'));
    });

    expect(screen.getByText('upload exploded')).toBeInTheDocument();
    expect(streamAnalyzeProgress).not.toHaveBeenCalled();
  });
});

describe('URL analyze', () => {
  function startGithubAnalyze() {
    render(<RepoAnalyzer variant="onboarding" onComplete={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://github.com/owner/repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Analyze Repository/ }));
  }

  it('a mode switch mid-analyze makes the resolution inert without cancelling', async () => {
    const d = deferred<typeof JOB>();
    vi.mocked(startAnalyze).mockReturnValue(d.promise);

    startGithubAnalyze();
    fireEvent.click(screen.getByRole('tab', { name: 'Local Folder' }));
    await act(async () => {
      d.resolve({ jobId: 'job-2', status: 'queued' });
    });

    expect(streamAnalyzeProgress).not.toHaveBeenCalled();
    // No cancel on the URL path: the jobId may be dedup-aliased to a job
    // another session owns, so cancelling could kill a live analysis.
    expect(cancelAnalyze).not.toHaveBeenCalled();
  });

  it('a stale rejection is silent', async () => {
    const d = deferred<typeof JOB>();
    vi.mocked(startAnalyze).mockReturnValue(d.promise);

    startGithubAnalyze();
    fireEvent.click(screen.getByRole('tab', { name: 'Local Folder' }));
    await act(async () => {
      d.reject(new Error('analyze exploded'));
    });

    expect(screen.queryByText('analyze exploded')).not.toBeInTheDocument();
    expect(screen.getByTestId('upload-folder')).toBeEnabled();
  });

  it('the happy path still tracks the job', async () => {
    const d = deferred<typeof JOB>();
    vi.mocked(startAnalyze).mockReturnValue(d.promise);

    startGithubAnalyze();
    await act(async () => {
      d.resolve({ jobId: 'job-3', status: 'queued' });
    });

    expect(streamAnalyzeProgress).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamAnalyzeProgress).mock.calls[0][0]).toBe('job-3');
    expect(cancelAnalyze).not.toHaveBeenCalled();
  });
});
