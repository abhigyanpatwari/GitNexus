import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { LLMService, LLMConfig } from './llm-service.ts';
import type { KuzuQueryEngine } from '../core/graph/kuzu-query-engine.ts';
import type { KnowledgeGraph } from '../core/graph/types.ts';

import { isKuzuDBEnabled } from '../config/feature-flags.js';

export interface KuzuRAGContext {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
  projectName: string;
}

export interface KuzuQueryResponse {
  nodes: any[];
  relationships: any[];
  executionTime: number;
  resultCount: number;
}

export interface KuzuToolResult {
  toolName: string;
  input: string;
  output: string;
  success: boolean;
  executionTime?: number;
  resultCount?: number;
  error?: string;
}

export interface KuzuRAGResult {
  answer: string;
  reasoning: any[];
  cypherQueries: any[];
  confidence: number;
  sources: string[];
  performance: {
    totalExecutionTime: number;
    queryExecutionTimes: number[];
    kuzuQueryCount: number;
  };
}

// Define tool schemas using Zod
const QueryGraphSchema = z.object({
  query: z.string().describe("The Cypher query to execute on the knowledge graph")
});

const GetCodeSchema = z.object({
  filePath: z.string().describe("The file path to retrieve code from")
});

const SearchFilesSchema = z.object({
  pattern: z.string().describe("The search pattern to find files")
});

const FinalAnswerSchema = z.object({
  answer: z.string().describe("The final answer to the user's question")
});

export class KuzuRAGOrchestrator {
  private llmService: LLMService;
  private kuzuQueryEngine: KuzuQueryEngine;
  private context: KuzuRAGContext | null = null;

  constructor(
    llmService: LLMService,
    kuzuQueryEngine: KuzuQueryEngine
  ) {
    this.llmService = llmService;
    this.kuzuQueryEngine = kuzuQueryEngine;
  }

  /**
   * Initialize the orchestrator with KuzuDB
   */
  async initialize(): Promise<void> {
    if (isKuzuDBEnabled()) {
      await this.kuzuQueryEngine.initialize();
    }
  }

  /**
   * Set the context for RAG operations
   */
  public setContext(context: KuzuRAGContext): void {
    this.context = context;
  }

