import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { LLMService, LLMConfig } from './llm-service.ts';
import type { CypherGenerator } from './cypher-generator.ts';
import type { KnowledgeGraph } from '../core/graph/types.ts';

export interface ReActContext {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
}

export interface ReActToolResult {
  toolName: string;
  input: string;
  output: string;
  success: boolean;
  error?: string;
}

export interface ReActStep {
  step: number;
  thought: string;
  action: string;
  actionInput?: string;
  observation?: string;
  toolResult?: ReActToolResult;
}

export interface ReActResult {
  answer: string;
  reasoning: ReActStep[];
  confidence: number;
  sources: string[];
  cypherQueries: Array<{
    cypher: string;
    explanation: string;
    confidence: number;
  }>;
}

export interface ReActOptions {
  maxIterations?: number;
  temperature?: number;
  strictMode?: boolean;
  includeReasoning?: boolean;
  enableQueryCaching?: boolean;
  similarityThreshold?: number;
}

// Define Zod schema for ReAct step
const ReActStepSchema = z.object({
  thought: z.string().describe("The reasoning process - what you're thinking about"),
  action: z.string().describe("The action to take (query_graph, get_code, search_files, or final_answer)"),
  actionInput: z.string().describe("Input for the action - the query, file path, search pattern, or final answer")
});

export class ReActAgent {
  private llmService: LLMService;
  private cypherGenerator: CypherGenerator;
  private context: ReActContext | null = null;
  private conversationHistory: any[] = [];

  constructor(llmService: LLMService, cypherGenerator: CypherGenerator, _kuzuQueryEngine?: any) {
    this.llmService = llmService;
    this.cypherGenerator = cypherGenerator;
  }

  /**
   * Initialize the ReAct agent
   */
  public async initialize(): Promise<void> {
    // Initialize any required components
    console.log('ReActAgent initialized');
  }

  /**
   * Get conversation history
   */
  public async getConversationHistory(): Promise<any[]> {
    return this.conversationHistory;
  }

  /**
   * Clear conversation history
   */
  public async clearConversationHistory(): Promise<void> {
    this.conversationHistory = [];
  }

  /**
   * Set the context for ReAct operations
   */
  public async setContext(context: ReActContext & { projectName?: string; sessionId?: string }, _llmConfig: LLMConfig): Promise<void> {
    this.context = {
      graph: context.graph,
      fileContents: context.fileContents
    };
    this.cypherGenerator.updateSchema(context.graph);
  }

