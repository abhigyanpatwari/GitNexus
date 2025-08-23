import { ReActAgent } from './react-agent';
import { KuzuQueryEngine } from '../core/graph/kuzu-query-engine';

// Mock implementations
const mockLLMService = {
  chat: async () => ({
    content: `Thought: I need to query the graph to find information about functions
Action: query_graph
Action Input: Find all functions in the codebase`,
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
    cypher: 'MATCH (f:Function) RETURN f.name, f.filePath LIMIT 10',
    explanation: 'Query to find all functions in the codebase',
    confidence: 0.9
  }),
  updateSchema: () => {}
};

// Mock KuzuQueryEngine
const mockKuzuQueryEngine = {
  initialize: jest.fn().mockResolvedValue(undefined),
  importGraph: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn().mockResolvedValue({
    nodes: [
      { id: 'func1', label: 'Function', properties: { name: 'testFunction', filePath: '/test.ts' } }
    ],
    relationships: [],
    resultCount: 1,
    executionTime: 5.2
  }),
  isReady: jest.fn().mockReturnValue(true)
};

describe('ReActAgent - KuzuDB Integration', () => {
  let reactAgent: ReActAgent;

  beforeEach(() => {
    reactAgent = new ReActAgent(mockLLMService as any, mockCypherGenerator as any, mockKuzuQueryEngine);
  });

  test('should initialize KuzuQueryEngine', async () => {
    await reactAgent.initialize();
    
    expect(mockKuzuQueryEngine.initialize).toHaveBeenCalled();
  });

  test('should import graph data into KuzuDB', async () => {
    const mockGraph = {
      nodes: [
        { id: 'func1', label: 'Function', properties: { name: 'testFunction' } }
      ],
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

    expect(mockKuzuQueryEngine.importGraph).toHaveBeenCalledWith(mockGraph);
  });

  test('should execute Cypher queries using KuzuDB', async () => {
    // Set up context
    const mockGraph = {
      nodes: [
        { id: 'func1', label: 'Function', properties: { name: 'testFunction' } }
      ],
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

    // Process a question that should trigger a graph query
    const result = await reactAgent.processQuestion('Find all functions in the codebase', {
      provider: 'openai' as const,
      apiKey: 'test-key'
    });

    // Verify that KuzuDB was used for query execution
    expect(mockKuzuQueryEngine.executeQuery).toHaveBeenCalledWith(
      'MATCH (f:Function) RETURN f.name, f.filePath LIMIT 10',
      { includeExecutionTime: true }
    );

    // Verify that the result contains the expected data
    expect(result.cypherQueries).toHaveLength(1);
    expect(result.cypherQueries[0].cypher).toBe('MATCH (f:Function) RETURN f.name, f.filePath LIMIT 10');
    expect(result.cypherQueries[0].confidence).toBe(0.9);
  });

  test('should handle KuzuDB query failures gracefully', async () => {
    // Mock KuzuDB to throw an error
    const mockKuzuQueryEngineWithError = {
      ...mockKuzuQueryEngine,
      executeQuery: jest.fn().mockRejectedValue(new Error('KuzuDB connection failed'))
    };

    const testAgent = new ReActAgent(mockLLMService as any, mockCypherGenerator as any, mockKuzuQueryEngineWithError);
    
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

    // Should handle the error gracefully
    const result = await testAgent.processQuestion('Find all functions', {
      provider: 'openai' as const,
      apiKey: 'test-key'
    });

    expect(result.answer).toBeDefined();
    expect(result.answer).not.toContain('Unknown action');
  });

  test('should fallback to placeholder when KuzuDB is not available', async () => {
    // Create agent without KuzuDB
    const testAgent = new ReActAgent(mockLLMService as any, mockCypherGenerator as any);
    
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

    // Should still work with placeholder
    const result = await testAgent.processQuestion('Find all functions', {
      provider: 'openai' as const,
      apiKey: 'test-key'
    });

    expect(result.answer).toBeDefined();
    expect(result.answer).not.toContain('Unknown action');
  });
});