  /**
   * Process a question using KuzuDB-enhanced RAG with tool calling
   */
  public async processQuestion(
    question: string,
    llmConfig: LLMConfig,
    options: {
      maxReasoningSteps?: number;
      temperature?: number;
      strictMode?: boolean;
      useKuzuDB?: boolean;
      includeReasoning?: boolean;
      queryTimeout?: number;
      maxResults?: number;
    } = {}
  ): Promise<KuzuRAGResult> {
    const {
      strictMode = false,
      useKuzuDB = true,
      includeReasoning = true,
      queryTimeout = 30000,
      maxResults = 100
    } = options;

    if (!this.context) {
      throw new Error('Context not set. Call setContext() before processing questions.');
    }

    // Define tools using LangChain's tool calling
    const queryGraphTool = tool(
      async ({ query }: { query: string }) => {
        if (useKuzuDB && this.kuzuQueryEngine.isReady()) {
          const kuzuResult = await this.kuzuQueryEngine.executeQuery(query, {
            timeout: queryTimeout,
            maxResults,
            includeExecutionTime: true
          });
          return this.formatKuzuQueryResult(kuzuResult);
        } else {
          const result = await this.executeGraphQuery();
          return JSON.stringify(result, null, 2);
        }
      },
      {
        name: "query_graph",
        description: "Execute Cypher queries on the knowledge graph for code analysis",
        schema: QueryGraphSchema
      }
    );

    const getCodeTool = tool(
      async ({ filePath }: { filePath: string }) => {
        return await this.getCodeSnippet(filePath);
      },
      {
        name: "get_code",
        description: "Retrieve specific code snippets from files",
        schema: GetCodeSchema
      }
    );

    const searchFilesTool = tool(
      async ({ pattern }: { pattern: string }) => {
        const result = await this.searchFiles(pattern);
        return JSON.stringify(result, null, 2);
      },
      {
        name: "search_files",
        description: "Find files by name or content patterns",
        schema: SearchFilesSchema
      }
    );

    const finalAnswerTool = tool(
      async ({ answer }: { answer: string }) => {
        return answer;
      },
      {
        name: "final_answer",
        description: "Provide the final answer to the user's question",
        schema: FinalAnswerSchema
      }
    );

    // Bind tools to the LLM
    const model = this.llmService.getModel(llmConfig);
    if (!model) {
      throw new Error('Failed to get LLM model');
    }
    
    // Check if bindTools method exists
    if (typeof model.bindTools !== 'function') {
      throw new Error('LLM model does not support tool binding');
    }
    
    const modelWithTools = model.bindTools([
      queryGraphTool,
      getCodeTool,
      searchFilesTool,
      finalAnswerTool
    ]);

    // Build system prompt
    const systemPrompt = this.buildKuzuReActSystemPrompt(strictMode, useKuzuDB);
    const conversation = [new SystemMessage(systemPrompt), new HumanMessage(question)];

    // Execute with tool calling
    const response = await modelWithTools.invoke(conversation);
    
    // Process tool calls
    const toolResults: KuzuToolResult[] = [];
    const cypherQueries: any[] = [];
    const reasoning: any[] = [];
    const sources: string[] = [];
    const queryExecutionTimes: number[] = [];
    let kuzuQueryCount = 0;

    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const toolCall of response.tool_calls) {
        const toolResult = await this.executeToolCall(toolCall, {
          useKuzuDB,
          queryTimeout,
          maxResults,
          strictMode
        });
        
        if (toolResult) {
          toolResults.push(toolResult);
          
          if (toolCall.name === 'query_graph') {
            cypherQueries.push({ cypher: toolCall.args.query, explanation: 'Generated via tool calling' });
            if (toolResult.executionTime) {
              queryExecutionTimes.push(toolResult.executionTime);
              kuzuQueryCount++;
            }
          }
          
          if (toolResult.output) {
            sources.push(toolResult.output);
          }
        }
      }
    }

    // Convert response content to string
    const answer = typeof response.content === 'string' 
      ? response.content 
      : Array.isArray(response.content) 
        ? response.content.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(' ')
        : JSON.stringify(response.content);

    return {
      answer,
      reasoning: includeReasoning ? reasoning : [],
      cypherQueries,
      confidence: 0.8, // Could be calculated based on tool results
      sources,
      performance: {
        totalExecutionTime: 0, // Will be calculated
        queryExecutionTimes,
        kuzuQueryCount
      }
    };
  }

  /**
   * Execute a tool call and return the result
   */
  private async executeToolCall(
    toolCall: any,
    options: {
      useKuzuDB: boolean;
      queryTimeout: number;
      maxResults: number;
      strictMode: boolean;
    }
  ): Promise<KuzuToolResult | null> {
    try {
      switch (toolCall.name) {
        case 'query_graph':
          if (options.useKuzuDB && this.kuzuQueryEngine.isReady()) {
            const kuzuResult = await this.kuzuQueryEngine.executeQuery(toolCall.args.query, {
              timeout: options.queryTimeout,
              maxResults: options.maxResults,
              includeExecutionTime: true
            });
            
            return {
              toolName: 'kuzu_query_graph',
              input: toolCall.args.query,
              output: this.formatKuzuQueryResult(kuzuResult),
              success: true,
              executionTime: kuzuResult.executionTime,
              resultCount: kuzuResult.resultCount
            };
          } else {
            const result = await this.executeGraphQuery();
            return {
              toolName: 'query_graph',
              input: toolCall.args.query,
              output: JSON.stringify(result, null, 2),
              success: true
            };
          }

        case 'get_code':
          const codeResult = await this.getCodeSnippet(toolCall.args.filePath);
          return {
            toolName: 'get_code',
            input: toolCall.args.filePath,
            output: codeResult,
            success: true
          };

        case 'search_files':
          const searchResult = await this.searchFiles(toolCall.args.pattern);
          return {
            toolName: 'search_files',
            input: toolCall.args.pattern,
            output: JSON.stringify(searchResult, null, 2),
            success: true
          };

        case 'final_answer':
          return {
            toolName: 'final_answer',
            input: toolCall.args.answer,
            output: toolCall.args.answer,
            success: true
          };

        default:
          return {
            toolName: 'unknown',
            input: JSON.stringify(toolCall.args),
            output: `Unknown tool: ${toolCall.name}`,
            success: false,
            error: `Unknown tool: ${toolCall.name}`
          };
      }
    } catch (error) {
      return {
        toolName: toolCall.name,
        input: JSON.stringify(toolCall.args),
        output: `Error executing tool: ${error instanceof Error ? error.message : 'Unknown error'}`,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Build system prompt for KuzuDB-enhanced ReAct
   */
  private buildKuzuReActSystemPrompt(strictMode: boolean, useKuzuDB: boolean): string {
    const basePrompt = `You are an AI assistant that helps analyze codebases using a knowledge graph powered by KuzuDB (a high-performance graph database). You have access to sophisticated graph querying capabilities for fast and accurate code analysis.

Available tools:
1. query_graph - Execute Cypher queries on the knowledge graph (${useKuzuDB ? 'using KuzuDB for enhanced performance' : 'using in-memory graph'})
2. get_code - Retrieve specific code snippets
3. search_files - Find files by name or content patterns
4. final_answer - Provide the final answer

${useKuzuDB ? `
KUZUDB CAPABILITIES:
- High-performance graph queries with execution time tracking
- Complex dependency analysis and call chain traversal
- Persistent storage across sessions
- Optimized for large-scale codebases
- Real-time performance monitoring

PERFORMANCE FEATURES:
- Query execution time is automatically tracked
- Results include performance metrics
- Database operations are optimized for speed
- Support for complex graph traversals` : 'Using in-memory graph for queries.'}

${strictMode ? 'STRICT MODE: Only use exact matches and precise queries.' : 'FLEXIBLE MODE: Use heuristic matching when exact matches fail.'}

QUERY OPTIMIZATION GUIDELINES:
- Use specific node types (Function, Class, Method) for better performance
- Leverage variable-length paths for dependency analysis
- Use aggregation functions for statistics and summaries
- Prefer complex graph traversals over simple lookups
- Take advantage of KuzuDB's strength in pattern matching

Always follow this format:
Thought: I need to think about what information I need
Action: tool_name
Action Input: the input to the tool
Observation: the result of the action
... (repeat if needed)
Thought: I now have enough information to answer
Action: final_answer
Action Input: the final answer to the user's question

When using query_graph, focus on:
- Complex dependency analysis
- Call chain traversal
- Pattern matching across the codebase
- Statistical analysis of code structure
- Relationship exploration between code entities`;

    return basePrompt;
  }

  /**
   * Format KuzuDB query result for observation
   */
  private formatKuzuQueryResult(result: KuzuQueryResponse): string {
    const summary = `Found ${result.nodes.length} nodes and ${result.relationships.length} relationships (execution time: ${result.executionTime.toFixed(2)}ms)`;

    if (result.nodes.length === 0 && result.relationships.length === 0) {
      return `${summary}. No results found.`;
    }

    const nodeSummary = result.nodes.length > 0 
      ? `\nNodes: ${result.nodes.slice(0, 5).map(n => `${n.label}:${n.properties.name || n.id}`).join(', ')}${result.nodes.length > 5 ? '...' : ''}`
      : '';
    
    const relSummary = result.relationships.length > 0
      ? `\nRelationships: ${result.relationships.slice(0, 5).map(r => `${r.type}:${r.source}->${r.target}`).join(', ')}${result.relationships.length > 5 ? '...' : ''}`
      : '';

    return `${summary}${nodeSummary}${relSummary}`;
  }

  /**
   * Execute graph query (fallback to in-memory)
   */
  private async executeGraphQuery(): Promise<any> {
    if (!this.context) {
      throw new Error('Context not set');
    }

    // Simple in-memory query execution as fallback
    // This would be replaced with actual graph query logic
    return { results: [], count: 0 };
  }

  /**
   * Get code snippet
   */
  private async getCodeSnippet(filePath: string): Promise<string> {
    if (!this.context) {
      throw new Error('Context not set');
    }

    const content = this.context.fileContents.get(filePath);
    return content || 'File not found';
  }

  /**
   * Search files
   */
  private async searchFiles(pattern: string): Promise<string[]> {
    if (!this.context) {
      throw new Error('Context not set');
    }

    const matchingFiles: string[] = [];
    for (const [filePath, content] of this.context.fileContents.entries()) {
      if (filePath.includes(pattern) || content.includes(pattern)) {
        matchingFiles.push(filePath);
      }
    }

    return matchingFiles.slice(0, 10); // Limit results
  }

  /**
   * Get performance statistics
   */
  async getPerformanceStats(): Promise<any> {
    if (!this.kuzuQueryEngine.isReady()) {
      return { status: 'KuzuDB not initialized' };
    }

    const dbStats = await this.kuzuQueryEngine.getDatabaseStats();
    return {
      kuzuDBStatus: 'ready',
      databaseStats: dbStats,
      queryEngineReady: this.kuzuQueryEngine.isReady()
    };
  }

  /**
   * Close the orchestrator
   */
  async close(): Promise<void> {
    await this.kuzuQueryEngine.close();
  }
}
