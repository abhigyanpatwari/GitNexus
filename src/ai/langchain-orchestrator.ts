// @ts-expect-error - npm: imports are resolved at runtime in Deno
import { createReactAgent } from 'npm:@langchain/langgraph/prebuilt';
// @ts-expect-error - npm: imports are resolved at runtime in Deno
import { MemorySaver } from 'npm:@langchain/langgraph';
// @ts-expect-error - npm: imports are resolved at runtime in Deno
import { tool } from 'npm:@langchain/core/tools';
// @ts-expect-error - npm: imports are resolved at runtime in Deno
import { z } from 'npm:zod';
// @ts-expect-error - npm: imports are resolved at runtime in Deno
import { SystemMessage } from 'npm:@langchain/core/messages';
import type { LLMService, LLMConfig } from './llm-service.ts';
import type { CypherGenerator } from './cypher-generator.ts';
import type { KnowledgeGraph } from '../core/graph/types.ts';

export interface LangChainRAGContext {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
}

export interface LangChainRAGResponse {
  answer: string;
  sources: string[];
  confidence: number;
  toolCalls: Array<{
    tool: string;
    input: any;
    output: string;
  }>;
}

export interface LangChainRAGOptions {
  maxIterations?: number;
  temperature?: number;
  enableMemory?: boolean;
  threadId?: string;
}

export class LangChainRAGOrchestrator {
  private llmService: LLMService;
  private cypherGenerator: CypherGenerator;
  private context: LangChainRAGContext | null = null;
  private agent: any = null;
  private memory: any = null;

  constructor(llmService: LLMService, cypherGenerator: CypherGenerator) {
    this.llmService = llmService;
    this.cypherGenerator = cypherGenerator;
    this.memory = new MemorySaver();
  }

  /**
   * Set the current context and initialize the agent
   */
  public async setContext(context: LangChainRAGContext, llmConfig: LLMConfig): Promise<void> {
    this.context = context;
    this.cypherGenerator.updateSchema(context.graph);

    // Create LangChain-compliant tools
    const tools = this.createTools(llmConfig);

    // Get the LLM from our service
    const llm = this.llmService.getChatModel(llmConfig);

    // Create system message for ReAct behavior
    const systemMessage = this.buildSystemMessage();

    // Create the ReAct agent using LangGraph
    this.agent = createReactAgent({
      llm,
      tools,
      messageModifier: systemMessage,
      checkpointSaver: this.memory
    });
  }

