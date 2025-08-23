// Mock KuzuDB dependencies for Jest
jest.mock('../core/kuzu/kuzu-loader', () => ({
  initKuzuDB: jest.fn().mockResolvedValue({
    createDatabase: jest.fn().mockResolvedValue(undefined),
    executeQuery: jest.fn().mockResolvedValue({
      nodes: [],
      relationships: [],
      count: 0
    })
  })
}));

jest.mock('../services/kuzu.service', () => ({
  KuzuService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    insertNode: jest.fn().mockResolvedValue(undefined),
    insertRelationship: jest.fn().mockResolvedValue(undefined),
    executeQuery: jest.fn().mockResolvedValue({
      nodes: [],
      relationships: [],
      count: 0
    })
  }))
}));

import { KuzuKnowledgeGraph } from '../core/graph/kuzu-knowledge-graph';
import { KuzuGraphPipeline } from '../core/ingestion/kuzu-pipeline';
import type { GraphNode, GraphRelationship, NodeLabel, RelationshipType } from '../core/graph/types';

describe('KuzuDB Integration', () => {
  describe('End-to-End Pipeline', () => {
    it('should process files through KuzuDB pipeline', async () => {
      const pipeline = new KuzuGraphPipeline();
      
      // Mock file data
      const mockFileContents = new Map<string, string>([
        ['src/test.ts', 'function testFunction() { return "test"; }'],
        ['src/helper.ts', 'export function helper() { return "help"; }']
      ]);
      
      const mockFilePaths = ['src/test.ts', 'src/helper.ts'];
      
      const input = {
        projectRoot: '/',
        projectName: 'test-project',
        filePaths: mockFilePaths,
        fileContents: mockFileContents,
        options: {
          useParallelProcessing: false
        }
      };
      
      const result = await pipeline.run(input);
      
      expect(result).toBeDefined();
      expect(typeof result.getNodeCount).toBe('function');
      expect(typeof result.getRelationshipCount).toBe('function');
      expect(typeof result.executeQuery).toBe('function');
    });
  });

  describe('ChatInterface Compatibility', () => {
    it('should work with ChatInterface graph prop', async () => {
      const graph = new KuzuKnowledgeGraph();
      await graph.initialize();
      
      // Add some test data
      const testNode: GraphNode = {
        id: 'test-node',
        label: 'Function' as NodeLabel,
        properties: {
          name: 'testFunction',
          filePath: '/test.ts'
        }
      };
      
      await graph.addNode(testNode);
      
      // Verify the graph has the expected interface
      expect(graph.getNodeCount()).toBe(1);
      expect(typeof graph.executeQuery).toBe('function');
      
      // This should be compatible with ChatInterface
      const graphForChat = graph as any;
      expect(graphForChat).toBeDefined();
    });
  });

  describe('Performance Comparison', () => {
    it('should demonstrate performance benefits', async () => {
      const graph = new KuzuKnowledgeGraph();
      await graph.initialize();
      
      const startTime = Date.now();
      
      // Add 100 nodes (simulating direct KuzuDB insertion)
      for (let i = 0; i < 100; i++) {
        await graph.addNode({
          id: `node-${i}`,
          label: 'Function' as NodeLabel,
          properties: {
            name: `function${i}`,
            filePath: `/file${i}.ts`
          }
        });
      }
      
      const endTime = Date.now();
      const processingTime = endTime - startTime;
      
      expect(graph.getNodeCount()).toBe(100);
      expect(processingTime).toBeLessThan(5000); // Should be fast
      
      console.log(`KuzuDB: Added 100 nodes in ${processingTime}ms`);
    });
  });

  describe('Query Execution', () => {
    it('should execute Cypher queries', async () => {
      const graph = new KuzuKnowledgeGraph();
      await graph.initialize();
      
      // Add test data
      await graph.addNode({
        id: 'test-function',
        label: 'Function' as NodeLabel,
        properties: {
          name: 'testFunction',
          filePath: '/test.ts'
        }
      });
      
      // Execute a query
      const result = await graph.executeQuery('MATCH (n:Function) RETURN count(n) as count');
      
      expect(result).toBeDefined();
    });
  });
});
