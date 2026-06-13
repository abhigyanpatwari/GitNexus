/**
 * Graph RAG Agent Factory
 *
 * Creates a LangChain agent configured for code graph analysis.
 * Supports Azure OpenAI and Google Gemini providers.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOllama } from '@langchain/ollama';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createGraphRAGTools, type GraphRAGBackend } from './tools';
import type {
  ProviderConfig,
  OpenAIConfig,
  AzureOpenAIConfig,
  GeminiConfig,
  AnthropicConfig,
  OllamaConfig,
  OpenRouterConfig,
  MiniMaxConfig,
  GLMConfig,
  DeepSeekConfig,
  AgentStreamChunk,
  AgentHistoryMessage,
} from './types';
import {
  type CodebaseContext,
  buildDynamicSystemPrompt,
  CHAT_ONLY_PROMPT_NOTE,
} from './context-builder';
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OPENROUTER_BASE_URL } from '../../config/ui-constants';
import {
  DeepSeekChatOpenAI,
  normalizeMessageContent,
  normalizeToolCalls,
} from './deepseek-chat-model';

/**
 * System prompt for the Graph RAG agent
 *
 * Design principles (based on Aider/Cline research):
 * - Short, punchy directives > long explanations
 * - No template-inducing examples
 * - Let LLM figure out HOW, just tell it WHAT behavior we want
 * - Explicit progress reporting requirement
 * - Anti-laziness directives
 */
/**
 * Base system prompt - exported so it can be used with dynamic context injection
 *
 * Structure (optimized for instruction following):
 * 1. Identity + GROUNDING mandate (most important)
 * 2. Core protocol (how to work)
 * 3. Tools reference
 * 4. Output format & rules
 * 5. [Dynamic context appended at end]
 */
