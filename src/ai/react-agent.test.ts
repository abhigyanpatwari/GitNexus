import { ReActAgent } from './react-agent';
import { LLMService } from './llm-service';
import { CypherGenerator } from './cypher-generator';

// Mock the LLM service for testing
jest.mock('./llm-service');
jest.mock('./cypher-generator');

describe('ReActAgent Structured Output', () => {
  let reactAgent: ReActAgent;
  let mockLLMService: jest.Mocked<LLMService>;
  let mockCypherGenerator: jest.Mocked<CypherGenerator>;

  beforeEach(() => {
    mockLLMService = new LLMService() as jest.Mocked<LLMService>;
    mockCypherGenerator = new CypherGenerator(mockLLMService) as jest.Mocked<CypherGenerator>;
    reactAgent = new ReActAgent(mockLLMService, mockCypherGenerator);
  });

  test('should use structured output when available', async () => {
    // Mock the model to support structured output
    const mockModel = {
      withStructuredOutput: jest.fn().mockReturnValue({
        invoke: jest.fn().mockResolvedValue({
          thought: 'I need to search for files',
          action: 'search_files',
          actionInput: 'test'
        })
      })
    };

    mockLLMService.getModel = jest.fn().mockReturnValue(mockModel);

    // Mock context
    const mockContext = {
      graph: { nodes: [], relationships: [] },
      fileContents: new Map([['test.ts', 'console.log("test")']])
    };

    await reactAgent.setContext(mockContext, {
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini'
    });

    // Test the process
    const result = await reactAgent.processQuestion('Find test files', {
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini'
    });

    expect(mockModel.withStructuredOutput).toHaveBeenCalled();
    expect(result.reasoning.length).toBeGreaterThan(0);
  });

  test('should fallback to regex parsing when structured output fails', async () => {
    // Mock the model to not support structured output
    const mockModel = {
      withStructuredOutput: undefined
    };

    mockLLMService.getModel = jest.fn().mockReturnValue(mockModel);
    mockLLMService.chat = jest.fn().mockResolvedValue({
      content: 'Thought: I need to search\nAction: search_files\nAction Input: test'
    });

    // Mock context
    const mockContext = {
      graph: { nodes: [], relationships: [] },
      fileContents: new Map([['test.ts', 'console.log("test")']])
    };

    await reactAgent.setContext(mockContext, {
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini'
    });

    // Test the process
    const result = await reactAgent.processQuestion('Find test files', {
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini'
    });

    expect(mockLLMService.chat).toHaveBeenCalled();
    expect(result.reasoning.length).toBeGreaterThan(0);
  });
}); 