import { describe, expect, it } from 'vitest';
import {
  buildLangChainMessages,
  buildDeepSeekRequestMessages,
  createChatModel,
  serializeAgentHistoryMessages,
  type AgentMessage,
} from '../../src/core/llm/agent';

describe('buildLangChainMessages', () => {
  it('reconstructs assistant tool-call turns for replay', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'Check the weather' },
      {
        role: 'assistant',
        content: 'Let me check that.',
        reasoningContent: '',
        toolCalls: [
          {
            id: 'call_weather',
            name: 'get_weather',
            args: { location: 'Hangzhou' },
            type: 'tool_call',
          },
        ],
      },
      {
        role: 'tool',
        content: 'Cloudy 7~13°C',
        toolCallId: 'call_weather',
        name: 'get_weather',
      },
    ];

    const langChainMessages = buildLangChainMessages(messages);

    expect(langChainMessages).toHaveLength(3);
    expect((langChainMessages[1] as any).additional_kwargs.reasoning_content).toBe('');
    expect((langChainMessages[1] as any).tool_calls).toEqual([
      {
        id: 'call_weather',
        name: 'get_weather',
        args: { location: 'Hangzhou' },
        type: 'tool_call',
      },
    ]);
    expect((langChainMessages[2] as any).tool_call_id).toBe('call_weather');
  });
});

describe('serializeAgentHistoryMessages', () => {
  it('captures assistant and tool messages from a completed turn', () => {
    const serialized = serializeAgentHistoryMessages(
      [
        { _getType: () => 'human', content: 'old prompt' },
        {
          _getType: () => 'ai',
          content: 'Let me check that.',
          additional_kwargs: { reasoning_content: 'Need weather tool.' },
          tool_calls: [
            {
              id: 'call_weather',
              name: 'get_weather',
              args: { location: 'Hangzhou' },
              type: 'tool_call',
            },
          ],
        },
        {
          _getType: () => 'tool',
          content: 'Cloudy 7~13°C',
          tool_call_id: 'call_weather',
          name: 'get_weather',
        },
        {
          _getType: () => 'ai',
          content: 'Tomorrow will be cloudy.',
          additional_kwargs: { reasoning_content: 'Result received.' },
        },
      ],
      1,
    );

    expect(serialized).toEqual([
      {
        role: 'assistant',
        content: 'Let me check that.',
        reasoningContent: 'Need weather tool.',
        toolCalls: [
          {
            id: 'call_weather',
            name: 'get_weather',
            args: { location: 'Hangzhou' },
            type: 'tool_call',
          },
        ],
      },
      {
        role: 'tool',
        content: 'Cloudy 7~13°C',
        toolCallId: 'call_weather',
        name: 'get_weather',
      },
      {
        role: 'assistant',
        content: 'Tomorrow will be cloudy.',
        reasoningContent: 'Result received.',
      },
    ]);
  });
});

describe('buildDeepSeekRequestMessages', () => {
  it('preserves reasoning_content on assistant tool-call messages', () => {
    const requestMessages = buildDeepSeekRequestMessages(
      buildLangChainMessages([
        { role: 'user', content: '如何支持Gitlab Repo' },
        {
          role: 'assistant',
          content: '',
          reasoningContent: 'I should inspect the repository support flow first.',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search',
              args: { query: 'Gitlab repo support' },
              type: 'tool_call',
            },
          ],
        },
        {
          role: 'tool',
          content: 'No matches',
          toolCallId: 'call_1',
          name: 'search',
        },
      ]),
    );

    expect(requestMessages).toEqual([
      { role: 'user', content: '如何支持Gitlab Repo' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'I should inspect the repository support flow first.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'search',
              arguments: '{"query":"Gitlab repo support"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'No matches',
        name: 'search',
        tool_call_id: 'call_1',
      },
    ]);
  });
});

describe('createChatModel', () => {
  it('keeps DeepSeek reasoning patch on withConfig clones used for tool binding', () => {
    const model = createChatModel({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      temperature: 0.1,
    } as any) as any;

    expect(model.completions.__deepseekReasoningPatched).toBe(true);

    const clonedModel = model.withConfig({ tools: [] });

    expect(clonedModel.completions.__deepseekReasoningPatched).toBe(true);
  });
});
