import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { LLMService, LLMConfig } from './llm-service.ts';
import type { CypherGenerator, CypherQuery } from './cypher-generator.ts';
import type { KnowledgeGraph } from '../core/graph/types.ts';
import type { GraphNode } from '../core/graph/types.ts';

export interface RAGContext {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
}

export interface ToolResult {
  toolName: string;
  input: string;
  output: string;
  success: boolean;
  error?: string;
}

export interface ReasoningStep {
  step: number;
  thought: string;
  action: string;
  actionInput: string;
  observation: string;
  toolResult?: ToolResult;
}

export interface RAGResponse {
  answer: string;
  reasoning: ReasoningStep[];
  cypherQueries: CypherQuery[];
  confidence: number;
  sources: string[];
}

export interface RAGOptions {
  maxReasoningSteps?: number;
  includeReasoning?: boolean;
  strictMode?: boolean;
  temperature?: number;
}

export class RAGOrchestrator {
  private llmService: LLMService;
  private cypherGenerator: CypherGenerator;
  private context: RAGContext | null = null;

  constructor(llmService: LLMService, cypherGenerator: CypherGenerator) {
    this.llmService = llmService;
    this.cypherGenerator = cypherGenerator;
  }

  /**
   * Set the current context (graph and file contents)
   */
  public setContext(context: RAGContext): void {
    this.context = context;
    this.cypherGenerator.updateSchema(context.graph);
  }

