import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { LLMService, LLMConfig } from './llm-service.ts';
import type { CypherGenerator, CypherQuery } from './cypher-generator.ts';
import type { KnowledgeGraph } from '../core/graph/types.ts';

import { KuzuQueryEngine, type KuzuQueryResponse } from '../core/graph/kuzu-query-engine.js';
import { isKuzuDBEnabled } from '../config/feature-flags.js';

export interface KuzuRAGContext {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
  kuzuQueryEngine: KuzuQueryEngine;
}

export interface KuzuToolResult {
  toolName: string;
  input: string;
  output: string;
  success: boolean;
  error?: string;
  executionTime?: number;
  resultCount?: number;
}

export interface KuzuReasoningStep {
  step: number;
  thought: string;
  action: string;
  actionInput: string;
  observation: string;
  toolResult?: KuzuToolResult;
  cypherQuery?: string;
}

export interface KuzuRAGResponse {
  answer: string;
  reasoning: KuzuReasoningStep[];
  cypherQueries: CypherQuery[];
  confidence: number;
  sources: string[];
  performance: {
    totalExecutionTime: number;
    queryExecutionTimes: number[];
    kuzuQueryCount: number;
  };
}

export interface KuzuRAGOptions {
  maxReasoningSteps?: number;
  includeReasoning?: boolean;
  strictMode?: boolean;
  temperature?: number;
  useKuzuDB?: boolean;
  queryTimeout?: number;
  maxResults?: number;
}

export class KuzuRAGOrchestrator {
  private llmService: LLMService;
  private cypherGenerator: CypherGenerator;
  private context: KuzuRAGContext | null = null;
  private kuzuQueryEngine: KuzuQueryEngine;

