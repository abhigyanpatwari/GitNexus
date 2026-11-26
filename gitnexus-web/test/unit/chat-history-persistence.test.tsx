import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';
import {
  CHAT_HISTORY_STORAGE_PREFIX,
  saveChatHistory,
} from '../../src/core/llm/chat-history-store';
import type { ChatMessage } from '../../src/core/llm/types';

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
