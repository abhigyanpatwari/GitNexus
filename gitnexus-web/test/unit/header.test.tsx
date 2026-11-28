import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from '../../src/components/Header';
import {
  BackendError,
  deleteRepo,
  fetchActiveAnalyzeJobs,
  fetchRepos,
  getAnalyzeStatus,
  startAnalyze,
  streamAnalyzeProgress,
} from '../../src/services/backend-client';
import type { ActiveAnalyzeJob, BackendRepo } from '../../src/services/backend-client';
import { ACTIVE_ANALYZE_POLL_MS } from '../../src/hooks/useActiveAnalyzeJobs';

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => ({
    projectName: 'reels',
    currentRepo: '/workspace/group-b/reels',
    graph: null,
    graphMode: 'full',
    openChatPanel: vi.fn(),
    isRightPanelOpen: false,
    rightPanelTab: 'chat',
    setSettingsPanelOpen: vi.fn(),
    setHelpDialogBoxOpen: vi.fn(),
  }),
}));

vi.mock('../../src/components/EmbeddingStatus', () => ({
  EmbeddingStatus: () => <div data-testid="embedding-status" />,
}));

vi.mock('../../src/components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));

vi.mock('../../src/components/RepoAnalyzer', () => ({
  RepoAnalyzer: () => <div data-testid="repo-analyzer" />,
}));

vi.mock('../../src/services/backend-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/backend-client')>();
  return {
    ...actual,
    deleteRepo: vi.fn(),
    fetchActiveAnalyzeJobs: vi.fn(),
    fetchRepos: vi.fn(),
    getAnalyzeStatus: vi.fn(),
    startAnalyze: vi.fn(),
    streamAnalyzeProgress: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'header:repositories') return 'Repositories';
      if (key === 'header:active') return 'Active';
      if (key === 'header:analyzingPercent') return `Analyzing ${options?.percent}%`;
      if (key === 'header:stopping') return 'Stopping…';
      if (key === 'header:ready') return 'Ready';
      if (key === 'errors:analyzeBusy')
        return `${options?.repoName} is still being analyzed (${options?.percent}%)`;
      if (key === 'errors:analyzeStopping')
        return `The analysis worker for ${options?.repoName} is stopping`;
      if (key === 'header:reanalyzeRepo') return `Re-analyze ${options?.repoName ?? ''}`;
      if (key === 'header:reanalyzingRepo')
        return `Re-analyzing ${options?.repoName ?? ''}: ${options?.message ?? ''}`;
      if (key === 'header:deleteRepo') return `Delete ${options?.repoName ?? ''}`;
      if (key === 'header:analyzeNew') return 'Analyze new';
      if (key === 'header:searchRepositories') return 'Search repositories...';
      if (key === 'header:noRepositoriesFound')
        return `No repositories found for ${options?.query}`;
      return key;
    },
  }),
}));

function makeRepo(index: number): BackendRepo {
  return {
    name: index === 0 ? 'reels' : `repo-${index}`,
    path: `/tmp/repo-${index}`,
    stats: {
      files: 1,
      nodes: 1,
      edges: 0,
      communities: 0,
      processes: 0,
    },
  };
}

