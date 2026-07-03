import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Header } from '../../src/components/Header';
import type { BackendRepo } from '../../src/services/backend-client';

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => ({
    projectName: 'reels',
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
});
