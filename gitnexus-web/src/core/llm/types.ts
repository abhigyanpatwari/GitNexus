/**
 * LLM Provider Types
 * 
 * Type definitions for multi-provider LLM support.
 * Supports Azure OpenAI and Google Gemini (with extensibility for others).
 */

/**
 * Supported LLM providers
 */
export type LLMProvider = 'openai' | 'azure-openai' | 'gemini' | 'anthropic' | 'ollama' | 'openrouter' | 'minimax';

/**
 * Base configuration shared by all providers
 */
export interface BaseProviderConfig {
  provider: LLMProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * OpenAI specific configuration
 */
export interface OpenAIConfig extends BaseProviderConfig {
  provider: 'openai';
  apiKey: string;
  model: string;  // e.g., 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'
  baseUrl?: string;  // optional, for custom endpoints or proxies
}

/**
 * Azure OpenAI specific configuration
 */
export interface AzureOpenAIConfig extends BaseProviderConfig {
  provider: 'azure-openai';
  apiKey: string;
  endpoint: string;  // e.g., https://your-resource.openai.azure.com
  deploymentName: string;
  apiVersion?: string;  // defaults to '2024-08-01-preview'
}

/**
 * Google Gemini specific configuration
 */
export interface GeminiConfig extends BaseProviderConfig {
  provider: 'gemini';
  apiKey: string;
  model: string;  // e.g., 'gemini-2.0-flash', 'gemini-1.5-pro'
}

/**
 * Anthropic (Claude) configuration
 */
export interface AnthropicConfig extends BaseProviderConfig {
  provider: 'anthropic';
  apiKey: string;
  model: string;  // e.g., 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022'
}

/**
 * Ollama configuration (for future use)
 */
export interface OllamaConfig extends BaseProviderConfig {
  provider: 'ollama';
  baseUrl?: string;  // defaults to http://localhost:11434
  model: string;
}

/**
 * OpenRouter configuration
 */
export interface OpenRouterConfig extends BaseProviderConfig {
  provider: 'openrouter';
  apiKey: string;
  model: string;  // e.g., 'anthropic/claude-3.5-sonnet', 'openai/gpt-4-turbo'
  baseUrl?: string;  // defaults to https://openrouter.ai/api/v1
}

/**
 * MiniMax configuration (Anthropic-compatible API)
 */
export interface MiniMaxConfig extends BaseProviderConfig {
  provider: 'minimax';
  apiKey: string;
  model: string;  // e.g., 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'
}

/**
 * Union type for all provider configurations
 */
export type ProviderConfig = OpenAIConfig | AzureOpenAIConfig | GeminiConfig | AnthropicConfig | OllamaConfig | OpenRouterConfig | MiniMaxConfig;

/**
 * Stored settings (what goes to localStorage)
 */
export interface LLMSettings {
  activeProvider: LLMProvider;
  /**
   * Provider settings are persisted to localStorage and may be partially configured.
   * We validate required fields at runtime before creating a ProviderConfig.
   */
  openai?: Partial<Omit<OpenAIConfig, 'provider'>>;
  azureOpenAI?: Partial<Omit<AzureOpenAIConfig, 'provider'>>;
  gemini?: Partial<Omit<GeminiConfig, 'provider'>>;
  anthropic?: Partial<Omit<AnthropicConfig, 'provider'>>;
  ollama?: Partial<Omit<OllamaConfig, 'provider'>>;
  openrouter?: Partial<Omit<OpenRouterConfig, 'provider'>>;
  minimax?: Partial<Omit<MiniMaxConfig, 'provider'>>;

  // Intelligent Clustering Settings
  intelligentClustering: boolean;
  hasSeenClusteringPrompt: boolean;
  useSameModelForClustering: boolean;
  clusteringProvider?: Partial<ProviderConfig>; // Optional specific config for clustering
}

/**
 * Default LLM settings
 */
export const DEFAULT_LLM_SETTINGS: LLMSettings = {
  activeProvider: 'gemini',
  intelligentClustering: false,
  hasSeenClusteringPrompt: false,
  useSameModelForClustering: true,
  openai: {
    apiKey: '',
    model: 'gpt-4o',
    temperature: 0.1,
  },
  gemini: {
    apiKey: '',
    model: 'gemini-2.0-flash',
    temperature: 0.1,
  },
  azureOpenAI: {
    apiKey: '',
    endpoint: '',
    deploymentName: '',
    model: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    temperature: 0.1,
  },
  anthropic: {
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.1,
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    temperature: 0.1,
  },
  openrouter: {
    apiKey: '',
    model: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    temperature: 0.1,
  },
  minimax: {
    apiKey: '',
    model: 'MiniMax-M2.5',
    temperature: 0.1,
  },
};

/**
 * A single step in the agent's execution (reasoning or tool call)
 * Steps are rendered in order to show the agent's thought process
 */
export interface MessageStep {
  id: string;
  type: 'reasoning' | 'tool_call' | 'content';
  /** For reasoning/content steps */
  content?: string;
  /** For tool_call steps */
  toolCall?: ToolCallInfo;
}

/**
 * Chat message for agent interaction
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** @deprecated Use steps instead for proper ordering */
  toolCalls?: ToolCallInfo[];
  /** Ordered steps: reasoning, tool calls, and final content interleaved */
  steps?: MessageStep[];
  toolCallId?: string;
  timestamp: number;
}