export const BASE_SYSTEM_PROMPT = `You are Nexus, a Code Analysis Agent with access to a Knowledge Graph. Your responses MUST be grounded.

## ⚠️ MANDATORY: GROUNDING
Every factual claim MUST include a citation.
- File refs: [[src/auth.ts:45-60]] (repo-relative path, line range with hyphen)
- Symbol refs: [[Function:validateUser]] or [[Class:AuthService]]
- Do NOT wrap citations in backticks or code blocks — keep them as plain text
- NO citation = NO claim. Say "I didn't find evidence" instead of guessing.

## 🧠 CORE PROTOCOL (Iterative Loop)
You are an investigator, not a one-shot query engine. For each question:
1. **Plan** — Briefly state what you are looking for and why.
2. **Execute** — Run tools to gather evidence.
3. **Analyze & pivot** — Did the output fully answer the question?
   - Yes → proceed to grounding.
   - Revealed new files/functions → loop back and investigate them immediately.
   - Tool failed → fix the input and retry. Never stop after one error.
4. **Trace** — Use cypher, explore, or impact to follow graph connections.
5. **Read** — Use read to verify logic. Do not guess behavior from names alone.
6. **Validate** — Cross-check findings with cypher before final output. README/docs are summaries, not proof.
7. **Ground** — Cite every finding with [[path:START-END]] or [[Type:Name]].

Before EVERY tool call, briefly state what you are doing and why. Keep narration to one line per step.

## BE DIRECT
- No pleasantries. No "Great question!" or "I'd be happy to help."
- Don't repeat advice already given in this conversation.
- Match response length to query complexity.
- Don't pad with generic "let me know if you need more" — users will ask.

## 🛠️ TOOLS (exact names — use these only)
- **\`search\`** — Hybrid keyword + semantic search. Results grouped by process with cluster context. Start here for discovery.
- **\`cypher\`** — Cypher queries against the graph. Use \`{{QUERY_VECTOR}}\` placeholder for vector search.
- **\`grep\`** — Regex search across files. Best for exact strings, TODOs, error codes.
- **\`read\`** — Read file content. Always use after search/grep to see full source.
- **\`explore\`** — Deep dive on a symbol, cluster, or process.
- **\`overview\`** — Codebase map showing all clusters and processes.
- **\`impact\`** — Impact analysis. Shows affected processes, clusters, and risk level.

**Tool strategy:**
- Discovery → \`search\` or \`overview\`
- Structure → \`cypher\`, \`explore\`, or \`impact\`
- Verification → \`read\` (required before concluding)
- Exact patterns → \`grep\`

## 📊 GRAPH SCHEMA
Typed node labels: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process
Single relation table: \`CodeRelation\` with \`type\` property: CONTAINS, DEFINES, IMPORTS, CALLS, EXTENDS, IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS

✅ \`MATCH (f:Function) RETURN f.name LIMIT 10\`
✅ \`MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b:Function) RETURN a.name, b.name\`
❌ \`MATCH ()-[:CALLS]->()\` — WRONG, no such relationship label

Cypher examples:
- Find callers: \`MATCH (caller:Function)-[:CodeRelation {type: 'CALLS'}]->(fn:Function {name: 'validate'}) RETURN caller.name, caller.filePath\`
- File imports: \`MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(g:File) RETURN f.name, g.name\`
- Semantic search: include \`{{QUERY_VECTOR}}\` in cypher and provide a \`query\` parameter

## 📐 GRAPH SEMANTICS
- \`CALLS\`: Method invocation or constructor injection (intentional simplification).
- \`IMPORTS\`: File-level import/include.
- \`EXTENDS/IMPLEMENTS\`: Class inheritance.
- Process labels use format "EntryPoint → Terminal" (heuristic, not app-defined names).

## 🎯 VISUAL GROUNDING (not a tool)
The user sees a knowledge graph alongside this chat. Citations automatically highlight nodes in the graph UI.
- Include [[path:START-END]] and [[Type:Name]] refs as you discover relevant code — the UI highlights them for the user.
- Prefer 2-6 high-signal references over large dumps.
- There is NO \`highlight_in_graph\` tool. Ground with citations; the UI handles visualization.

## 📝 CRITICAL RULES
- **impact output is trusted.** Do NOT re-validate with cypher. Optionally run suggested grep for dynamic patterns.
- **Cite or retract.** Never state something you can't ground.
- **Iterative depth.** If Function A calls Function B, read Function B. Trace logic to the source.
- **Prefer cypher** for anything requiring graph connections.

## ERROR RECOVERY
If a tool call fails (Cypher syntax, file not found, invalid regex), do NOT stop.
- Read the error, fix the input, and retry at least once.
- For Cypher errors, verify typed node labels and \`CodeRelation {type: '...'}\` filters match the GRAPH SCHEMA section above.
- If search returns nothing, try grep or a different query before concluding.

## 🎯 OUTPUT STYLE
Think like a senior architect. Be concise — no fluff.
- Use tables for comparisons/rankings
- Use mermaid diagrams for flows, architecture, and dependencies
- Surface deep insights: patterns, coupling, design decisions
- End with **TL;DR**

## MERMAID RULES
When generating diagrams:
- NO special characters in node labels: quotes, (), /, &, <, >
- Wrap labels with spaces in quotes: A["My Label"]
- Use simple IDs: A, B, C or auth, db, api
- Flowchart: graph TD or graph LR (not flowchart)
- Keep diagrams focused — 5-10 nodes max
- Always test mentally: would this parse?

BAD:  A[User's Data] --> B(Process & Save)
GOOD: A["User Data"] --> B["Process and Save"]
`;

