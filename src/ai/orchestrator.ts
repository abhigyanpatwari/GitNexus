import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { LLMService, LLMConfig } from './llm-service.ts';
import type { CypherGenerator, CypherQuery } from './cypher-generator.ts';
import type { KnowledgeGraph, GraphNode } from '../core/graph/types.ts';

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
        const reasoning_step = this.parseReasoningStep(response.content, currentStep);

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
        conversation.push(new AIMessage(response.content));
        conversation.push(new HumanMessage(`Observation: ${toolResult.output}`));

        currentStep++;
      }

      // If we didn't get a final answer, generate one based on the reasoning
      if (!finalAnswer && reasoning.length > 0) {
        const summaryPrompt = this.buildSummaryPrompt(question, reasoning);
        conversation.push(new HumanMessage(summaryPrompt));
        
        const summaryResponse = await this.llmService.chat(reasoningConfig, conversation);
        finalAnswer = summaryResponse.content;
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

${strictMode ? '\nSTRICT MODE: Only use information explicitly found in the tools. Do not infer or assume anything.' : ''}

Remember: Your goal is to provide accurate, evidence-based answers about the codebase.`;

    return prompt;
  }

  /**
   * Parse a reasoning step from LLM response
   */
  private parseReasoningStep(response: string, stepNumber: number): ReasoningStep {
    const thoughtMatch = response.match(/Thought:\s*(.*?)(?=\n|Action:|$)/s);
    const actionMatch = response.match(/Action:\s*(.*?)(?=\n|Action Input:|$)/s);
    const inputMatch = response.match(/Action Input:\s*(.*?)(?=\n|$)/s);

    return {
      step: stepNumber,
      thought: thoughtMatch?.[1]?.trim() || 'No thought provided',
      action: actionMatch?.[1]?.trim() || 'unknown',
      actionInput: inputMatch?.[1]?.trim() || '',
      observation: '' // Will be filled after tool execution
    };
  }

  /**
   * Execute a graph query using the Cypher generator
   */
  private async executeGraphQuery(question: string, llmConfig: LLMConfig): Promise<ToolResult> {
    try {
      const cypherQuery = await this.cypherGenerator.generateQuery(question, llmConfig);
      
      // For now, we'll simulate query execution since we don't have a real graph database
      // In a real implementation, this would execute the Cypher query against Neo4j or similar
      const mockResults = this.simulateGraphQuery(cypherQuery.cypher);
      
      return {
        toolName: 'query_graph',
        input: question,
        output: `Query: ${cypherQuery.cypher}\n\nResults:\n${mockResults}\n\nExplanation: ${cypherQuery.explanation}`,
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
   * Simulate graph query execution (placeholder for real implementation)
   */
  private simulateGraphQuery(cypher: string): string {
    if (!this.context) return 'No context available';

    // Simple simulation based on common patterns
    const upperCypher = cypher.toUpperCase();
    
    if (upperCypher.includes('FUNCTION') && upperCypher.includes('RETURN')) {
      const functions = this.context.graph.nodes
        .filter(n => n.label === 'Function')
        .slice(0, 5)
        .map(n => `${n.properties.name} (${n.properties.filePath})`)
        .join('\n');
      return functions || 'No functions found';
    }
    
    if (upperCypher.includes('CLASS') && upperCypher.includes('RETURN')) {
      const classes = this.context.graph.nodes
        .filter(n => n.label === 'Class')
        .slice(0, 5)
        .map(n => `${n.properties.name} (${n.properties.filePath})`)
        .join('\n');
      return classes || 'No classes found';
    }
    
    if (upperCypher.includes('FILE') && upperCypher.includes('RETURN')) {
      const files = this.context.graph.nodes
        .filter(n => n.label === 'File')
        .slice(0, 5)
        .map(n => n.properties.name)
        .join('\n');
      return files || 'No files found';
    }

    return 'Query executed successfully (simulated)';
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
} 