  /**
   * Answer a question using ReAct pattern
   */
  public async answerQuestion(
    question: string,
    llmConfig: LLMConfig,
    options: RAGOptions = {}
  ): Promise<RAGResponse> {
    if (!this.context) {
      throw new Error('Context not set. Call setContext() first.');
    }

    const {
      maxReasoningSteps = 5,
      includeReasoning = true,
      strictMode = false,
      temperature = 0.1
    } = options;

    const reasoning: ReasoningStep[] = [];
    const cypherQueries: CypherQuery[] = [];
    const sources: string[] = [];

    // Enhanced LLM config for reasoning
    const reasoningConfig: LLMConfig = {
      ...llmConfig,
      temperature: temperature
    };

    let currentStep = 1;
    let finalAnswer = '';
    let confidence = 0.5;

    try {
      // Initial system prompt for ReAct
      const systemPrompt = this.buildReActSystemPrompt(strictMode);
      const conversation = [new SystemMessage(systemPrompt)];

      // Add the user question
      conversation.push(new HumanMessage(`Question: ${question}`));

      while (currentStep <= maxReasoningSteps) {
        // Get reasoning from LLM
        const response = await this.llmService.chat(reasoningConfig, conversation);
        const reasoning_step = this.parseReasoningStep(String(response.content || ''), currentStep);

        reasoning.push(reasoning_step);

        // Check if we have a final answer
        if (reasoning_step.action.toLowerCase().includes('final_answer')) {
          finalAnswer = reasoning_step.actionInput;
          confidence = this.calculateConfidence(reasoning, cypherQueries);
          break;
        }

        // Execute the action
        let toolResult: ToolResult | null = null;
        
        try {
          if (reasoning_step.action.toLowerCase().includes('query_graph')) {
            toolResult = await this.executeGraphQuery(reasoning_step.actionInput, reasoningConfig);
            if (toolResult.success) {
              cypherQueries.push(...this.extractCypherQueries(toolResult));
            }
          } else if (reasoning_step.action.toLowerCase().includes('get_code')) {
            toolResult = await this.getCodeContent(reasoning_step.actionInput);
            if (toolResult.success) {
              sources.push(...this.extractSources(toolResult));
            }
          } else if (reasoning_step.action.toLowerCase().includes('search_files')) {
            toolResult = await this.searchFiles(reasoning_step.actionInput);
          } else {
            toolResult = {
              toolName: 'unknown',
              input: reasoning_step.actionInput,
              output: 'Unknown action type',
              success: false,
              error: `Unknown action: ${reasoning_step.action}`
            };
          }
        } catch (error) {
          toolResult = {
            toolName: reasoning_step.action,
            input: reasoning_step.actionInput,
            output: '',
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }

        // Update the reasoning step with tool result
        reasoning_step.observation = toolResult.output;
        reasoning_step.toolResult = toolResult;

        // Add the tool result to conversation
        conversation.push(new AIMessage(String(response.content || '')));
        conversation.push(new HumanMessage(`Observation: ${toolResult.output}`));

        currentStep++;
      }

      // If we didn't get a final answer, generate one based on the reasoning
      if (!finalAnswer && reasoning.length > 0) {
        const summaryPrompt = this.buildSummaryPrompt(question, reasoning);
        conversation.push(new HumanMessage(summaryPrompt));
        
        const summaryResponse = await this.llmService.chat(reasoningConfig, conversation);
        finalAnswer = String(summaryResponse.content || '');
        confidence = Math.max(0.3, confidence - 0.2); // Lower confidence for incomplete reasoning
      }

      return {
        answer: finalAnswer || 'I was unable to find a complete answer to your question.',
        reasoning: includeReasoning ? reasoning : [],
        cypherQueries,
        confidence,
        sources: Array.from(new Set(sources)) // Remove duplicates
      };

    } catch (error) {
      throw new Error(`RAG orchestration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Build the ReAct system prompt
   */
  private buildReActSystemPrompt(strictMode: boolean): string {
    const prompt = `You are an expert code analyst using a ReAct (Reasoning + Acting) approach to answer questions about a codebase.

You have access to the following tools:
1. query_graph(question): Query the code knowledge graph using natural language
2. get_code(file_path): Retrieve the source code content of a specific file
3. search_files(pattern): Search for files matching a pattern or containing specific text

IMPORTANT INSTRUCTIONS:
- Always think step by step using the format: Thought: [your reasoning]
- Then specify an action using: Action: [tool_name]
- Provide the input using: Action Input: [input for the tool]
- After receiving an observation, continue reasoning or provide a final answer
- Use Final Answer: [your answer] when you have sufficient information
- Base your answers ONLY on the information retrieved from tools
- Do not make assumptions or hallucinate information
- If you cannot find information, say so explicitly

RESPONSE FORMAT:
Thought: [Your reasoning about what to do next]
Action: [query_graph, get_code, search_files, or Final Answer]
Action Input: [The input for the action]

After receiving an Observation, continue with:
Thought: [Your analysis of the observation]
Action: [Next action or Final Answer]
Action Input: [Input for next action or your final answer]

FINAL ANSWER FORMATTING:
When providing your final answer, use markdown formatting for better readability:
- Use **bold** for important terms and concepts
- Use \`inline code\` for function names, file names, and code snippets
- Use code blocks with language specification for longer code examples
- Use bullet points or numbered lists for structured information
- Use headers (##, ###) to organize complex answers
- Use tables when presenting structured data

Example final answer format:
## Summary
The codebase contains **15 functions** across **3 files**.

### Key Functions:
- \`authenticate()\` - Handles user authentication
- \`process_data()\` - Main data processing logic
- \`save_results()\` - Saves processed data to database

${strictMode ? '\nSTRICT MODE: Only use information explicitly found in the tools. Do not infer or assume anything.' : ''}

Remember: Your goal is to provide accurate, evidence-based, and well-formatted answers about the codebase.`;

    return prompt;
  }

  /**
   * Parse a reasoning step from LLM response
   */
  private parseReasoningStep(response: string, stepNumber: number): ReasoningStep {
    // Ensure response is a string
    const responseText = typeof response === 'string' ? response : String(response || '');
    
    const thoughtMatch = responseText.match(/Thought:\s*(.*?)(?=\n|Action:|$)/s);
    const actionMatch = responseText.match(/Action:\s*(.*?)(?=\n|Action Input:|$)/s);
    const inputMatch = responseText.match(/Action Input:\s*(.*?)(?=\n|$)/s);

    return {
      step: stepNumber,
      thought: thoughtMatch?.[1]?.trim() || 'No thought provided',
      action: actionMatch?.[1]?.trim() || 'unknown',
      actionInput: inputMatch?.[1]?.trim() || '',
      observation: '' // Will be filled after tool execution
    };
  }

  /**
   * Execute a graph query using KuzuDB when available, fallback to in-memory
   */
  private async executeGraphQuery(question: string, llmConfig: LLMConfig): Promise<ToolResult> {
    try {
      const cypherQuery = await this.cypherGenerator.generateQuery(question, llmConfig);
      
      // Try to use KuzuDB if available
      try {
        const { isKuzuDBEnabled } = await import('../config/feature-flags.js');
        if (isKuzuDBEnabled()) {
          const { KuzuQueryEngine } = await import('../core/graph/kuzu-query-engine.js');
          const kuzuQueryEngine = new KuzuQueryEngine();
          
          if (kuzuQueryEngine.isReady()) {
            const kuzuResult = await kuzuQueryEngine.executeQuery(cypherQuery.cypher, {
              timeout: 30000,
              maxResults: 100,
              includeExecutionTime: true
            });
            
            const formattedResults = this.formatKuzuResults(kuzuResult);
            
            return {
              toolName: 'kuzu_query_graph',
              input: question,
              output: `Query: ${cypherQuery.cypher}\n\nResults (${kuzuResult.nodes.length} nodes, ${kuzuResult.relationships.length} relationships, execution time: ${kuzuResult.executionTime.toFixed(2)}ms):\n${formattedResults}\n\nExplanation: ${cypherQuery.explanation}`,
              success: true
            };
          }
        }
      } catch (kuzuError) {
        console.warn('KuzuDB query failed, falling back to in-memory:', kuzuError);
      }
      
      // Fallback to in-memory GraphQueryEngine
      const { GraphQueryEngine } = await import('../core/graph/query-engine.ts');
      const queryEngine = new GraphQueryEngine(this.context!.graph);
      
      // Execute the actual Cypher query
      const queryResult = queryEngine.executeQuery(cypherQuery.cypher, { limit: 10 });
      
      // Format the results for the LLM
      let formattedResults = '';
      if (queryResult.data.length > 0) {
        formattedResults = queryResult.data.map((row, index) => {
          const entries = Object.entries(row);
          if (entries.length === 0) return `Result ${index + 1}: (no data)`;
          
          return entries.map(([key, value]) => {
            if (typeof value === 'object' && value !== null && 'properties' in value) {
              // This is a node object
              const node = value as GraphNode;
              return `${key}: ${node.label} "${node.properties.name || node.properties.filePath || node.id}"`;
            }
            return `${key}: ${value}`;
          }).join(', ');
        }).join('\n');
      } else {
        formattedResults = 'No results found';
      }
      
      return {
        toolName: 'query_graph',
        input: question,
        output: `Query: ${cypherQuery.cypher}\n\nResults (${queryResult.data.length} found):\n${formattedResults}\n\nExplanation: ${cypherQuery.explanation}`,
        success: true
      };
    } catch (error) {
      return {
        toolName: 'query_graph',
        input: question,
        output: '',
        success: false,
        error: error instanceof Error ? error.message : 'Query execution failed'
      };
    }
  }

  /**
   * Format KuzuDB query results for display
   */
  private formatKuzuResults(result: { nodes: Array<{ label: string; properties: Record<string, unknown>; id: string }>; relationships: Array<{ type: string; source: string; target: string }> }): string {
    const nodeResults = result.nodes.slice(0, 10).map((node, index) => 
      `${index + 1}. ${node.label}: "${(node.properties.name as string) || node.id}"`
    ).join('\n');
    
    const relResults = result.relationships.slice(0, 10).map((rel, index) => 
      `${index + 1}. ${rel.type}: ${rel.source} -> ${rel.target}`
    ).join('\n');
    
    let output = '';
    if (result.nodes.length > 0) {
      output += `Nodes (${result.nodes.length}):\n${nodeResults}`;
      if (result.nodes.length > 10) output += '\n... (more nodes)';
    }
    
    if (result.relationships.length > 0) {
      if (output) output += '\n\n';
      output += `Relationships (${result.relationships.length}):\n${relResults}`;
      if (result.relationships.length > 10) output += '\n... (more relationships)';
    }
    
    return output || 'No results found';
  }

  /**
   * Get code content from a file
   */
  private async getCodeContent(filePath: string): Promise<ToolResult> {
    if (!this.context) {
      return {
        toolName: 'get_code',
        input: filePath,
        output: '',
        success: false,
        error: 'No context available'
      };
    }

    const content = this.context.fileContents.get(filePath);
    if (!content) {
      // Try to find similar file paths
      const similarFiles = Array.from(this.context.fileContents.keys())
        .filter(path => path.includes(filePath) || filePath.includes(path))
        .slice(0, 3);

      if (similarFiles.length > 0) {
        return {
          toolName: 'get_code',
          input: filePath,
          output: `File not found. Similar files available: ${similarFiles.join(', ')}`,
          success: false,
          error: 'File not found'
        };
      }

      return {
        toolName: 'get_code',
        input: filePath,
        output: 'File not found',
        success: false,
        error: 'File not found'
      };
    }

    return {
      toolName: 'get_code',
      input: filePath,
      output: `File: ${filePath}\n\n${content}`,
      success: true
    };
  }

  /**
   * Search for files matching a pattern
   */
  private async searchFiles(pattern: string): Promise<ToolResult> {
    if (!this.context) {
      return {
        toolName: 'search_files',
        input: pattern,
        output: '',
        success: false,
        error: 'No context available'
      };
    }

    const matchingFiles: string[] = [];
    const lowerPattern = pattern.toLowerCase();

    // Search in file paths
    for (const filePath of this.context.fileContents.keys()) {
      if (filePath.toLowerCase().includes(lowerPattern)) {
        matchingFiles.push(filePath);
      }
    }

    // Search in file contents
    for (const [filePath, content] of this.context.fileContents.entries()) {
      if (!matchingFiles.includes(filePath) && 
          content.toLowerCase().includes(lowerPattern)) {
        matchingFiles.push(filePath);
      }
    }

    return {
      toolName: 'search_files',
      input: pattern,
      output: matchingFiles.length > 0 
        ? `Found ${matchingFiles.length} files:\n${matchingFiles.slice(0, 10).join('\n')}${matchingFiles.length > 10 ? '\n... and more' : ''}`
        : 'No files found matching the pattern',
      success: true
    };
  }

  /**
   * Extract Cypher queries from tool results
   */
  private extractCypherQueries(toolResult: ToolResult): CypherQuery[] {
    const queries: CypherQuery[] = [];
    const queryMatch = toolResult.output.match(/Query: (.*?)(?=\n|$)/);
    
    if (queryMatch) {
      queries.push({
        cypher: queryMatch[1],
        explanation: 'Generated during reasoning',
        confidence: 0.8
      });
    }

    return queries;
  }

  /**
   * Extract sources from tool results
   */
  private extractSources(toolResult: ToolResult): string[] {
    const sources: string[] = [];
    const fileMatch = toolResult.output.match(/File: (.*?)(?=\n|$)/);
    
    if (fileMatch) {
      sources.push(fileMatch[1]);
    }

    return sources;
  }

  /**
   * Calculate confidence based on reasoning quality
   */
  private calculateConfidence(reasoning: ReasoningStep[], queries: CypherQuery[]): number {
    let confidence = 0.5;

    // Boost confidence for successful tool usage
    const successfulSteps = reasoning.filter(step => step.toolResult?.success).length;
    confidence += (successfulSteps / reasoning.length) * 0.3;

    // Boost confidence for high-quality queries
    const avgQueryConfidence = queries.length > 0 
      ? queries.reduce((sum, q) => sum + q.confidence, 0) / queries.length
      : 0.5;
    confidence += avgQueryConfidence * 0.2;

    // Cap at reasonable bounds
    return Math.min(0.95, Math.max(0.1, confidence));
  }

  /**
   * Build summary prompt for incomplete reasoning
   */
  private buildSummaryPrompt(question: string, reasoning: ReasoningStep[]): string {
    const observations = reasoning
      .map(step => `Step ${step.step}: ${step.observation}`)
      .join('\n');

    return `Based on the following observations from your reasoning process, please provide a final answer to the question: "${question}"

Observations:
${observations}

Final Answer:`;
  }

  /**
   * Get current context information
   */
  public getContextInfo(): { nodeCount: number; fileCount: number; hasContext: boolean } {
    if (!this.context) {
      return { nodeCount: 0, fileCount: 0, hasContext: false };
    }

    return {
      nodeCount: this.context.graph.nodes.length,
      fileCount: this.context.fileContents.size,
      hasContext: true
    };
  }

  /**
   * Test the orchestrator with a simple query (for debugging)
   */
  public async testOrchestrator(llmConfig: LLMConfig): Promise<{ success: boolean; error?: string; response?: RAGResponse }> {
    if (!this.context) {
      return { success: false, error: 'No context set' };
    }

    try {
      const testQuestion = "How many functions are in this project?";
      const response = await this.answerQuestion(testQuestion, llmConfig, { 
        maxReasoningSteps: 2, 
        includeReasoning: true 
      });
      
      return { success: true, response };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }
} 
