/**
 * Graph RAG Agent Factory
 * 
 * Creates a LangChain agent configured for code graph analysis.
 * Supports Azure OpenAI and Google Gemini providers.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOllama } from '@langchain/ollama';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createGraphRAGTools } from './tools';
import type {
  ProviderConfig,
  OpenAIConfig,
  AzureOpenAIConfig,
  GeminiConfig,
  AnthropicConfig,
  OllamaConfig,
  OpenRouterConfig,
  MiniMaxConfig,
  AgentStreamChunk,
} from './types';
import { 
  type CodebaseContext,
  buildDynamicSystemPrompt,
} from './context-builder';

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
- File refs: [[src/auth.ts:45-60]] (line range with hyphen)
- NO citation = NO claim. Say "I didn't find evidence" instead of guessing.

## ⚠️ MANDATORY: VALIDATION
Every output MUST be validated.
- Use cypher to validate the results and confirm completeness of context before final output.
- NO validation = NO claim. Say "I didn't find evidence" instead of guessing.
- Do not blindly trust readme or single source of truth. Always validate and cross-reference. Never be lazy.

## 🧠 CORE PROTOCOL
You are an investigator. For each question:
1. **Search** → Use cypher, search or grep to find relevant code
2. **Read** → Use read to see the actual source
3. **Trace** → Use cypher to follow connections in the graph
4. **Cite** → Ground every finding with [[file:line]] or [[Type:Name]]
5. **Validate** → Use cypher to validate the results and confirm completeness of context before final output. ( MUST DO )

## 🛠️ TOOLS
- **\`search\`** — Hybrid search. Results grouped by process with cluster context.
- **\`cypher\`** — Cypher queries against the graph. Use \`{{QUERY_VECTOR}}\` for vector search.
- **\`grep\`** — Regex search. Best for exact strings, TODOs, error codes.
- **\`read\`** — Read file content. Always use after search/grep to see full code.
- **\`explore\`** — Deep dive on a symbol, cluster, or process. Shows membership, participation, connections.
- **\`overview\`** — Codebase map showing all clusters and processes.
- **\`impact\`** — Impact analysis. Shows affected processes, clusters, and risk level.

## 📊 GRAPH SCHEMA
Nodes: File, Folder, Function, Class, Interface, Method, Community, Process
Relations: \`CodeRelation\` with \`type\` property: CONTAINS, DEFINES, IMPORTS, CALLS, EXTENDS, IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS

## 📐 GRAPH SEMANTICS (Important!)
**Edge Types:**
- \`CALLS\`: Method invocation OR constructor injection. If A receives B as parameter and uses it, A→B is CALLS. This is intentional simplification.
- \`IMPORTS\`: File-level import/include statement.
- \`EXTENDS/IMPLEMENTS\`: Class inheritance.

**Process Nodes:**
- Process labels use format: "EntryPoint → Terminal" (e.g., "onCreate → showToast")
- These are heuristic names from tracing execution flow, NOT application-defined names
- Entry points are detected via export status, naming patterns, and framework conventions

Cypher examples:
- \`MATCH (f:Function) RETURN f.name LIMIT 10\`
- \`MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(g:File) RETURN f.name, g.name\`

## 📝CRITICAL RULES
- **impact output is trusted.** Do NOT re-validate with cypher. Optionally run the suggested grep commands for dynamic patterns.
- **Cite or retract.** Never state something you can't ground.
- **Read before concluding.** Don't guess from names alone.
- **Retry on failure.** If a tool fails, fix the input and try again.
- **Cyfer tool validation** prefer using cyfer tool in anything that requires graph connections.
- **OUTPUT STYLE** Prefer using tables and mermaid diagrams instead of long explanations.
- ALWAYS USE MERMAID FOR VISUALIZATION AND STRUCTURING THE OUTPUT.

## 🎯 OUTPUT STYLE
Think like a senior architect. Be concise—no fluff, short, precise and to the point.
- Use tables for comparisons/rankings
- Use mermaid diagrams for flows/dependencies
- Surface deep insights: patterns, coupling, design decisions
- End with **TL;DR** (short summary of the response, summing up the response and the most critical parts)

## MERMAID RULES
When generating diagrams:
- NO special characters in node labels: quotes, (), /, &, <, >
- Wrap labels with spaces in quotes: A["My Label"]
- Use simple IDs: A, B, C or auth, db, api
- Flowchart: graph TD or graph LR (not flowchart)
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
        baseUrl: ollamaConfig.baseUrl ?? 'http://localhost:11434',
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
          apiKeyLength: openRouterConfig.apiKey?.length || 0,
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
          baseURL: openRouterConfig.baseUrl ?? 'https://openrouter.ai/api/v1',
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
    // Extract the first part before .openai.azure.com
    const match = hostname.match(/^([^.]+)\.openai\.azure\.com/);
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
  executeQuery: (cypher: string) => Promise<any[]>,
  semanticSearch: (query: string, k?: number, maxDistance?: number) => Promise<any[]>,
  semanticSearchWithContext: (query: string, k?: number, hops?: number) => Promise<any[]>,
  hybridSearch: (query: string, k?: number) => Promise<any[]>,
  isEmbeddingReady: () => boolean,
  isBM25Ready: () => boolean,
  fileContents: Map<string, string>,
  codebaseContext?: CodebaseContext
) => {
  const model = createChatModel(config);
  const tools = createGraphRAGTools(
    executeQuery,
    semanticSearch,
    semanticSearchWithContext,
    hybridSearch,
    isEmbeddingReady,
    isBM25Ready,
    fileContents
  );
  
  // Use dynamic prompt if context is provided, otherwise use base prompt
  const systemPrompt = codebaseContext 
    ? buildDynamicSystemPrompt(BASE_SYSTEM_PROMPT, codebaseContext)
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
export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

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
  messages: AgentMessage[]
): AsyncGenerator<AgentStreamChunk> {
  try {
    const formattedMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    
    // Use BOTH modes: 'values' for structure, 'messages' for token streaming
    const stream = await agent.stream(
      { messages: formattedMessages },
      {
        streamMode: ['values', 'messages'] as any,
        // Allow longer tool/reasoning loops (more Cursor-like persistence)
        recursionLimit: 50,
      } as any
    );
    
    // Track what we've yielded to avoid duplicates
    const yieldedToolCalls = new Set<string>();
    const yieldedToolResults = new Set<string>();
    let lastProcessedMsgCount = formattedMessages.length;
    // Track if all tools are done (for distinguishing reasoning vs final content)
    let allToolsDone = true;
    // Track if we've seen any tool calls in this response turn.
    // Anything before the first tool call should be treated as "reasoning/narration"
    // so the UI can show the Cursor-like loop: plan → tool → update → tool → answer.
    let hasSeenToolCallThisTurn = false;
    
    for await (const event of stream) {
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
        const msgType = mode === 'messages' && data?.[0]?._getType?.() || 'n/a';
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
              .map((block: any) => typeof block === 'string' ? block : block.text || '')
              .join('');
          }
          
          // If chunk has content, stream it
          if (content && content.length > 0) {
            // Determine if this is reasoning/narration vs final answer content.
            // - Before the first tool call: treat as reasoning (narration)
            // - Between tool calls/results: treat as reasoning
            // - After all tools are done: treat as final content
            const isReasoning =
              !hasSeenToolCallThisTurn ||
              toolCalls.length > 0 ||
              !allToolsDone;
            yield {
              type: isReasoning ? 'reasoning' : 'content',
              [isReasoning ? 'reasoning' : 'content']: content,
            };
          }
          
          // Track tool calls from message chunks
          if (toolCalls.length > 0) {
            hasSeenToolCallThisTurn = true;
            allToolsDone = false;
            for (const tc of toolCalls) {
              const toolId = tc.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              if (!yieldedToolCalls.has(toolId)) {
                yieldedToolCalls.add(toolId);
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: toolId,
                    name: tc.name || tc.function?.name || 'unknown',
                    args: tc.args || (tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}),
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
            const result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
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
            // After tool result, next AI content could be reasoning or final
            allToolsDone = true;
          }
        }
      }
      
      // Handle 'values' mode - state snapshots for structure
      if (mode === 'values' && data?.messages) {
        const stepMessages = data.messages || [];
        
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
                allToolsDone = false;
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
              const result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
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
              allToolsDone = true;
            }
          }
        }
        
        lastProcessedMsgCount = stepMessages.length;
      }
    }
    
    // DEBUG: Stream completed normally
    if (import.meta.env.DEV) {
      console.log('✅ Stream completed normally, yielding done');
    }
    yield { type: 'done' };
  } catch (error) {
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
  messages: AgentMessage[]
): Promise<string> => {
  const formattedMessages = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));
  
  const result = await agent.invoke({ messages: formattedMessages });
  
  // result.messages is the full conversation state
  const lastMessage = result.messages[result.messages.length - 1];
  return lastMessage?.content?.toString() ?? 'No response generated.';
};

