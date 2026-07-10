import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from '../../src/components/Header';
import {
  deleteRepo,
  fetchRepos,
  startAnalyze,
  streamAnalyzeProgress,
} from '../../src/services/backend-client';
import type { BackendRepo } from '../../src/services/backend-client';

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
    fetchRepos: vi.fn(),
    startAnalyze: vi.fn(),
    streamAnalyzeProgress: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'header:repositories') return 'Repositories';
      if (key === 'header:active') return 'Active';
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
});
