import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';
import {
  CHAT_HISTORY_STORAGE_PREFIX,
  saveChatHistory,
} from '../../src/core/llm/chat-history-store';
import { getActiveProviderConfig } from '../../src/core/llm/settings-service';
import type { CodebaseContext } from '../../src/core/llm/context-builder';
import type { ChatMessage } from '../../src/core/llm/types';

// A stream the test drives: one chunk, then it waits for `release()`. After
// release it yields `cancelled` if aborted, unless `chunkAfterAbort` asks it
// to emit one more chunk first (a frame already in flight at abort time).
const stream = vi.hoisted(() => ({
  release: () => {},
  chunkAfterAbort: false,
}));

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

vi.mock('../../src/core/llm/agent', () => ({
  createGraphRAGAgent: vi.fn(() => ({})),
  streamAgentResponse: vi.fn(async function* (
    _agent: unknown,
    _history: unknown,
    options?: { signal?: AbortSignal },
  ) {
    yield { type: 'content', content: 'answer for a' };
    await new Promise<void>((resolve) => {
      stream.release = resolve;
    });
    if (options?.signal?.aborted && !stream.chunkAfterAbort) {
      yield { type: 'cancelled' };
      return;
    }
    yield { type: 'content', content: ' (late part for a)' };
    await nextFrame();
    yield { type: 'done' };
  }),
}));

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

vi.mock('../../src/core/llm/settings-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/llm/settings-service')>();
  return { ...actual, getActiveProviderConfig: vi.fn(actual.getActiveProviderConfig) };
});

const REPO_A = '/ws/a/app';
const REPO_B = '/ws/b/app';

const turn = (question: string, answer: string, at: number): ChatMessage[] => [
  { id: `u-${at}`, role: 'user', content: question, timestamp: at },
  { id: `a-${at}`, role: 'assistant', content: answer, timestamp: at + 1 },
];

const storedFor = (repo: string) => sessionStorage.getItem(`${CHAT_HISTORY_STORAGE_PREFIX}${repo}`);

const renderAppState = () => renderHook(() => useAppState(), { wrapper: AppStateProvider });

describe('chat history persistence (#432)', () => {
  beforeEach(() => sessionStorage.clear());

  it('restores the saved conversation for the repo after a reload', () => {
    saveChatHistory(REPO_A, turn('where is auth?', 'in auth.ts', 1));

    // A fresh provider stands in for the page after a reload.
    const { result } = renderAppState();
    expect(result.current.chatMessages).toEqual([]);

    act(() => result.current.restoreChatHistory(REPO_A));

    expect(result.current.chatMessages.map((m) => m.content)).toEqual([
      'where is auth?',
      'in auth.ts',
    ]);
  });

  it('switches between same-named repos without mixing their histories', () => {
    const historyA = turn('question for a', 'answer for a', 1);
    const historyB = turn('question for b', 'answer for b', 10);
    saveChatHistory(REPO_A, historyA);
    saveChatHistory(REPO_B, historyB);
    const savedA = storedFor(REPO_A);

    const { result } = renderAppState();
    act(() => result.current.restoreChatHistory(REPO_A));
    act(() => result.current.restoreChatHistory(REPO_B));

    expect(result.current.chatMessages).toEqual(historyB);
    // Moving to B must not write A's messages under B's key, or B's under A's.
    expect(storedFor(REPO_A)).toBe(savedA);
    expect(JSON.parse(storedFor(REPO_B) ?? '[]')).toEqual(historyB);
  });

  it('shows an empty chat for a repo with nothing saved', () => {
    saveChatHistory(REPO_A, turn('q', 'a', 1));

    const { result } = renderAppState();
    act(() => result.current.restoreChatHistory(REPO_A));
    act(() => result.current.restoreChatHistory(REPO_B));

    expect(result.current.chatMessages).toEqual([]);
    expect(storedFor(REPO_B)).toBeNull();
  });

  it('clearChat removes the stored copy for the current repo only', () => {
    saveChatHistory(REPO_A, turn('q a', 'a a', 1));
    saveChatHistory(REPO_B, turn('q b', 'a b', 10));

    const { result } = renderAppState();
    act(() => result.current.restoreChatHistory(REPO_B));
    act(() => result.current.clearChat());

    expect(result.current.chatMessages).toEqual([]);
    expect(storedFor(REPO_B)).toBeNull();
    expect(storedFor(REPO_A)).not.toBeNull();
  });
});

describe('switching repos while a reply streams (#432 review)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    stream.chunkAfterAbort = false;
    vi.mocked(getActiveProviderConfig).mockReturnValue({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
    });
  });

  // Start a reply in repo A, wait until it shows, then switch to repo B.
  const switchMidReply = async () => {
    const historyB = turn('question for b', 'answer for b', 10);
    saveChatHistory(REPO_B, historyB);
    const savedB = storedFor(REPO_B);

    const hook = renderAppState();
    act(() => hook.result.current.restoreChatHistory(REPO_A));
    await act(async () => {
      await hook.result.current.initializeAgent('app', { repo: REPO_A });
    });

    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = hook.result.current.sendChatMessage('question for a');
    });
    await waitFor(() =>
      expect(hook.result.current.chatMessages.map((m) => m.content)).toContain('answer for a'),
    );

    act(() => hook.result.current.restoreChatHistory(REPO_B));
    await act(async () => {
      stream.release();
      await sending;
      await nextFrame();
    });

    return { ...hook, historyB, savedB };
  };

  it('stops the reply so it never lands in or is saved as the new repo’s history', async () => {
    const { result, historyB, savedB } = await switchMidReply();

    expect(result.current.chatMessages).toEqual(historyB);
    expect(storedFor(REPO_B)).toBe(savedB);
    expect(result.current.isChatLoading).toBe(false);
  });

  it('ignores a frame of the old reply that arrives after the abort', async () => {
    stream.chunkAfterAbort = true;

    const { result, historyB, savedB } = await switchMidReply();

    expect(result.current.chatMessages).toEqual(historyB);
    expect(storedFor(REPO_B)).toBe(savedB);
  });

  it('lets a new message go out right after the switch', async () => {
    const { result } = await switchMidReply();

    expect(result.current.isChatLoading).toBe(false);
    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = result.current.sendChatMessage('follow-up for b');
    });
    await waitFor(() =>
      expect(result.current.chatMessages.map((m) => m.content)).toContain('follow-up for b'),
    );
    await act(async () => {
      stream.release();
      await sending;
    });
  });
});