/**
 * Tool call information for UI display
 */
export interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
}

/**
 * Streaming chunk from agent
 * Now supports step-based streaming where each step is a distinct message
 */
export interface AgentStreamChunk {
  type: 'reasoning' | 'tool_call' | 'tool_result' | 'content' | 'error' | 'done';
  /** LLM's reasoning/thinking text (shown as a step) */
  reasoning?: string;
  /** Final answer content (streamed token by token) */
  content?: string;
  /** Tool call information */
  toolCall?: ToolCallInfo;
  /** Error message */
  error?: string;
}

/**
 * A single step in the agent's execution
 * Used for displaying the agent's thought process
 */
export interface AgentStep {
  id: string;
  type: 'reasoning' | 'tool_call' | 'answer';
  /** For reasoning steps */
  content?: string;
  /** For tool_call steps */
  toolCall?: ToolCallInfo;
  /** Timestamp */
  timestamp: number;
}

/**
 * Graph schema information for LLM context
 */
export const GRAPH_SCHEMA_DESCRIPTION = `
LADYBUG GRAPH DATABASE SCHEMA (Multi-Table):

NODE TABLES:
1. File - Source files
   - id: STRING (primary key)
   - name: STRING
   - filePath: STRING
   - content: STRING

2. Folder - Directories
   - id: STRING (primary key)
   - name: STRING
   - filePath: STRING

3. Function - Function definitions
   - id: STRING (primary key)
   - name: STRING
   - filePath: STRING
   - startLine: INT64
   - endLine: INT64
   - content: STRING

4. Class - Class definitions
   - id: STRING (primary key)
   - name: STRING
   - filePath: STRING
   - startLine: INT64
   - endLine: INT64
   - content: STRING

5. Interface - Interface/Type definitions
   - id: STRING (primary key)
   - name: STRING
   - filePath: STRING
   - startLine: INT64
   - endLine: INT64
   - content: STRING

6. Method - Class methods
   - id: STRING (primary key)
   - name: STRING
   - filePath: STRING
   - startLine: INT64
   - endLine: INT64
   - content: STRING

7. CodeElement - Other code elements (fallback)
   - id: STRING (primary key)
   - name: STRING
   - filePath: STRING
   - startLine: INT64
   - endLine: INT64
   - content: STRING

8. CodeEmbedding - Vector embeddings (separate for efficiency)
   - nodeId: STRING (primary key)
   - embedding: FLOAT[384]

RELATIONSHIP TABLE:
CodeRelation - Single table with 'type' property connecting all node tables
  - type: STRING (values: CONTAINS, DEFINES, IMPORTS, CALLS)

Connection patterns:
- CONTAINS: Folder->Folder, Folder->File
- DEFINES: File->Function, File->Class, File->Interface, File->Method, File->CodeElement
- IMPORTS: File->File
- CALLS: File->Function, File->Method, Function->Function, Function->Method

QUERY PATTERNS:

1. Find all functions:
   MATCH (f:Function) RETURN f.name, f.filePath LIMIT 10

2. Find what a file defines:
   MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(fn:Function)
   WHERE f.name = 'utils.ts'
   RETURN fn.name

3. Find function callers:
   MATCH (caller:File)-[:CodeRelation {type: 'CALLS'}]->(fn:Function {name: 'myFunction'})
   RETURN caller.name, caller.filePath

4. Find imports:
   MATCH (f:File {name: 'main.ts'})-[:CodeRelation {type: 'IMPORTS'}]->(imported:File)
   RETURN imported.name

5. Find files that import a specific file:
   MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(target:File {name: 'utils.ts'})
   RETURN f.name, f.filePath

6. SEMANTIC SEARCH (embeddings in separate table - MUST JOIN):
   CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', $queryVector, 10)
   YIELD node AS emb, distance
   WITH emb, distance
   WHERE distance < 0.4
   MATCH (n:Function {id: emb.nodeId})
   RETURN n.name, n.filePath, distance
   ORDER BY distance

7. Search across all code types (use UNION or separate queries):
   MATCH (f:Function) WHERE f.name CONTAINS 'auth' RETURN f.id, f.name, 'Function' AS type
   UNION ALL
   MATCH (c:Class) WHERE c.name CONTAINS 'auth' RETURN c.id, c.name, 'Class' AS type

8. Folder structure:
   MATCH (parent:Folder)-[:CodeRelation {type: 'CONTAINS'}]->(child)
   WHERE parent.name = 'src'
   RETURN child.name, labels(child)[0] AS type

9. Get all connections for a node:
   MATCH (f:File {name: 'index.ts'})-[r:CodeRelation]-(m)
   RETURN m.name, r.type

TOOLING NOTE (for execute_vector_cypher):
- Write Cypher containing {{QUERY_VECTOR}} where the vector should go.
- The tool will replace {{QUERY_VECTOR}} with CAST([..] AS FLOAT[384]).

NOTES:
- Use proper table names: File, Folder, Function, Class, Interface, Method, CodeElement
- Use CodeRelation with type property: [:CodeRelation {type: 'DEFINES'}]
- For vector search, join CodeEmbedding.nodeId to the appropriate table's id
- Use LIMIT to avoid returning too many results
`;

