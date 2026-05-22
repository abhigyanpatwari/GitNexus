import { describe, expect, it } from 'vitest';
import {
  buildLangChainMessages,
  createChatModel,
  serializeAgentHistoryMessages,
  type AgentMessage,
} from '../../src/core/llm/agent';
import {
  buildDeepSeekRequestMessages,
  DeepSeekChatOpenAI,
  DeepSeekChatOpenAICompletions,
} from '../../src/core/llm/deepseek-chat-model';

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

it('drops reasoning_content from assistant messages without tool calls', () => {
  const messages = buildLangChainMessages([
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      content: 'Hi there',
      reasoningContent: 'I should greet the user.',
    },
  ]);

  const requestMessages = buildDeepSeekRequestMessages(messages);

  expect(requestMessages).toEqual([
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
  ]);
});

it('drops reasoningContent from serialized assistant messages without tool calls', () => {
  const serialized = serializeAgentHistoryMessages(
    [
      {
        _getType: () => 'ai',
        content: 'Simple answer.',
        additional_kwargs: { reasoning_content: 'Thinking about it.' },
      },
    ],
    0,
  );

  expect(serialized).toEqual([
    {
      role: 'assistant',
      content: 'Simple answer.',
    },
  ]);
});

describe('createChatModel', () => {
  it('keeps DeepSeek model subclasses on withConfig clones used for tool binding', () => {
    const model = createChatModel({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      temperature: 0.1,
    } as any) as any;

    expect(model).toBeInstanceOf(DeepSeekChatOpenAI);
    expect(model.completions).toBeInstanceOf(DeepSeekChatOpenAICompletions);

    const clonedModel = model.withConfig({ tools: [] }) as any;

    expect(clonedModel).toBeInstanceOf(DeepSeekChatOpenAI);
    expect(clonedModel.completions).toBeInstanceOf(DeepSeekChatOpenAICompletions);
  });

  it('uses DeepSeek serialization on withConfig clones', async () => {
    const model = createChatModel({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      temperature: 0.1,
    } as any) as any;
    const clonedModel = model.withConfig({ tools: [] }) as any;
    clonedModel.completions.streaming = false;
    let capturedRequest: any;

    clonedModel.completions.client = {
      chat: {
        completions: {
          create: async (request: any) => {
            capturedRequest = request;
            return {
              choices: [
                {
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
            };
          },
        },
      },
    };

    await clonedModel.completions._generate(
      buildLangChainMessages([
        { role: 'user', content: 'Check the weather' },
        {
          role: 'assistant',
          content: '',
          reasoningContent: 'Need the weather tool.',
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
      ]),
      { stream: false },
    );

    expect(capturedRequest.messages[1].reasoning_content).toBe('Need the weather tool.');
    expect(capturedRequest.messages[1].tool_calls[0].function.arguments).toBe(
      '{"location":"Hangzhou"}',
    );
    expect(capturedRequest.messages[2].tool_call_id).toBe('call_weather');
  });

  it('preserves reasoning_content through the streaming path used by DeepSeek tool calls', async () => {
    const model = createChatModel({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      temperature: 0.1,
    } as any) as any;
    model.completions.streaming = true;

    async function* mockStream() {
      yield {
        id: 'chatcmpl-1',
        model: 'deepseek-v4-flash',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              reasoning_content: 'Need the weather tool.',
            },
          },
        ],
      };
      yield {
        id: 'chatcmpl-1',
        model: 'deepseek-v4-flash',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"Hangzhou"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
    }

    model.completions.client = {
      chat: {
        completions: {
          create: async () => mockStream(),
        },
      },
    };

    let streamedMessage: any;
    for await (const chunk of model.completions._streamResponseChunks(
      buildLangChainMessages([{ role: 'user', content: 'Check the weather' }]),
      {},
    )) {
      streamedMessage = streamedMessage ? streamedMessage.concat(chunk.message) : chunk.message;
    }

    expect(streamedMessage.additional_kwargs.reasoning_content).toBe('Need the weather tool.');
    expect(streamedMessage.tool_calls).toEqual([
      {
        id: 'call_weather',
        name: 'get_weather',
        args: { location: 'Hangzhou' },
        type: 'tool_call',
      },
    ]);

    expect(serializeAgentHistoryMessages([streamedMessage], 0)).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'Need the weather tool.',
        toolCalls: [
          {
            id: 'call_weather',
            name: 'get_weather',
            args: { location: 'Hangzhou' },
            type: 'tool_call',
          },
        ],
      },
    ]);
  });

  it('rejects overlapping DeepSeek requests before reusing active messages', async () => {
    const model = createChatModel({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      temperature: 0.1,
    } as any) as any;

    model.completions.activeMessages = buildLangChainMessages([{ role: 'user', content: 'busy' }]);

    await expect(
      model.completions._generate(
        buildLangChainMessages([{ role: 'user', content: 'Check the weather' }]),
        { stream: false },
      ),
    ).rejects.toThrow('DeepSeekChatOpenAICompletions does not support overlapping requests');
  });
});