  constructor(llmService: LLMService, cypherGenerator: CypherGenerator) {
    this.llmService = llmService;
    this.cypherGenerator = cypherGenerator;
    this.kuzuQueryEngine = new KuzuQueryEngine();
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
   * Set the current context (graph, file contents, and KuzuDB query engine)
   */
  public async setContext(context: Omit<KuzuRAGContext, 'kuzuQueryEngine'>): Promise<void> {
    this.context = {
      ...context,
      kuzuQueryEngine: this.kuzuQueryEngine
    };

    this.cypherGenerator.updateSchema(context.graph);

    // Import graph into KuzuDB for faster queries if enabled
    if (isKuzuDBEnabled() && this.kuzuQueryEngine.isReady()) {
      await this.kuzuQueryEngine.importGraph(context.graph);
    }
  }

  /**
   * Answer a question using ReAct pattern with KuzuDB integration
   */
  public async answerQuestion(
    question: string,
    llmConfig: LLMConfig,
    options: KuzuRAGOptions = {}
  ): Promise<KuzuRAGResponse> {
    if (!this.context) {
      throw new Error('Context not set. Call setContext() first.');
    }

    const {
      maxReasoningSteps = 5,
      includeReasoning = true,
      strictMode = false,
      temperature = 0.1,
      useKuzuDB = isKuzuDBEnabled(),
      queryTimeout = 30000,
      maxResults = 100
    } = options;

    const reasoning: KuzuReasoningStep[] = [];
    const cypherQueries: CypherQuery[] = [];
    const sources: string[] = [];
    const queryExecutionTimes: number[] = [];
    let kuzuQueryCount = 0;

    const reasoningConfig: LLMConfig = {
      ...llmConfig,
      temperature: temperature
    };

    let currentStep = 1;
    let finalAnswer = '';
    let confidence = 0.5;
    const startTime = performance.now();

    try {
      const systemPrompt = this.buildKuzuReActSystemPrompt(strictMode, useKuzuDB);
      const conversation = [new SystemMessage(systemPrompt)];

      // Add the user question
      conversation.push(new HumanMessage(question));

      while (currentStep <= maxReasoningSteps) {
        // Get LLM response with reasoning
        const response = await this.llmService.chat(reasoningConfig, conversation);
        const content = response.content;

        // Parse the response for thought, action, and observation
        const parsed = this.parseReActResponse(content);

        if (!parsed) {
          // If we can't parse the response, assume it's the final answer
          finalAnswer = content;
          break;
        }

        const { thought, action, actionInput } = parsed;

        // Execute the action
        let observation = '';
        let toolResult: KuzuToolResult | undefined;

        try {
          if (action === 'query_graph') {

            if (useKuzuDB && this.kuzuQueryEngine.isReady()) {
              // Use KuzuDB for faster query execution
              const kuzuResult = await this.kuzuQueryEngine.executeQuery(actionInput, {
                timeout: queryTimeout,
                maxResults,
                includeExecutionTime: true
              });

              observation = this.formatKuzuQueryResult(kuzuResult);
              toolResult = {
                toolName: 'kuzu_query_graph',
                input: actionInput,
                output: observation,
                success: true,
                executionTime: kuzuResult.executionTime,
                resultCount: kuzuResult.resultCount
              };

              queryExecutionTimes.push(kuzuResult.executionTime);
              kuzuQueryCount++;

            } else {
              // Fallback to in-memory graph query
              const result = await this.executeGraphQuery();
              observation = JSON.stringify(result, null, 2);
              toolResult = {
                toolName: 'query_graph',
                input: actionInput,
                output: observation,
                success: true
              };
            }

            // Generate Cypher query for logging
            const cypherQuery = await this.cypherGenerator.generateQuery(actionInput, reasoningConfig, {
              includeExamples: false,
              strictMode: strictMode
            });

            if (cypherQuery) {
              cypherQueries.push(cypherQuery);
            }

          } else if (action === 'get_code') {
            const result = await this.getCodeSnippet(actionInput);
            observation = result;
            toolResult = {
              toolName: 'get_code',
              input: actionInput,
              output: observation,
              success: true
            };

          } else if (action === 'search_files') {
            const result = await this.searchFiles(actionInput);
            observation = JSON.stringify(result, null, 2);
            toolResult = {
              toolName: 'search_files',
              input: actionInput,
              output: observation,
              success: true
            };

          } else if (action === 'final_answer') {
            finalAnswer = actionInput;
            break;
          }

        } catch (error) {
          observation = `Error executing ${action}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          toolResult = {
            toolName: action,
            input: actionInput,
            output: observation,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }

        // Add reasoning step
        reasoning.push({
          step: currentStep,
          thought,
          action,
          actionInput,
          observation,
          toolResult,
          cypherQuery: action === 'query_graph' ? actionInput : undefined
        });

        // Add to conversation for next iteration
        conversation.push(new AIMessage(content));
        conversation.push(new HumanMessage(`Observation: ${observation}\n\nWhat should I do next?`));

        currentStep++;
      }

      const totalExecutionTime = performance.now() - startTime;

      return {
        answer: finalAnswer,
        reasoning: includeReasoning ? reasoning : [],
        cypherQueries,
        confidence,
        sources,
        performance: {
          totalExecutionTime,
          queryExecutionTimes,
          kuzuQueryCount
        }
      };

    } catch (error) {
      console.error('KuzuRAG orchestrator error:', error);
      throw new Error(`RAG orchestration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
   * Parse ReAct response format
   */
  private parseReActResponse(content: string): { thought: string; action: string; actionInput: string } | null {
    const thoughtMatch = content.match(/Thought:\s*(.+?)(?=\nAction:)/s);
    const actionMatch = content.match(/Action:\s*(.+?)(?=\nAction Input:)/);
    const actionInputMatch = content.match(/Action Input:\s*(.+?)(?=\nObservation:|\nThought:|$)/s);

    if (thoughtMatch && actionMatch && actionInputMatch) {
      return {
        thought: thoughtMatch[1].trim(),
        action: actionMatch[1].trim(),
        actionInput: actionInputMatch[1].trim()
      };
    }

    return null;
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