export const createChatModel = (config: ProviderConfig): BaseChatModel => {
  switch (config.provider) {
    case 'openai': {
      const openaiConfig = config as OpenAIConfig;

      if (!openaiConfig.apiKey || openaiConfig.apiKey.trim() === '') {
        throw new Error('OpenAI API key is required but was not provided');
      }

      return new ChatOpenAI({
        apiKey: openaiConfig.apiKey,
        modelName: openaiConfig.model,
        temperature: openaiConfig.temperature ?? 0.1,
        maxTokens: openaiConfig.maxTokens,
        configuration: {
          apiKey: openaiConfig.apiKey,
          ...(openaiConfig.baseUrl ? { baseURL: openaiConfig.baseUrl } : {}),
        },
        streaming: true,
      });
    }

    case 'azure-openai': {
      const azureConfig = config as AzureOpenAIConfig;
      return new AzureChatOpenAI({
        azureOpenAIApiKey: azureConfig.apiKey,
        azureOpenAIApiInstanceName: extractInstanceName(azureConfig.endpoint),
        azureOpenAIApiDeploymentName: azureConfig.deploymentName,
        azureOpenAIApiVersion: azureConfig.apiVersion ?? '2024-12-01-preview',
        // Note: gpt-5.2-chat only supports temperature=1 (default)
        streaming: true,
      });
    }

    case 'gemini': {
      const geminiConfig = config as GeminiConfig;
      return new ChatGoogleGenerativeAI({
        apiKey: geminiConfig.apiKey,
        model: geminiConfig.model,
        temperature: geminiConfig.temperature ?? 0.1,
        maxOutputTokens: geminiConfig.maxTokens,
        streaming: true,
      });
    }

    case 'anthropic': {
      const anthropicConfig = config as AnthropicConfig;
      return new ChatAnthropic({
        anthropicApiKey: anthropicConfig.apiKey,
        model: anthropicConfig.model,
        temperature: anthropicConfig.temperature ?? 0.1,
        maxTokens: anthropicConfig.maxTokens ?? 8192,
        streaming: true,
      });
    }

    case 'ollama': {
      const ollamaConfig = config as OllamaConfig;
      return new ChatOllama({
        baseUrl: ollamaConfig.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
        model: ollamaConfig.model,
        temperature: ollamaConfig.temperature ?? 0.1,
        streaming: true,
        // Allow longer responses (Ollama default is often 128-2048)
        numPredict: 30000,
        // Increase context window (Ollama default is only 2048!)
        // This is critical for agentic workflows with tool calls
        numCtx: 32768,
      });
    }

    case 'openrouter': {
      const openRouterConfig = config as OpenRouterConfig;

      // Debug logging
      if (import.meta.env.DEV) {
        console.log('🌐 OpenRouter config:', {
          hasApiKey: !!openRouterConfig.apiKey,
          model: openRouterConfig.model,
          baseUrl: openRouterConfig.baseUrl,
        });
      }

      if (!openRouterConfig.apiKey || openRouterConfig.apiKey.trim() === '') {
        throw new Error('OpenRouter API key is required but was not provided');
      }

      return new ChatOpenAI({
        openAIApiKey: openRouterConfig.apiKey,
        apiKey: openRouterConfig.apiKey, // Fallback for some versions
        modelName: openRouterConfig.model,
        temperature: openRouterConfig.temperature ?? 0.1,
        maxTokens: openRouterConfig.maxTokens,
        configuration: {
          apiKey: openRouterConfig.apiKey, // Ensure client receives it
          baseURL: openRouterConfig.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
        },
        streaming: true,
      });
    }

    case 'minimax': {
      const minimaxConfig = config as MiniMaxConfig;

      if (!minimaxConfig.apiKey || minimaxConfig.apiKey.trim() === '') {
        throw new Error('MiniMax API key is required but was not provided');
      }

      return new ChatAnthropic({
        anthropicApiKey: minimaxConfig.apiKey,
        model: minimaxConfig.model,
        temperature: minimaxConfig.temperature ?? 0.1,
        maxTokens: minimaxConfig.maxTokens ?? 8192,
        streaming: true,
        clientOptions: {
          baseURL: 'https://api.minimax.io/anthropic',
        },
      });
    }

    case 'glm': {
      const glmConfig = config as GLMConfig;

      if (!glmConfig.apiKey || glmConfig.apiKey.trim() === '') {
        throw new Error('GLM API key is required but was not provided');
      }

      return new ChatOpenAI({
        apiKey: glmConfig.apiKey,
        modelName: glmConfig.model,
        temperature: glmConfig.temperature ?? 0.1,
        maxTokens: glmConfig.maxTokens,
        configuration: {
          apiKey: glmConfig.apiKey,
          baseURL: glmConfig.baseUrl ?? 'https://api.z.ai/api/coding/paas/v4',
        },
        streaming: true,
      });
    }

    case 'deepseek': {
      const deepseekConfig = config as DeepSeekConfig;

      if (!deepseekConfig.apiKey || deepseekConfig.apiKey.trim() === '') {
        throw new Error('DeepSeek API key is required but was not provided');
      }

      return new DeepSeekChatOpenAI({
        apiKey: deepseekConfig.apiKey,
        modelName: deepseekConfig.model,
        temperature: deepseekConfig.temperature ?? 0.1,
        maxTokens: deepseekConfig.maxTokens,
        configuration: {
          apiKey: deepseekConfig.apiKey,
          baseURL: 'https://api.deepseek.com',
        },
        streaming: true,
      });
    }

    default:
      throw new Error(`Unsupported provider: ${(config as any).provider}`);
  }
};

