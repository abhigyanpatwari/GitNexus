import { fireEvent, render, screen } from '@testing-library/react';
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
});
