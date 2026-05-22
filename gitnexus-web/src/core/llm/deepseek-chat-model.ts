import {
  ChatOpenAI,
  ChatOpenAICompletions,
  type ChatOpenAICallOptions,
  type ChatOpenAICompletionsCallOptions,
  type ChatOpenAIFields,
} from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import type { AgentToolCall } from './types';

/**
 * DeepSeek's thinking-mode chat API requires assistant `reasoning_content`
 * from prior turns to be replayed verbatim on the next request. LangChain
 * preserves the inbound value on `AIMessage.additional_kwargs`, but its
 * OpenAI-compatible outbound converter currently drops that provider-specific
 * field. This completions subclass keeps the behavior scoped to DeepSeek by
 * replacing only the serialized request messages immediately before the
 * DeepSeek API call.
 */
export class DeepSeekChatOpenAICompletions<
  CallOptions extends ChatOpenAICompletionsCallOptions = ChatOpenAICompletionsCallOptions,
> extends ChatOpenAICompletions<CallOptions> {
  private activeMessages: BaseMessage[] | null = null;

  private setActiveMessages(messages: BaseMessage[]): void {
    if (this.activeMessages !== null) {
      throw new Error('DeepSeekChatOpenAICompletions does not support overlapping requests');
    }
    this.activeMessages = messages;
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.setActiveMessages(messages);
    try {
      return await super._generate(messages, options, runManager);
    } finally {
      this.activeMessages = null;
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.setActiveMessages(messages);
    try {
      yield* super._streamResponseChunks(messages, options, runManager);
    } finally {
      this.activeMessages = null;
    }
  }

  override async completionWithRetry(request: any, requestOptions?: any): Promise<any> {
    const messages = this.activeMessages
      ? buildDeepSeekRequestMessages(this.activeMessages)
      : request.messages;
    return super.completionWithRetry({ ...request, messages }, requestOptions);
  }
}

/**
 * OpenAI-compatible DeepSeek chat model with a DeepSeek-specific completions
 * serializer. Keeping this as a subclass avoids provider checks in the shared
 * agent streaming path and ensures LangChain `withConfig()` clones used by tool
 * binding retain the same request serialization behavior.
 */
export class DeepSeekChatOpenAI<
  CallOptions extends ChatOpenAICallOptions = ChatOpenAICallOptions,
> extends ChatOpenAI<CallOptions> {
  private readonly deepSeekFields: ChatOpenAIFields;

  constructor(fields: ChatOpenAIFields) {
    const deepSeekFields = {
      ...fields,
      completions: new DeepSeekChatOpenAICompletions(fields),
    } as ChatOpenAIFields;
    super(deepSeekFields);
    this.deepSeekFields = deepSeekFields;
  }

  override withConfig(
    config: Partial<CallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CallOptions> {
    // Mirror ChatOpenAI.withConfig() for this LangChain version, but keep the
    // DeepSeek subclass. Calling super.withConfig() would drop our custom
    // completions serializer by returning a plain ChatOpenAI instance.
    const newModel = new DeepSeekChatOpenAI<CallOptions>(this.deepSeekFields);
    newModel.defaultOptions = {
      ...this.defaultOptions,
      ...config,
    } as typeof this.defaultOptions;
    return newModel;
  }
}

export const normalizeMessageContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block?.type === 'text' || typeof block === 'string')
      .map((block: any) => (typeof block === 'string' ? block : block.text || ''))
      .join('');
  }
  if (content == null) return '';
  return String(content);
};

const normalizeToolCallArgs = (toolCall: any): Record<string, unknown> => {
  if (toolCall?.args && typeof toolCall.args === 'object') {
    return toolCall.args as Record<string, unknown>;
  }
  try {
    return toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
  } catch {
    return {};
  }
};

export const normalizeToolCalls = (toolCalls: unknown): AgentToolCall[] | undefined => {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  return toolCalls.map((toolCall: any) => ({
    id: typeof toolCall?.id === 'string' ? toolCall.id : undefined,
    name: toolCall?.name || toolCall?.function?.name || 'unknown',
    args: normalizeToolCallArgs(toolCall),
    type: typeof toolCall?.type === 'string' ? toolCall.type : 'tool_call',
  }));
};

const stringifyToolArguments = (args: unknown): string => {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return '{}';
  }
};

const normalizeOpenAIContent = (content: unknown): string | Array<Record<string, unknown>> => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return normalizeMessageContent(content);

  const blocks = content.flatMap((block: any) => {
    if (typeof block === 'string') {
      return [{ type: 'text', text: block }];
    }
    if (block?.type === 'text' && typeof block.text === 'string') {
      return [{ type: 'text', text: block.text }];
    }
    return [];
  });

  if (blocks.length === 0) return '';
  if (blocks.length === 1) return blocks[0].text as string;
  return blocks;
};

const getOpenAIRole = (message: any): string => {
  const messageType =
    message?._getType?.() || message?.type || message?.constructor?.name || 'unknown';
  if ((message.additional_kwargs || {}).__openai_role__ === 'developer') {
    return 'developer';
  }
  switch (messageType) {
    case 'human':
    case 'HumanMessage':
      return 'user';
    case 'ai':
    case 'AIMessage':
      return 'assistant';
    case 'system':
    case 'SystemMessage':
      return 'system';
    case 'tool':
    case 'ToolMessage':
      return 'tool';
    case 'function':
    case 'FunctionMessage':
      return 'function';
    default:
      return typeof message.role === 'string' ? message.role : 'user';
  }
};

export const buildDeepSeekRequestMessages = (
  messages: Array<BaseMessage | Record<string, unknown>>,
): Array<Record<string, unknown>> =>
  messages.map((message: any) => {
    const role = getOpenAIRole(message);
    const additionalKwargs =
      message.additional_kwargs && typeof message.additional_kwargs === 'object'
        ? message.additional_kwargs
        : {};
    const requestMessage: Record<string, unknown> = {
      role,
      content: normalizeOpenAIContent(message.content),
    };

    if (typeof message.name === 'string' && message.name.length > 0) {
      requestMessage.name = message.name;
    }
    if (role === 'assistant') {
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : Array.isArray(additionalKwargs.tool_calls)
          ? additionalKwargs.tool_calls
          : undefined;
      if (toolCalls?.length) {
        requestMessage.tool_calls = toolCalls.map((toolCall: any) => {
          if (toolCall?.function) {
            return {
              id: toolCall.id,
              type: toolCall.type ?? 'function',
              function: {
                name: toolCall.function.name,
                arguments: stringifyToolArguments(toolCall.function.arguments),
              },
            };
          }
          return {
            id: toolCall?.id,
            type: 'function',
            function: {
              name: toolCall?.name ?? 'unknown',
              arguments: stringifyToolArguments(toolCall?.args),
            },
          };
        });
      }
      if (additionalKwargs.function_call != null) {
        requestMessage.function_call = additionalKwargs.function_call;
      }
      if (toolCalls?.length && typeof additionalKwargs.reasoning_content === 'string') {
        requestMessage.reasoning_content = additionalKwargs.reasoning_content;
      }
      return requestMessage;
    }

    if (role === 'tool' && typeof message.tool_call_id === 'string') {
      requestMessage.tool_call_id = message.tool_call_id;
    }

    if (role === 'function' && typeof message.name === 'string') {
      requestMessage.name = message.name;
    }

    return requestMessage;
  });
