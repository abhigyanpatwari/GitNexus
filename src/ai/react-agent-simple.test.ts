import { ReActAgent } from './react-agent';

// Simple mock implementations
const mockLLMService = {
  chat: async () => ({
    content: `Thought: I need to search for files related to the user's question
Action: search_files
Action Input: react agent`,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
  }),
  getChatModel: () => ({
    invoke: async () => ({ content: 'Mock response' })
  }),
  getModel: function() {
    return this.getChatModel();
  }
};

const mockCypherGenerator = {
  generateQuery: async () => ({
    cypher: 'MATCH (n) RETURN n LIMIT 10',
    explanation: 'Mock query for testing',
    confidence: 0.8
  }),
  updateSchema: () => {}
};

describe('ReActAgent - Simple Tests', () => {
  let reactAgent: ReActAgent;

  beforeEach(() => {
    reactAgent = new ReActAgent(mockLLMService as any, mockCypherGenerator as any);
  });

  it('should initialize correctly', () => {
    expect(reactAgent).toBeInstanceOf(ReActAgent);
  });

  it('should set context correctly', () => {
    const mockGraph = {
      nodes: [],
      relationships: []
    };
    
    const mockFileContents = new Map<string, string>();
    mockFileContents.set('test.ts', 'console.log("test");');

    expect(async () => {
      await reactAgent.setContext({
        graph: mockGraph,
        fileContents: mockFileContents
      }, {
        provider: 'openai' as const,
        apiKey: 'test-key'
      });
    }).not.toThrow();
  });

  it('should throw error when processing question without context', async () => {
    const llmConfig = {
      provider: 'openai' as const,
      apiKey: 'test-key'
    };

    await expect(
      reactAgent.processQuestion('test question', llmConfig)
    ).rejects.toThrow('Context not set');
  });

  it('should process question with context', async () => {
    const mockGraph = {
      nodes: [],
      relationships: []
    };
    
    const mockFileContents = new Map<string, string>();
    mockFileContents.set('test.ts', 'console.log("test");');

    await reactAgent.setContext({
      graph: mockGraph,
      fileContents: mockFileContents
    }, {
      provider: 'openai' as const,
      apiKey: 'test-key'
    });

    const llmConfig = {
      provider: 'openai' as const,
      apiKey: 'test-key'
    };

    const result = await reactAgent.processQuestion('test question', llmConfig);
    
    expect(result).toHaveProperty('answer');
    expect(result).toHaveProperty('reasoning');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('sources');
    expect(Array.isArray(result.reasoning)).toBe(true);
    expect(Array.isArray(result.sources)).toBe(true);
    expect(typeof result.confidence).toBe('number');
  });

  it('should handle ReAct reasoning steps correctly', async () => {
    const mockGraph = {
      nodes: [],
      relationships: []
    };
    
    const mockFileContents = new Map<string, string>();
    mockFileContents.set('test.ts', 'console.log("test");');

    await reactAgent.setContext({
      graph: mockGraph,
      fileContents: mockFileContents
    }, {
      provider: 'openai' as const,
      apiKey: 'test-key'
    });

    const llmConfig = {
      provider: 'openai' as const,
      apiKey: 'test-key'
    };

    const result = await reactAgent.processQuestion('test question', llmConfig);
    
    // Should have at least one reasoning step
    expect(result.reasoning.length).toBeGreaterThan(0);
    
    // Check structure of reasoning steps
    const firstStep = result.reasoning[0];
    expect(firstStep).toHaveProperty('step');
    expect(firstStep).toHaveProperty('thought');
    expect(firstStep).toHaveProperty('action');
    expect(typeof firstStep.step).toBe('number');
    expect(typeof firstStep.thought).toBe('string');
    expect(typeof firstStep.action).toBe('string');
  });
});
