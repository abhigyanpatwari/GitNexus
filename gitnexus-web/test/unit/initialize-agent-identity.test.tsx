import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';
import { getActiveProviderConfig } from '../../src/core/llm/settings-service';
import type { CodebaseContext } from '../../src/core/llm/context-builder';

// initializeAgent's heavy dynamic imports are stubbed — these tests only lock
// the identity-write rule, not agent behavior.
vi.mock('../../src/core/llm/context-builder', () => ({
  buildCodebaseContext: vi.fn(
    async (): Promise<CodebaseContext> => ({
      stats: {
        projectName: 'stub',
        fileCount: 0,
        functionCount: 0,
        classCount: 0,
        interfaceCount: 0,
        methodCount: 0,
      },
      hotspots: [],
      folderTree: '',
    }),
  ),
}));

vi.mock('../../src/core/llm/agent', () => ({
  createGraphRAGAgent: vi.fn(() => ({})),
}));

vi.mock('../../src/core/llm/settings-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/llm/settings-service')>();
  return { ...actual, getActiveProviderConfig: vi.fn(actual.getActiveProviderConfig) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const withProvider = () => {
  vi.mocked(getActiveProviderConfig).mockReturnValue({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'test-key',
  });
};

describe('initializeAgent repo-identity writes (#2419)', () => {
  it('does not clobber the path identity when called with only a display name', async () => {
    withProvider();
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });

    act(() => {
      result.current.setCurrentRepo('/ws/b/reels');
    });

    await act(async () => {
      await result.current.initializeAgent('reels');
    });

    // The pre-PR idiom initializeAgent(projectName) must no longer overwrite
    // the path identity with an ambiguous display name.
    expect(result.current.currentRepo).toBe('/ws/b/reels');
  });

  it('writes the identity when opts.repo is provided', async () => {
    withProvider();
    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });

    act(() => {
      result.current.setCurrentRepo('/ws/a/reels');
    });

    await act(async () => {
      await result.current.initializeAgent('reels', { repo: '/ws/b/reels' });
    });

    expect(result.current.currentRepo).toBe('/ws/b/reels');
  });
});
