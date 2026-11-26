import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';
import {
  CHAT_HISTORY_STORAGE_PREFIX,
  chatHistoryKey,
  saveChatHistory,
} from '../../src/core/llm/chat-history-store';
import { getActiveProviderConfig } from '../../src/core/llm/settings-service';
import type { CodebaseContext } from '../../src/core/llm/context-builder';
import type { ChatMessage } from '../../src/core/llm/types';
import type { KnowledgeGraph } from '../../src/core/graph/types';

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
    // Cites a file, so a chunk that slips past the abort would also reach
    // the Code References panel of whatever repo is showing.
    yield { type: 'content', content: ' (late part for a, see [[src/late.ts:1-2]])' };
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

const SERVER = 'http://localhost:4747';
const OTHER_SERVER = 'https://gitnexus.example.com';
const REPO_A = '/ws/a/app';
const REPO_B = '/ws/b/app';

// The one file the late chunk cites, so its citation resolves to a reference.
const graphWithLateFile = {
  nodes: [
    {
      id: 'File:src/late.ts',
      label: 'File',
      properties: { name: 'late.ts', filePath: 'src/late.ts' },
    },
  ],
  relationships: [],
} as unknown as KnowledgeGraph;

const turn = (question: string, answer: string, at: number): ChatMessage[] => [
  { id: `u-${at}`, role: 'user', content: question, timestamp: at },
  { id: `a-${at}`, role: 'assistant', content: answer, timestamp: at + 1 },
];

const storedFor = (repo: string, server = SERVER) =>
  sessionStorage.getItem(`${CHAT_HISTORY_STORAGE_PREFIX}${chatHistoryKey(server, repo)}`);
const save = (repo: string, messages: ChatMessage[], server = SERVER) =>
  saveChatHistory(chatHistoryKey(server, repo), messages);

const renderAppState = () => renderHook(() => useAppState(), { wrapper: AppStateProvider });

describe('chat history persistence (#432)', () => {
  beforeEach(() => sessionStorage.clear());

  it('restores the saved conversation for the repo after a reload', () => {
    save(REPO_A, turn('where is auth?', 'in auth.ts', 1));

    // A fresh provider stands in for the page after a reload.
    const { result } = renderAppState();
    expect(result.current.chatMessages).toEqual([]);

    act(() => result.current.restoreChatHistory(SERVER, REPO_A));

    expect(result.current.chatMessages.map((m) => m.content)).toEqual([
      'where is auth?',
      'in auth.ts',
    ]);
  });

  it('switches between same-named repos without mixing their histories', () => {
    const historyA = turn('question for a', 'answer for a', 1);
    const historyB = turn('question for b', 'answer for b', 10);
    save(REPO_A, historyA);
    save(REPO_B, historyB);
    const savedA = storedFor(REPO_A);

    const { result } = renderAppState();
    act(() => result.current.restoreChatHistory(SERVER, REPO_A));
    act(() => result.current.restoreChatHistory(SERVER, REPO_B));

    expect(result.current.chatMessages).toEqual(historyB);
    // Moving to B must not write A's messages under B's key, or B's under A's.
    expect(storedFor(REPO_A)).toBe(savedA);
    expect(JSON.parse(storedFor(REPO_B) ?? '[]')).toEqual(historyB);
  });

  it('keeps the same repo path on two servers apart', () => {
    const fromServer = turn('question on server 1', 'excerpt from server 1', 1);
    save(REPO_A, fromServer);

    const { result } = renderAppState();
    act(() => result.current.restoreChatHistory(OTHER_SERVER, REPO_A));

    // Server 1's excerpts must not show up in, or be replayed to, server 2.
    expect(result.current.chatMessages).toEqual([]);
    expect(storedFor(REPO_A, OTHER_SERVER)).toBeNull();

    act(() => result.current.restoreChatHistory(SERVER, REPO_A));
    expect(result.current.chatMessages).toEqual(fromServer);
  });

  it('shows an empty chat for a repo with nothing saved', () => {
    save(REPO_A, turn('q', 'a', 1));

    const { result } = renderAppState();
    act(() => result.current.restoreChatHistory(SERVER, REPO_A));
    act(() => result.current.restoreChatHistory(SERVER, REPO_B));

    expect(result.current.chatMessages).toEqual([]);
    expect(storedFor(REPO_B)).toBeNull();
  });

  it('clearChat removes the stored copy for the current repo only', () => {
    save(REPO_A, turn('q a', 'a a', 1));
    save(REPO_B, turn('q b', 'a b', 10));

    const { result } = renderAppState();
    act(() => result.current.restoreChatHistory(SERVER, REPO_B));
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
    save(REPO_B, historyB);
    const savedB = storedFor(REPO_B);

    const hook = renderAppState();
    act(() => hook.result.current.setGraph(graphWithLateFile));
    act(() => hook.result.current.restoreChatHistory(SERVER, REPO_A));
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

    act(() => hook.result.current.restoreChatHistory(SERVER, REPO_B));
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

  it('ignores a chunk of the old reply that arrives after the abort', async () => {
    stream.chunkAfterAbort = true;

    const { result, historyB, savedB } = await switchMidReply();

    expect(result.current.chatMessages).toEqual(historyB);
    expect(storedFor(REPO_B)).toBe(savedB);
    // Its citation must not open the old repo's file in the new repo's panel.
    expect(result.current.codeReferences).toEqual([]);
    expect(result.current.isCodePanelOpen).toBe(false);
  });

  it('adds the late chunk’s citation when the reply is not aborted', async () => {
    // Control for the test above: the same chunk does reach the panel.
    const { result } = renderAppState();
    act(() => result.current.setGraph(graphWithLateFile));
    act(() => result.current.restoreChatHistory(SERVER, REPO_A));
    await act(async () => {
      await result.current.initializeAgent('app', { repo: REPO_A });
    });

    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = result.current.sendChatMessage('question for a');
    });
    await waitFor(() =>
      expect(result.current.chatMessages.map((m) => m.content)).toContain('answer for a'),
    );
    await act(async () => {
      stream.release();
      await sending;
    });

    expect(result.current.codeReferences.map((r) => r.filePath)).toEqual(['src/late.ts']);
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