/**
 * Extract instance name from Azure endpoint URL
 * e.g., "https://my-resource.openai.azure.com" -> "my-resource"
 */
const extractInstanceName = (endpoint: string): string => {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname;
    // Extract the first part before .openai.azure.com. The trailing `$`
    // anchor is required (CodeQL js/regex/missing-regexp-anchor): without
    // it `evil.openai.azure.com.attacker.tld` would match.
    const match = hostname.match(/^([^.]+)\.openai\.azure\.com$/);
    if (match) {
      return match[1];
    }
    // Fallback: just use the first part of hostname
    return hostname.split('.')[0];
  } catch {
    return endpoint;
  }
};

/**
 * Create a Graph RAG agent
 */
export const createGraphRAGAgent = (
  config: ProviderConfig,
  backend: GraphRAGBackend,
  codebaseContext?: CodebaseContext,
  chatOnly = false,
) => {
  const model = createChatModel(config);
  const tools = createGraphRAGTools(backend);

  // Use dynamic prompt if context is provided, otherwise use base prompt. The
  // chat-only note (graph not loaded, #2178) must apply in BOTH branches — when
  // codebaseContext is absent, buildDynamicSystemPrompt is never called, so
  // append the note here too.
  const systemPrompt = codebaseContext
    ? buildDynamicSystemPrompt(BASE_SYSTEM_PROMPT, codebaseContext, chatOnly)
    : chatOnly
      ? `${BASE_SYSTEM_PROMPT}${CHAT_ONLY_PROMPT_NOTE}`
      : BASE_SYSTEM_PROMPT;

  // Log the full prompt for debugging
  if (import.meta.env.DEV) {
    console.log('🤖 AGENT SYSTEM PROMPT:\n', systemPrompt);
  }

  const agent = createReactAgent({
    llm: model as any,
    tools: tools as any,
    messageModifier: new SystemMessage(systemPrompt) as any,
  });

  return agent;
};

/**
 * Message type for agent conversation
 */
export type AgentMessage = { role: 'user'; content: string } | AgentHistoryMessage;

export interface AgentRuntimeOptions {
  /** Capture assistant/tool messages for providers that require exact transcript replay. */
  captureHistory?: boolean;
  /** When aborted (e.g. user clicked Stop), the stream ends with a `cancelled` chunk. */
  signal?: AbortSignal;
}

const isAbortError = (error: unknown, signal?: AbortSignal): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (signal?.aborted) return true;
  return false;
};

export const buildLangChainMessages = (messages: AgentMessage[]): BaseMessage[] =>
  messages.map((message) => {
    if (message.role === 'user') {
      return new HumanMessage(message.content);
    }
    if (message.role === 'tool') {
      return new ToolMessage({
        content: message.content,
        tool_call_id: message.toolCallId,
        ...(message.name ? { name: message.name } : {}),
      });
    }
    return new AIMessage({
      content: message.content,
      ...(typeof message.reasoningContent === 'string'
        ? { additional_kwargs: { reasoning_content: message.reasoningContent } }
        : {}),
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls } : {}),
    } as any);
  });

export const serializeAgentHistoryMessages = (
  messages: unknown[],
  startIndex = 0,
): AgentHistoryMessage[] => {
  const serialized: AgentHistoryMessage[] = [];
  for (const rawMessage of messages.slice(startIndex)) {
    const msg: any = rawMessage;
    const msgType = msg?._getType?.() || msg?.type || msg?.constructor?.name || 'unknown';
    if (msgType === 'ai' || msgType === 'AIMessage') {
      const reasoningContent = (msg.additional_kwargs || msg.kwargs)?.reasoning_content;
      const toolCalls = normalizeToolCalls(msg.tool_calls);
      serialized.push({
        role: 'assistant',
        content: normalizeMessageContent(msg.content),
        ...(toolCalls?.length && typeof reasoningContent === 'string' ? { reasoningContent } : {}),
        ...(toolCalls?.length ? { toolCalls } : {}),
      });
      continue;
    }
    if (msgType === 'tool' || msgType === 'ToolMessage') {
      serialized.push({
        role: 'tool',
        content: normalizeMessageContent(msg.content),
        toolCallId: String(msg.tool_call_id ?? ''),
        ...(typeof msg.name === 'string' ? { name: msg.name } : {}),
      });
    }
  }
  return serialized;
};