describe('Header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchActiveAnalyzeJobs).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Reset the URL mutated by the delete handler's hygiene pass.
    window.history.replaceState(null, '', '/');
  });

  it('keeps a large repository menu scrollable inside the viewport', () => {
    render(<Header availableRepos={Array.from({ length: 30 }, (_, index) => makeRepo(index))} />);

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));

    const menu = screen.getByText('Repositories').closest('.absolute');
    expect(menu).not.toBeNull();
    expect(menu).toHaveClass('max-h-[calc(100vh-4.5rem)]');
    expect(menu).toHaveClass('overflow-hidden');

    const scrollableRepoList = screen.getByText('repo-29').closest('.scrollbar-thin');
    expect(scrollableRepoList).not.toBeNull();
    expect(scrollableRepoList).toHaveClass('overflow-y-auto');
    expect(scrollableRepoList).toHaveClass('flex-1');
  });

  it('filters repositories locally by displayed name', async () => {
    const user = userEvent.setup();
    render(
      <Header
        availableRepos={[
          { ...makeRepo(0), name: 'reels', path: '/workspace/apps/reels' },
          { ...makeRepo(1), name: 'gitnexus-web', path: '/workspace/GitNexus/gitnexus-web' },
          { ...makeRepo(2), name: 'api-server', path: '/workspace/gitnexus/api' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));

    const input = screen.getByRole('textbox', { name: 'Search repositories...' });
    await user.type(input, 'gitnexus');

    expect(screen.getByText('gitnexus-web')).toBeInTheDocument();
    expect(screen.queryByText('api-server')).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'api');

    expect(screen.getByText('api-server')).toBeInTheDocument();
    expect(screen.queryByText('gitnexus-web')).not.toBeInTheDocument();
  });

  it('shows an empty state when no repositories match the local search', async () => {
    const user = userEvent.setup();
    render(<Header availableRepos={Array.from({ length: 3 }, (_, index) => makeRepo(index))} />);

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));

    await user.type(screen.getByRole('textbox', { name: 'Search repositories...' }), 'missing');

    expect(screen.getByText('No repositories found for missing')).toBeInTheDocument();
    expect(screen.queryByText('repo-1')).not.toBeInTheDocument();
  });

  it('does not leave stale rows when duplicate repository names are filtered', async () => {
    const user = userEvent.setup();
    render(
      <Header
        availableRepos={[
          { ...makeRepo(0), name: 'search_sync', path: '/workspace/group-a/search_sync' },
          { ...makeRepo(1), name: 'tab_server', path: '/workspace/group-a/tab_server' },
          { ...makeRepo(2), name: 'feed_sync', path: '/workspace/group-a/feed_sync' },
          { ...makeRepo(3), name: 'search_sync', path: '/workspace/group-b/search_sync' },
          { ...makeRepo(4), name: 'tab_server', path: '/workspace/group-b/tab_server' },
          { ...makeRepo(5), name: 'reels', path: '/workspace/group-b/reels' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));

    await user.type(screen.getByRole('textbox', { name: 'Search repositories...' }), 'tab');

    const repoList = screen.getAllByText('tab_server')[0].closest('.scrollbar-thin');
    expect(repoList).not.toBeNull();
    expect(repoList).toHaveTextContent('tab_server');
    expect(repoList).not.toHaveTextContent('search_sync');
    expect(repoList).not.toHaveTextContent('feed_sync');
    expect(repoList).not.toHaveTextContent('reels');
  });

  it('uses repository path identity when duplicate display names are present', async () => {
    const onSwitchRepo = vi.fn();
    render(
      <Header
        onSwitchRepo={onSwitchRepo}
        availableRepos={[
          { ...makeRepo(0), name: 'reels', path: '/workspace/group-a/reels' },
          { ...makeRepo(1), name: 'reels', path: '/workspace/group-b/reels' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));

    expect(screen.getAllByText('Active')).toHaveLength(1);
    await userEvent.click(screen.getAllByText('reels')[1]);

    expect(onSwitchRepo).toHaveBeenCalledWith('/workspace/group-a/reels');
  });

  it('deletes and falls back using repository path identity', async () => {
    const onSwitchRepo = vi.fn();
    const updatedRepos = [{ ...makeRepo(2), name: 'reels', path: '/workspace/group-a/reels' }];
    vi.mocked(fetchRepos).mockResolvedValue(updatedRepos);

    render(
      <Header
        onSwitchRepo={onSwitchRepo}
        availableRepos={[
          { ...makeRepo(0), name: 'reels', path: '/workspace/group-a/reels' },
          { ...makeRepo(1), name: 'reels', path: '/workspace/group-b/reels' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));
    await userEvent.click(screen.getAllByTitle('Delete reels')[1]);

    expect(deleteRepo).toHaveBeenCalledWith('/workspace/group-b/reels');
    expect(onSwitchRepo).toHaveBeenCalledWith('/workspace/group-a/reels');
  });

  it('strips repo, project and skipGraph from the URL before reloading after the last repo is deleted', async () => {
    window.history.replaceState(
      null,
      '',
      '/?repo=%2Fworkspace%2Fgroup-b%2Freels&project=reels&skipGraph=1',
    );
    // jsdom's location.reload is own+non-configurable — replace the whole
    // `location` accessor with a stub that delegates URL reads to the real
    // Location (kept live by history.replaceState) and mocks reload.
    const realLocation = window.location;
    const reloadMock = vi.fn();
    vi.stubGlobal('location', {
      get href() {
        return realLocation.href;
      },
      get search() {
        return realLocation.search;
      },
      reload: reloadMock,
    });
    vi.mocked(fetchRepos).mockResolvedValue([]);

    render(
      <Header
        availableRepos={[{ ...makeRepo(0), name: 'reels', path: '/workspace/group-b/reels' }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));
    await userEvent.click(screen.getByTitle('Delete reels'));

    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(window.location.search).not.toContain('repo=');
    expect(window.location.search).not.toContain('project=');
    expect(window.location.search).not.toContain('skipGraph');
  });

  it('strips repo and project from the URL before falling back after deleting the active repo', async () => {
    window.history.replaceState(null, '', '/?repo=%2Fworkspace%2Fgroup-b%2Freels&project=reels');
    // Capture the URL at the moment of the fallback switch — the stale
    // identity must already be gone so a failed switch leaves nothing that
    // restores the deleted repo on refresh (#2419).
    const searchAtSwitch: string[] = [];
    const onSwitchRepo = vi.fn(() => {
      searchAtSwitch.push(window.location.search);
    });
    vi.mocked(fetchRepos).mockResolvedValue([
      { ...makeRepo(2), name: 'reels', path: '/workspace/group-a/reels' },
    ]);

    render(
      <Header
        onSwitchRepo={onSwitchRepo}
        availableRepos={[
          { ...makeRepo(0), name: 'reels', path: '/workspace/group-a/reels' },
          { ...makeRepo(1), name: 'reels', path: '/workspace/group-b/reels' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));
    await userEvent.click(screen.getAllByTitle('Delete reels')[1]);

    expect(deleteRepo).toHaveBeenCalledWith('/workspace/group-b/reels');
    expect(onSwitchRepo).toHaveBeenCalledWith('/workspace/group-a/reels');
    expect(searchAtSwitch).toEqual(['']);
  });

  it('shows the display name, not the path identity, in the re-analyze progress label', async () => {
    vi.mocked(startAnalyze).mockResolvedValue({ jobId: 'job-1', status: 'running' });
    vi.mocked(streamAnalyzeProgress).mockReturnValue(new AbortController());

    render(
      <Header
        availableRepos={[
          { ...makeRepo(0), name: 'reels', path: '/ws/a/reels' },
          { ...makeRepo(1), name: 'reels', path: '/ws/b/reels' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));
    // Re-analyze the second duplicate-name row — `reanalyzing` becomes the
    // path identity '/ws/b/reels', but the label must render the name.
    await userEvent.click(screen.getAllByTitle('Re-analyze reels')[1]);

    const label = screen.getByText(/^Re-analyzing /);
    expect(label.textContent).toMatch(/^Re-analyzing reels:/);
    expect(label.textContent).not.toContain('/ws/b/reels');
  });

  it('falls back to the path basename when the re-analyzing identity is no longer listed', async () => {
    vi.mocked(startAnalyze).mockResolvedValue({ jobId: 'job-2', status: 'running' });
    vi.mocked(streamAnalyzeProgress).mockReturnValue(new AbortController());

    const { rerender } = render(
      <Header availableRepos={[{ ...makeRepo(0), name: 'reels', path: '/ws/b/reels' }]} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reels/i }));
    await userEvent.click(screen.getByTitle('Re-analyze reels'));

    // The repo list refreshes while the re-analysis is still in flight and the
    // identity disappears from it — the label degrades to the path basename.
    rerender(<Header availableRepos={[{ ...makeRepo(1), name: 'other', path: '/ws/x/other' }]} />);

    const label = screen.getByText(/^Re-analyzing /);
    expect(label.textContent).toMatch(/^Re-analyzing reels:/);
    expect(label.textContent).not.toContain('/ws/b/reels');
  });

  describe('analyze status (#1584)', () => {
    const runningJob = (overrides: Partial<ActiveAnalyzeJob> = {}): ActiveAnalyzeJob => ({
      id: 'job-running',
      status: 'analyzing',
      repoName: 'repo-1',
      repoId: 'id-1',
      progress: { phase: 'parsing', percent: 42.4, message: 'Parsing' },
      startedAt: 0,
      stopping: false,
      ...overrides,
    });
    const repos = (): BackendRepo[] => [
      { ...makeRepo(0), id: 'id-0' },
      { ...makeRepo(1), id: 'id-1' },
    ];

    afterEach(() => {
      vi.useRealTimers();
    });

    it('badges the repo being analyzed with its progress and blocks new analyses', async () => {
      vi.mocked(fetchActiveAnalyzeJobs).mockResolvedValue([runningJob()]);
      render(<Header availableRepos={repos()} />);

      fireEvent.click(screen.getByRole('button', { name: /reels/i }));

      const badge = await screen.findByTestId('repo-status-analyzing');
      expect(badge).toHaveTextContent('Analyzing 42%');
      expect(badge.closest('[data-testid="repo-switcher-row"]')).toHaveTextContent('repo-1');
      expect(screen.getAllByTestId('repo-status-analyzing')).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Analyze new' })).toBeDisabled();
      for (const button of screen.getAllByTestId('repo-switcher-reanalyze')) {
        expect(button).toBeDisabled();
      }
    });

    it('shows Stopping, not progress, for a job that is ending but still holds the slot', async () => {
      vi.mocked(fetchActiveAnalyzeJobs).mockResolvedValue([
        runningJob({ status: 'analyzing', stopping: true }),
      ]);
      render(<Header availableRepos={repos()} />);

      fireEvent.click(screen.getByRole('button', { name: /reels/i }));

      const badge = await screen.findByTestId('repo-status-analyzing');
      expect(badge).toHaveTextContent('Stopping…');
      expect(badge).not.toHaveTextContent('42%');
      expect(screen.getByRole('button', { name: 'Analyze new' })).toBeDisabled();
    });

    it('shows Ready once the running job completes and refreshes the repo list', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchActiveAnalyzeJobs).mockResolvedValueOnce([runningJob()]).mockResolvedValue([]);
      vi.mocked(getAnalyzeStatus).mockResolvedValue({ ...runningJob(), status: 'complete' });
      vi.mocked(fetchRepos).mockResolvedValue(repos());
      const onReposChanged = vi.fn();
      render(<Header availableRepos={repos()} onReposChanged={onReposChanged} />);

      fireEvent.click(screen.getByRole('button', { name: /reels/i }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByTestId('repo-status-analyzing')).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS));

      expect(getAnalyzeStatus).toHaveBeenCalledWith('job-running');
      expect(screen.queryByTestId('repo-status-analyzing')).not.toBeInTheDocument();
      const ready = screen.getByTestId('repo-status-ready');
      expect(ready.closest('[data-testid="repo-switcher-row"]')).toHaveTextContent('repo-1');
      expect(screen.getByRole('button', { name: 'Analyze new' })).toBeEnabled();
      expect(onReposChanged).toHaveBeenCalledWith(repos());
    });

    it('shows Ready on reopen for a job that finished while the switcher was closed', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchActiveAnalyzeJobs).mockResolvedValueOnce([runningJob()]).mockResolvedValue([]);
      vi.mocked(getAnalyzeStatus).mockResolvedValue({ ...runningJob(), status: 'complete' });
      vi.mocked(fetchRepos).mockResolvedValue(repos());
      render(<Header availableRepos={repos()} />);
      const trigger = screen.getByTestId('repo-switcher-trigger');

      fireEvent.click(trigger);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByTestId('repo-status-analyzing')).toBeInTheDocument();

      fireEvent.click(trigger); // close: polling stops while the job finishes
      await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS * 5));
      expect(fetchActiveAnalyzeJobs).toHaveBeenCalledTimes(1);

      fireEvent.click(trigger);
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(getAnalyzeStatus).toHaveBeenCalledWith('job-running');
      const ready = screen.getByTestId('repo-status-ready');
      expect(ready.closest('[data-testid="repo-switcher-row"]')).toHaveTextContent('repo-1');
    });

    it('shows Ready when a cloning job only gains a repo ID on completion', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchActiveAnalyzeJobs)
        .mockResolvedValueOnce([runningJob({ status: 'cloning', repoId: undefined })])
        .mockResolvedValue([]);
      vi.mocked(getAnalyzeStatus).mockResolvedValue({ ...runningJob(), status: 'complete' });
      vi.mocked(fetchRepos).mockResolvedValue(repos());
      const onReposChanged = vi.fn();
      const { rerender } = render(
        <Header availableRepos={repos().slice(0, 1)} onReposChanged={onReposChanged} />,
      );
      const trigger = screen.getByTestId('repo-switcher-trigger');

      fireEvent.click(trigger);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(fetchActiveAnalyzeJobs).toHaveBeenCalledTimes(1);
      fireEvent.click(trigger);

      fireEvent.click(trigger);
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(getAnalyzeStatus).toHaveBeenCalledWith('job-running');
      expect(onReposChanged).toHaveBeenCalledWith(repos());
      rerender(<Header availableRepos={repos()} onReposChanged={onReposChanged} />);
      const ready = screen.getByTestId('repo-status-ready');
      expect(ready.closest('[data-testid="repo-switcher-row"]')).toHaveTextContent('repo-1');
    });

    it('does not show Ready when the job that left the list failed', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchActiveAnalyzeJobs).mockResolvedValueOnce([runningJob()]).mockResolvedValue([]);
      vi.mocked(getAnalyzeStatus).mockResolvedValue({ ...runningJob(), status: 'failed' });
      render(<Header availableRepos={repos()} />);

      fireEvent.click(screen.getByRole('button', { name: /reels/i }));
      await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS));

      expect(screen.queryByTestId('repo-status-analyzing')).not.toBeInTheDocument();
      expect(screen.queryByTestId('repo-status-ready')).not.toBeInTheDocument();
    });

    it('retries the outcome lookup after a transient failure and still shows Ready', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchActiveAnalyzeJobs).mockResolvedValueOnce([runningJob()]).mockResolvedValue([]);
      vi.mocked(getAnalyzeStatus)
        .mockRejectedValueOnce(new BackendError('Network down', 0, 'network'))
        .mockResolvedValue({ ...runningJob(), status: 'complete' });
      vi.mocked(fetchRepos).mockResolvedValue(repos());
      render(<Header availableRepos={repos()} />);

      fireEvent.click(screen.getByRole('button', { name: /reels/i }));
      await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS));
      expect(screen.queryByTestId('repo-status-ready')).not.toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS));

      expect(getAnalyzeStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('repo-status-ready')).toBeInTheDocument();
    });

    it('does not poll while the tab is hidden', async () => {
      vi.useFakeTimers();
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      try {
        render(<Header availableRepos={repos()} />);

        fireEvent.click(screen.getByRole('button', { name: /reels/i }));
        await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS * 3));

        expect(fetchActiveAnalyzeJobs).not.toHaveBeenCalled();
      } finally {
        hidden.mockRestore();
      }
    });

    it('pauses polling for Retry-After when rate-limited, then recovers', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchActiveAnalyzeJobs)
        .mockRejectedValueOnce(new BackendError('Too many requests', 429, 'rate_limited', 10_000))
        .mockResolvedValue([runningJob()]);
      render(<Header availableRepos={repos()} />);

      fireEvent.click(screen.getByRole('button', { name: /reels/i }));
      await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS * 3));
      expect(fetchActiveAnalyzeJobs).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('repo-status-analyzing')).not.toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS));

      expect(fetchActiveAnalyzeJobs).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('repo-status-analyzing')).toBeInTheDocument();
    });

    it('clears a 409 after a poll finds that the slot is free', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchActiveAnalyzeJobs).mockImplementation(async () => []);
      vi.mocked(startAnalyze).mockRejectedValue(
        new BackendError('Analysis already in progress (job job-running)', 409, 'client'),
      );
      render(<Header availableRepos={repos()} />);

      fireEvent.click(screen.getByRole('button', { name: /reels/i }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByTitle('Re-analyze repo-1'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS));

      expect(getAnalyzeStatus).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('describes a terminal worker holding the slot as stopping', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchActiveAnalyzeJobs)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([runningJob({ status: 'failed', stopping: true })]);
      vi.mocked(startAnalyze).mockRejectedValue(
        new BackendError('Analysis already in progress (job job-running)', 409, 'client'),
      );
      render(<Header availableRepos={repos()} />);

      fireEvent.click(screen.getByRole('button', { name: /reels/i }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByTitle('Re-analyze repo-1'));
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(screen.getByRole('alert')).toHaveTextContent(
        'The analysis worker for repo-1 is stopping',
      );
    });

    it('names the competing job after a 409 and clears the alert when it completes', async () => {
      vi.useFakeTimers();
      const competingJob = runningJob({ repoName: 'other-repo', repoId: 'id-x' });
      vi.mocked(fetchActiveAnalyzeJobs)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([competingJob])
        .mockResolvedValueOnce([competingJob])
        .mockResolvedValue([]);
      vi.mocked(getAnalyzeStatus).mockResolvedValue({ ...competingJob, status: 'complete' });
      vi.mocked(fetchRepos).mockResolvedValue(repos());
      vi.mocked(startAnalyze).mockRejectedValue(
        new BackendError('Analysis already in progress (job job-running)', 409, 'client'),
      );
      render(<Header availableRepos={repos()} />);

      fireEvent.click(screen.getByRole('button', { name: /reels/i }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByTitle('Re-analyze repo-1'));
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(screen.getByRole('alert')).toHaveTextContent(
        'other-repo is still being analyzed (42%)',
      );
      await act(() => vi.advanceTimersByTimeAsync(ACTIVE_ANALYZE_POLL_MS * 2));

      expect(getAnalyzeStatus).toHaveBeenCalledWith(competingJob.id);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
