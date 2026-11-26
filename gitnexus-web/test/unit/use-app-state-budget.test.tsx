import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodebaseContext } from '../../src/core/llm/context-builder';
import { clearSettings, loadSettings, saveSettings } from '../../src/core/llm/settings-service';
import { AppStateProvider, useAppState } from '../../src/hooks/useAppState';

const mockStream = vi.fn();

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

vi.mock('../../src/core/llm/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/llm/agent')>();
  return {
    ...actual,
    createGraphRAGAgent: vi.fn(() => ({ stream: mockStream })),
  };
});

describe('useAppState token budget visibility', () => {
  beforeEach(() => {
    clearSettings();
    mockStream.mockReset();
    const base = loadSettings();
    saveSettings({
      ...base,
      activeProvider: 'openai',
      openai: { apiKey: 'test-key', model: 'gpt-4o' },
      agent: { maxIterations: 8, tokenBudget: 50 },
    });
  });

  afterEach(() => {
    clearSettings();
  });

  it('surfaces a visible notice in the assistant message when a nonzero budget runs without provider usage metadata', async () => {
    mockStream.mockImplementation(async () => {
      return (async function* () {
        yield [
          'messages',
          [
            {
              _getType: () => 'ai',
              id: 'ai-no-usage',
              content: 'Answer without token usage',
              tool_calls: [],
            },
            {},
          ],
        ];
        yield [
          'values',
          {
            messages: [
              { _getType: () => 'human', content: 'explain architecture' },
              {
                _getType: () => 'ai',
                id: 'ai-no-usage',
                content: 'Answer without token usage',
                tool_calls: [],
              },
            ],
          },
        ];
      })();
    });

    const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });

    act(() => {
      result.current.refreshLLMSettings();
    });

    await act(async () => {
      await result.current.sendChatMessage('explain architecture');
    });

    const assistantMessages = result.current.chatMessages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].content).toBe(
      'Answer without token usage\n\n\n\n> ℹ️ Token budget (50 tokens) could not be enforced because the provider did not report token usage for this response.',
    );
    expect(assistantMessages[0].tokenUsage).toBeUndefined();
    expect(assistantMessages[0].estimatedCostUsd).toBeUndefined();
    expect(result.current.agentError).toBeNull();
  });

  it('flushes deferred usage and cost when user stops mid-stream before animation frame runs', async () => {
    const originalRaf = window.requestAnimationFrame;
    const originalCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = vi.fn(() => 42);
    window.cancelAnimationFrame = vi.fn();

    try {
      saveSettings({
        ...loadSettings(),
        agent: { maxIterations: 8, tokenBudget: 0 },
      });
      const { result } = renderHook(() => useAppState(), { wrapper: AppStateProvider });

      act(() => {
        result.current.refreshLLMSettings();
      });

      mockStream.mockImplementation(async () => {
        return (async function* () {
          yield [
            'messages',
            [
              {
                _getType: () => 'ai',
                id: 'ai-aborted',
                content: 'Partial answer',
                tool_calls: [],
                usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
              },
              {},
            ],
          ];
          act(() => {
            result.current.stopChatResponse();
          });
          throw new DOMException('Aborted', 'AbortError');
        })();
      });

      await act(async () => {
        await result.current.sendChatMessage('interrupt test');
      });

      const assistantMessages = result.current.chatMessages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toBe('Partial answer');
      expect(assistantMessages[0].tokenUsage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      });
      expect(assistantMessages[0].estimatedCostUsd).toBeCloseTo(0.00045, 6);
    } finally {
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCancelRaf;
    }
  });
});
