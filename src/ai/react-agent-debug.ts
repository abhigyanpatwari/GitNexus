import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { LLMService, LLMConfig } from './llm-service.ts';
import type { CypherGenerator } from './cypher-generator.ts';
import type { KnowledgeGraph } from '../core/graph/types.ts';
import type { LocalStorageChatHistory } from '../lib/chat-history.ts';

// Define Zod schema for ReAct step
const ReActStepSchema = z.object({
  thought: z.string().describe("The reasoning process - what you're thinking about"),
  action: z.enum(['query_graph', 'get_code', 'search_files', 'final_answer']).describe("The action to take - must be one of: query_graph, get_code, search_files, or final_answer"),
  actionInput: z.string().describe("Input for the action - the query, file path, search pattern, or final answer")
});

export async function debugStructuredOutput(llmService: LLMService, llmConfig: LLMConfig) {
  console.log('=== DEBUGGING STRUCTURED OUTPUT ===');
  
  try {
    const model = llmService.getModel(llmConfig);
    console.log('Model type:', model.constructor.name);
    console.log('Model supports withStructuredOutput:', typeof model.withStructuredOutput === 'function');
    
    if (typeof model.withStructuredOutput === 'function') {
      console.log('Attempting to create structured model...');
      const structuredModel = model.withStructuredOutput(ReActStepSchema);
      console.log('Structured model created successfully');
      
      // Test with a simple prompt
      const testMessages = [
        new SystemMessage('You are a helpful assistant. Respond with a structured output.'),
        new HumanMessage('Think about searching for files and respond with the appropriate action.')
      ];
      
      console.log('Testing structured output...');
      const response = await structuredModel.invoke(testMessages);
      console.log('Structured output response:', response);
      
      return { success: true, response };
    } else {
      console.log('Model does not support structured output');
      return { success: false, reason: 'Model does not support withStructuredOutput' };
    }
  } catch (error) {
    console.error('Error in structured output:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
