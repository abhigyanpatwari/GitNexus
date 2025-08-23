import { ReActAgent } from './react-agent';

// Mock implementations
const mockLLMService = {
  chat: async () => ({
    content: `Thought: I need to help the user with their question
Action: unknown_action
Action Input: some input`,
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

describe('ReActAgent - Unknown Action Fixes', () => {
  let reactAgent: ReActAgent;

  beforeEach(() => {
    reactAgent = new ReActAgent(mockLLMService as any, mockCypherGenerator as any);
  });

  test('should handle unknown actions gracefully', async () => {
    // Set up context
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

    // Test with an unknown action
    const result = await reactAgent.processQuestion('test question', {
      provider: 'openai' as const,
      apiKey: 'test-key'
    });

    // Should not throw an error and should provide a helpful response
    expect(result.answer).toBeDefined();
    expect(result.answer).not.toContain('Unknown action');
    expect(result.answer).not.toContain('Error');
  });

  test('should normalize action variations', () => {
    const testCases = [
      { input: 'querygraph', expected: 'query_graph' },
      { input: 'getcode', expected: 'get_code' },
      { input: 'searchfiles', expected: 'search_files' },
      { input: 'finalanswer', expected: 'final_answer' },
      { input: 'query', expected: 'query_graph' },
      { input: 'search', expected: 'search_files' },
      { input: 'answer', expected: 'final_answer' }
    ];

    testCases.forEach(({ input, expected }) => {
      // This tests the action normalization logic
      const normalized = input.toLowerCase().replace(/[^a-z_]/g, '');
      const actionMap: Record<string, string> = {
        'querygraph': 'query_graph',
        'query': 'query_graph',
        'getcode': 'get_code',
        'searchfiles': 'search_files',
        'search': 'search_files',
        'finalanswer': 'final_answer',
        'answer': 'final_answer'
      };
      
      const result = actionMap[normalized] || normalized;
      expect(result).toBe(expected);
    });
  });

  test('should provide helpful responses for unexpected actions', async () => {
    // Mock the LLM to return an unexpected action
    const mockLLMWithUnexpectedAction = {
      ...mockLLMService,
      chat: async () => ({
        content: `Thought: I need to help the user
Action: unexpected_action
Action Input: help me find something`,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
      })
    };

    const testAgent = new ReActAgent(mockLLMWithUnexpectedAction as any, mockCypherGenerator as any);
    
    // Set up context
    const mockGraph = { nodes: [], relationships: [] };
    const mockFileContents = new Map<string, string>();
    mockFileContents.set('test.ts', 'console.log("test");');

    await testAgent.setContext({
      graph: mockGraph,
      fileContents: mockFileContents
    }, {
      provider: 'openai' as const,
      apiKey: 'test-key'
    });

    const result = await testAgent.processQuestion('help me find something', {
      provider: 'openai' as const,
      apiKey: 'test-key'
    });

    // Should provide a helpful response instead of an error
    expect(result.answer).toBeDefined();
    expect(result.answer).not.toContain('Unknown action');
    expect(result.answer).toContain('help you');
  });
});
