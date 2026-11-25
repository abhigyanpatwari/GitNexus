import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanel } from '../../src/components/RightPanel';
import type { ChatMessage } from '../../src/core/llm/types';

let mockChatMessages: ChatMessage[] = [];

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => ({
    isRightPanelOpen: true,
    setRightPanelOpen: vi.fn(),
    graph: null,
    graphMode: 'full',
    addCodeReference: vi.fn(),
    resolveFilePath: vi.fn(),
    chatMessages: mockChatMessages,
    isChatLoading: false,
    currentToolCalls: [],
    agentError: null,
    isAgentReady: true,
    isAgentInitializing: false,
    sendChatMessage: vi.fn(),
    stopChatResponse: vi.fn(),
    clearChat: vi.fn(),
  }),
}));

vi.mock('../../src/hooks/useAutoScroll', () => ({
  useAutoScroll: () => ({
    scrollContainerRef: { current: null },
    messagesContainerRef: { current: null },
    isAtBottom: true,
    scrollToBottom: vi.fn(),
  }),
}));

vi.mock('../../src/core/llm/settings-service', () => ({
  isProviderConfigured: () => true,
}));

vi.mock('../../src/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('../../src/components/ProcessesPanel', () => ({
  ProcessesPanel: () => <div />,
}));

vi.mock('../../src/components/ToolCallCard', () => ({
  ToolCallCard: () => <div />,
}));

describe('RightPanel token usage and cost display', () => {
  beforeEach(() => {
    mockChatMessages = [];
  });

  it('renders conversation and per-message token usage with formatted USD cost', () => {
    mockChatMessages = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Explain routing',
        timestamp: 1000,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Routing lives in App.tsx.',
        tokenUsage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
        estimatedCostUsd: 0.0045,
        timestamp: 1001,
      },
    ];

    render(<RightPanel />);

    const conversationBadge = screen.getByTestId('conversation-token-usage');
    expect(conversationBadge.textContent).toContain('$0.0045');

    const messageUsage = screen.getByTestId('message-token-usage');
    expect(messageUsage.textContent).toContain('$0.0045');
  });

  it('renders local cost label when running on a local zero-cost model', () => {
    mockChatMessages = [
      {
        id: 'assistant-local',
        role: 'assistant',
        content: 'Local answer',
        tokenUsage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 },
        estimatedCostUsd: 0,
        timestamp: 1002,
      },
    ];

    render(<RightPanel />);

    const conversationBadge = screen.getByTestId('conversation-token-usage');
    expect(conversationBadge.textContent).toContain('chat:usage.localCost');

    const messageUsage = screen.getByTestId('message-token-usage');
    expect(messageUsage.textContent).toContain('chat:usage.localCost');
  });
});