  /**
   * Process a question using ReAct pattern
   */
  public async processQuestion(
    question: string,
    llmConfig: LLMConfig,
    options: ReActOptions = {}
  ): Promise<ReActResult> {
    if (!this.context) {
      throw new Error('Context not set. Call setContext() first.');
    }

    const {
      maxIterations = 5,
      temperature = 0.1,
      strictMode = false,
      includeReasoning = true
    } = options;

    const reasoning: ReActStep[] = [];
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

      while (currentStep <= maxIterations) {
        let reasoning_step: ReActStep;
        
        try {
          // Try using structured output first
          const model = this.llmService.getModel(reasoningConfig);
          if (model && typeof model.withStructuredOutput === 'function') {
            const structuredModel = model.withStructuredOutput(ReActStepSchema);
            const structuredResponse = await structuredModel.invoke(conversation);
            
            reasoning_step = {
              step: currentStep,
              thought: structuredResponse.thought,
              action: structuredResponse.action,
              actionInput: structuredResponse.actionInput
            };
          } else {
            // Fallback to regular chat + regex parsing
            const response = await this.llmService.chat(reasoningConfig, conversation);
            reasoning_step = this.parseReasoningStep(String(response.content || ''), currentStep);
          }
        } catch (error) {
          // Fallback to regex parsing if structured output fails
          console.warn('Structured output failed, falling back to regex parsing:', error);
          const response = await this.llmService.chat(reasoningConfig, conversation);
          reasoning_step = this.parseReasoningStep(String(response.content || ''), currentStep);
        }

        reasoning.push(reasoning_step);

        // Check if we have a final answer
        if (reasoning_step.action === 'final_answer') {
          finalAnswer = reasoning_step.actionInput || '';
          confidence = Math.min(0.9, confidence + 0.2);
          break;
        }

        // Execute the action
        const toolResult = await this.executeAction(reasoning_step.action, reasoning_step.actionInput || '', llmConfig);
        reasoning_step.toolResult = toolResult;
        reasoning_step.observation = toolResult.output;

        // Add sources if successful
        if (toolResult.success && toolResult.output) {
          sources.push(`${reasoning_step.action}: ${reasoning_step.actionInput}`);
        }

        // Add the tool result to conversation
        conversation.push(new AIMessage(`Thought: ${reasoning_step.thought}\nAction: ${reasoning_step.action}\nAction Input: ${reasoning_step.actionInput}`));
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
        confidence,
        sources: Array.from(new Set(sources)), // Remove duplicates
        cypherQueries: [] // TODO: Track actual Cypher queries
      };

    } catch (error) {
      throw new Error(`ReAct processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Build the ReAct system prompt
   */
  private buildReActSystemPrompt(strictMode: boolean): string {
    const prompt = `You are an expert code analyst using a ReAct (Reasoning + Acting) approach to answer questions about a codebase.

You have access to the following tools:
1. query_graph: Query the code knowledge graph using natural language
2. get_code: Retrieve the source code content of a specific file
3. search_files: Search for files matching a pattern or containing specific text
4. final_answer: Provide the final answer to the user's question

IMPORTANT INSTRUCTIONS:
- Think step by step and provide your reasoning in the "thought" field
- Choose the appropriate action from the available tools
- Provide the necessary input for the chosen action
- Use the tools to gather information before providing final answers
- Be precise and thorough in your analysis
- Cite specific files and code snippets when possible

${strictMode ? 'STRICT MODE: Only use exact matches and precise queries.' : 'FLEXIBLE MODE: Use heuristic matching when exact matches fail.'}

You must respond with a structured output containing:
- thought: Your reasoning process for this step
- action: The tool you want to use (query_graph, get_code, search_files, or final_answer)
- actionInput: The input for the chosen tool

When providing a final_answer, make sure to give a complete, comprehensive response in the actionInput field.`;

    return prompt;
  }

  /**
   * Parse a reasoning step from LLM response
   */
  private parseReasoningStep(response: string, stepNumber: number): ReActStep {
    const thoughtMatch = response.match(/Thought:\s*(.*?)(?=\nAction:|$)/);
    const actionMatch = response.match(/Action:\s*(.*?)(?=\nAction Input:|$)/);
    const actionInputMatch = response.match(/Action Input:\s*([\s\S]*?)(?=\nThought:|$)/);

    return {
      step: stepNumber,
      thought: thoughtMatch ? thoughtMatch[1].trim() : '',
      action: actionMatch ? actionMatch[1].trim() : '',
      actionInput: actionInputMatch ? actionInputMatch[1].trim() : ''
    };
  }

  /**
   * Execute an action and return the result
   */
  private async executeAction(action: string, input: string, llmConfig: LLMConfig): Promise<ReActToolResult> {
    try {
      let output = '';
      let success = false;

      switch (action) {
        case 'query_graph':
          if (!this.context) {
            throw new Error('Context not set');
          }
          
          try {
            const cypherQuery = await this.cypherGenerator.generateQuery(input, llmConfig, {
              maxRetries: 3
            });
            
            // Execute the query (placeholder - implement based on your graph engine)
            const results = await this.executeGraphQuery(cypherQuery.cypher);
            output = JSON.stringify(results, null, 2);
            success = true;
          } catch (error) {
            output = `Error generating or executing query: ${error instanceof Error ? error.message : 'Unknown error'}`;
            success = false;
          }
          break;

        case 'get_code':
          if (!this.context) {
            throw new Error('Context not set');
          }
          
          const content = this.context.fileContents.get(input);
          if (content) {
            output = content;
            success = true;
          } else {
            output = `File not found: ${input}`;
            success = false;
          }
          break;

        case 'search_files':
          if (!this.context) {
            throw new Error('Context not set');
          }
          
          const matchingFiles: string[] = [];
          for (const [filePath] of this.context.fileContents) {
            if (filePath.toLowerCase().includes(input.toLowerCase())) {
              matchingFiles.push(filePath);
            }
          }
          
          output = JSON.stringify(matchingFiles, null, 2);
          success = true;
          break;

        case 'final_answer':
          output = input;
          success = true;
          break;

        default:
          output = `Unknown action: ${action}`;
          success = false;
      }

      return {
        toolName: action,
        input,
        output,
        success
      };

    } catch (error) {
      return {
        toolName: action,
        input,
        output: `Error executing action: ${error instanceof Error ? error.message : 'Unknown error'}`,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Execute a graph query (placeholder - implement based on your graph engine)
   */
  private async executeGraphQuery(cypherQuery: string): Promise<Record<string, unknown>> {
    // This is a placeholder - implement based on your graph engine
    console.log('Executing Cypher query:', cypherQuery);
    
    // For now, return a mock result
    return {
      nodes: [],
      relationships: [],
      message: 'Graph query executed (placeholder implementation)',
      query: cypherQuery
    };
  }

  /**
   * Build summary prompt for incomplete reasoning
   */
  private buildSummaryPrompt(question: string, reasoning: ReActStep[]): string {
    const observations = reasoning
      .filter(step => step.observation)
      .map(step => `Step ${step.step}: ${step.observation}`)
      .join('\n');

    return `Based on the following observations from my analysis, please provide a comprehensive answer to the original question: "${question}"

Observations:
${observations}

Please synthesize this information into a clear and helpful answer.`;
  }
} 