/**
 * Stream a response from the agent
 * Uses BOTH streamModes for best of both worlds:
 * - 'values' for state transitions (tool calls, results) in proper order
 * - 'messages' for token-by-token text streaming
 *
 * This preserves the natural progression: reasoning → tool → reasoning → tool → answer
 */
export async function* streamAgentResponse(
  agent: ReturnType<typeof createReactAgent>,
  messages: AgentMessage[],
  options: AgentRuntimeOptions = {},
): AsyncGenerator<AgentStreamChunk> {
  try {
    const formattedMessages = buildLangChainMessages(messages);

    // Use BOTH modes: 'values' for structure, 'messages' for token streaming
    const stream = await agent.stream({ messages: formattedMessages }, {
      streamMode: ['values', 'messages'] as any,
      // Allow longer tool/reasoning loops (more Cursor-like persistence)
      recursionLimit: 50,
      signal: options.signal,
    } as any);

    // Track what we've yielded to avoid duplicates
    const yieldedToolCalls = new Set<string>();
    const yieldedToolResults = new Set<string>();
    let lastProcessedMsgCount = formattedMessages.length;
    // Track pending tool calls (for distinguishing reasoning vs final content)
    let pendingToolCalls = 0;
    // Track if we've seen any tool calls in this response turn.
    // Anything before the first tool call should be treated as "reasoning/narration"
    // so the UI can show the Cursor-like loop: plan → tool → update → tool → answer.
    let hasSeenToolCallThisTurn = false;
    // Track the last set of messages so we can persist the raw assistant/tool
    // transcript for the next user turn.
    let lastStepMessages: any[] | null = null;

    for await (const event of stream) {
      if (options.signal?.aborted) {
        break;
      }

      // Events come as [streamMode, data] tuples when using multiple modes
      // or just data when using single mode
      let mode: string;
      let data: any;

      if (Array.isArray(event) && event.length === 2 && typeof event[0] === 'string') {
        [mode, data] = event;
      } else if (Array.isArray(event) && event[0]?._getType) {
        // Single messages mode format: [message, metadata]
        mode = 'messages';
        data = event;
      } else {
        // Assume values mode
        mode = 'values';
        data = event;
      }

      // DEBUG: Enhanced logging
      if (import.meta.env.DEV) {
        const msgType = (mode === 'messages' && data?.[0]?._getType?.()) || 'n/a';
        const hasContent = mode === 'messages' && data?.[0]?.content;
        const hasToolCalls = mode === 'messages' && data?.[0]?.tool_calls?.length > 0;
        console.log(`🔄 [${mode}] type:${msgType} content:${!!hasContent} tools:${hasToolCalls}`);
      }
      // Handle 'messages' mode - token-by-token streaming
      if (mode === 'messages') {
        const [msg] = Array.isArray(data) ? data : [data];
        if (!msg) continue;

        const msgType = msg._getType?.() || msg.type || msg.constructor?.name || 'unknown';

        // AIMessageChunk - streaming text tokens
        if (msgType === 'ai' || msgType === 'AIMessage' || msgType === 'AIMessageChunk') {
          const rawContent = msg.content;
          const toolCalls = msg.tool_calls || [];

          // Handle content that can be string or array of content blocks
          let content: string = '';
          if (typeof rawContent === 'string') {
            content = rawContent;
          } else if (Array.isArray(rawContent)) {
            // Content blocks format: [{type: 'text', text: '...'}, ...]
            content = rawContent
              .filter((block: any) => block.type === 'text' || typeof block === 'string')
              .map((block: any) => (typeof block === 'string' ? block : block.text || ''))
              .join('');
          }

          // If chunk has content, stream it
          if (content && content.length > 0) {
            // Determine if this is reasoning/narration vs final answer content.
            // - Before the first tool call: treat as reasoning (narration)
            // - Between tool calls/results: treat as reasoning
            // - After all tools are done: treat as final content
            const isReasoning =
              !hasSeenToolCallThisTurn || toolCalls.length > 0 || pendingToolCalls > 0;
            if (isReasoning) {
              yield { type: 'reasoning', reasoning: content };
            } else {
              yield { type: 'content', content };
            }
          }

          // Track tool calls from message chunks
          if (toolCalls.length > 0) {
            hasSeenToolCallThisTurn = true;
            pendingToolCalls += toolCalls.length;
            for (const tc of toolCalls) {
              const toolId = tc.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              if (!yieldedToolCalls.has(toolId)) {
                yieldedToolCalls.add(toolId);
                let parsedArgs: Record<string, any>;
                try {
                  parsedArgs = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                } catch {
                  parsedArgs = {};
                }
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: toolId,
                    name: tc.name || tc.function?.name || 'unknown',
                    args: tc.args || parsedArgs,
                    status: 'running',
                  },
                };
              }
            }
          }
        }

        // ToolMessage in messages mode
        if (msgType === 'tool' || msgType === 'ToolMessage') {
          const toolCallId = msg.tool_call_id || '';
          if (toolCallId && !yieldedToolResults.has(toolCallId)) {
            yieldedToolResults.add(toolCallId);
            const result =
              typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            yield {
              type: 'tool_result',
              toolCall: {
                id: toolCallId,
                name: msg.name || 'tool',
                args: {},
                result: result,
                status: 'completed',
              },
            };
            // After tool result, decrement pending count
            pendingToolCalls = Math.max(0, pendingToolCalls - 1);
          }
        }
      }

      // Handle 'values' mode - state snapshots for structure
      if (mode === 'values' && data?.messages) {
        const stepMessages = data.messages || [];
        if (options.captureHistory) {
          lastStepMessages = stepMessages;
        }

        // Process new messages for tool calls/results we might have missed
        for (let i = lastProcessedMsgCount; i < stepMessages.length; i++) {
          const msg = stepMessages[i];
          const msgType = msg._getType?.() || msg.type || 'unknown';

          // Catch tool calls from values mode (backup)
          if ((msgType === 'ai' || msgType === 'AIMessage') && !yieldedToolCalls.size) {
            const toolCalls = msg.tool_calls || [];
            for (const tc of toolCalls) {
              const toolId = tc.id || `tool-${Date.now()}`;
              if (!yieldedToolCalls.has(toolId)) {
                pendingToolCalls++;
                yieldedToolCalls.add(toolId);
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: toolId,
                    name: tc.name || 'unknown',
                    args: tc.args || {},
                    status: 'running',
                  },
                };
              }
            }
          }

          // Catch tool results from values mode (backup)
          if (msgType === 'tool' || msgType === 'ToolMessage') {
            const toolCallId = msg.tool_call_id || '';
            if (toolCallId && !yieldedToolResults.has(toolCallId)) {
              yieldedToolResults.add(toolCallId);
              const result =
                typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
              yield {
                type: 'tool_result',
                toolCall: {
                  id: toolCallId,
                  name: msg.name || 'tool',
                  args: {},
                  result: result,
                  status: 'completed',
                },
              };
              pendingToolCalls = Math.max(0, pendingToolCalls - 1);
            }
          }
        }

        lastProcessedMsgCount = stepMessages.length;
      }
    }

    if (options.signal?.aborted) {
      yield { type: 'cancelled' };
      return;
    }

    // DEBUG: Stream completed normally
    if (import.meta.env.DEV) {
      console.log('✅ Stream completed normally, yielding done');
    }

    yield {
      type: 'done',
      historyMessages:
        options.captureHistory && lastStepMessages
          ? serializeAgentHistoryMessages(lastStepMessages, formattedMessages.length)
          : undefined,
    };
  } catch (error) {
    if (isAbortError(error, options.signal)) {
      yield { type: 'cancelled' };
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // DEBUG: Stream error
    if (import.meta.env.DEV) {
      console.error('❌ Stream error:', message, error);
    }
    yield {
      type: 'error',
      error: message,
    };
  }
}

/**
 * Get a non-streaming response from the agent
 * Simpler for cases where streaming isn't needed
 */
export const invokeAgent = async (
  agent: ReturnType<typeof createReactAgent>,
  messages: AgentMessage[],
): Promise<string> => {
  const formattedMessages = buildLangChainMessages(messages);

  const result = await agent.invoke({ messages: formattedMessages });

  // result.messages is the full conversation state
  const lastMessage = result.messages[result.messages.length - 1];
  return lastMessage?.content?.toString() ?? 'No response generated.';
};