  /**
   * Answer a question using the LangChain ReAct agent
   */
  public async answerQuestion(
    question: string,
    options: LangChainRAGOptions = {}
  ): Promise<LangChainRAGResponse> {
    if (!this.agent || !this.context) {
      throw new Error('Agent not initialized. Call setContext() first.');
    }

    const {
      maxIterations = 10,
      enableMemory = false,
      threadId = 'default'
    } = options;

    try {
      const config = enableMemory 
        ? { 
            configurable: { thread_id: threadId },
            recursionLimit: maxIterations
          }
        : { recursionLimit: maxIterations };

      // Stream the agent execution
      const stream = await this.agent.stream(
        { messages: [{ role: "user", content: question }] },
        config
      );

      let finalAnswer = '';
      const toolCalls: Array<{ tool: string; input: any; output: string }> = [];
      const sources: string[] = [];

      // Process the stream
      for await (const chunk of stream) {
        if (chunk.agent) {
          const lastMessage = chunk.agent.messages[chunk.agent.messages.length - 1];
          if (lastMessage.content) {
            finalAnswer = lastMessage.content;
          }
        } else if (chunk.tools) {
          const toolMessage = chunk.tools.messages[chunk.tools.messages.length - 1];
          if (toolMessage.tool_calls) {
            toolMessage.tool_calls.forEach((toolCall: any) => {
              toolCalls.push({
                tool: toolCall.name,
                input: toolCall.args,
                output: toolMessage.content || ''
              });

              // Extract sources from tool calls
              if (toolCall.name === 'get_code_content') {
                sources.push(toolCall.args.filePath);
              }
            });
          }
        }
      }

      // Calculate confidence based on successful tool usage
      const confidence = this.calculateConfidence(toolCalls);

      return {
        answer: finalAnswer || 'I was unable to find a complete answer to your question.',
        sources: Array.from(new Set(sources)),
        confidence,
        toolCalls
      };

    } catch (error) {
      throw new Error(`LangChain RAG orchestration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Create LangChain-compliant tools
   */
  private createTools(llmConfig: LLMConfig) {
    const queryGraphTool = tool(
      async (input: { question: string }) => {
        try {
          const cypherQuery = await this.cypherGenerator.generateQuery(input.question, llmConfig);
          const mockResults = this.simulateGraphQuery(cypherQuery.cypher);
          
          return `Query: ${cypherQuery.cypher}\n\nResults:\n${mockResults}\n\nExplanation: ${cypherQuery.explanation}`;
        } catch (error) {
          return `Error generating graph query: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      },
      {
        name: "query_graph",
        description: "Query the code knowledge graph using natural language. Use this to find information about code structure, relationships, functions, classes, etc.",
        schema: z.object({
          question: z.string().describe("Natural language question about the codebase")
        })
      }
    );

    const getCodeContentTool = tool(
      async (input: { filePath: string }) => {
        if (!this.context) {
          return 'No context available';
        }

        const content = this.context.fileContents.get(input.filePath);
        if (!content) {
          // Try to find similar file paths
          const similarFiles = Array.from(this.context.fileContents.keys())
            .filter(path => path.includes(input.filePath) || input.filePath.includes(path))
            .slice(0, 3);

          if (similarFiles.length > 0) {
            return `File not found. Similar files available: ${similarFiles.join(', ')}`;
          }
          return 'File not found';
        }

        return `File: ${input.filePath}\n\n${content}`;
      },
      {
        name: "get_code_content",
        description: "Retrieve the source code content of a specific file. Use this when you need to examine the actual code implementation.",
        schema: z.object({
          filePath: z.string().describe("The path to the file whose content you want to retrieve")
        })
      }
    );

    const searchFilesTool = tool(
      async (input: { pattern: string }) => {
        if (!this.context) {
          return 'No context available';
        }

        const matchingFiles: string[] = [];
        const lowerPattern = input.pattern.toLowerCase();

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

        return matchingFiles.length > 0 
          ? `Found ${matchingFiles.length} files:\n${matchingFiles.slice(0, 10).join('\n')}${matchingFiles.length > 10 ? '\n... and more' : ''}`
          : 'No files found matching the pattern';
      },
      {
        name: "search_files",
        description: "Search for files matching a pattern or containing specific text. Use this to find relevant files in the codebase.",
        schema: z.object({
          pattern: z.string().describe("Search pattern or text to look for in file names or content")
        })
      }
    );

    return [queryGraphTool, getCodeContentTool, searchFilesTool];
  }

  /**
   * Build system message for ReAct behavior
   */
  private buildSystemMessage(): SystemMessage {
    const systemPrompt = `You are an expert code analyst that helps users understand codebases by using available tools.

You have access to the following tools:
1. query_graph: Query the code knowledge graph using natural language
2. get_code_content: Retrieve the source code content of a specific file  
3. search_files: Search for files matching a pattern or containing specific text

IMPORTANT GUIDELINES:
- Always think step by step about what information you need
- Use tools to gather factual information before providing answers
- Base your responses ONLY on information retrieved from tools
- If you cannot find information, say so explicitly
- Provide helpful, accurate answers about the codebase structure and functionality
- When referencing code, always cite the specific files you examined

Your goal is to provide accurate, evidence-based answers about the codebase using the available tools.`;

    return new SystemMessage(systemPrompt);
  }

  /**
   * Simulate graph query execution (same as before)
   */
  private simulateGraphQuery(cypher: string): string {
    if (!this.context) return 'No context available';

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
   * Calculate confidence based on tool usage
   */
  private calculateConfidence(toolCalls: Array<{ tool: string; input: any; output: string }>): number {
    if (toolCalls.length === 0) return 0.3;

    const successfulCalls = toolCalls.filter(call => 
      !call.output.includes('Error') && 
      !call.output.includes('not found') &&
      call.output.length > 10
    ).length;

    const baseConfidence = 0.5;
    const toolBonus = (successfulCalls / toolCalls.length) * 0.4;
    
    return Math.min(0.95, Math.max(0.1, baseConfidence + toolBonus));
  }

  /**
   * Get current context information
   */
  public getContextInfo(): { nodeCount: number; fileCount: number; hasContext: boolean; hasAgent: boolean } {
    return {
      nodeCount: this.context?.graph.nodes.length || 0,
      fileCount: this.context?.fileContents.size || 0,
      hasContext: !!this.context,
      hasAgent: !!this.agent
    };
  }

  /**
   * Clear memory for a specific thread
   */
  public async clearMemory(threadId: string): Promise<void> {
    if (this.memory) {
      // Note: MemorySaver doesn't have a direct clear method in the current API
      // This would need to be implemented based on the specific memory backend
      console.log(`Memory clearing not implemented for thread: ${threadId}`);
    }
  }
} 