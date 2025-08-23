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
import type { GraphNode, GraphRelationship, NodeLabel, RelationshipType } from '../core/graph/types';

describe('KuzuKnowledgeGraph', () => {
  let graph: KuzuKnowledgeGraph;

  beforeEach(async () => {
    graph = new KuzuKnowledgeGraph();
    await graph.initialize();
    await graph.clear(); // Clear any existing data
  });

  afterEach(async () => {
    if (graph) {
      await graph.clear();
    }
  });

  describe('Direct KuzuDB Integration', () => {
    it('should add nodes directly to KuzuDB', async () => {
      const node: GraphNode = {
        id: 'test-node-1',
        label: 'Function' as NodeLabel,
        properties: {
          name: 'testFunction',
          filePath: '/test/file.ts',
          startLine: 10
        }
      };

      await graph.addNode(node);
      
      expect(graph.getNodeCount()).toBe(1);
    });

    it('should add relationships directly to KuzuDB', async () => {
      // First add two nodes
      const node1: GraphNode = {
        id: 'source-node',
        label: 'Function' as NodeLabel,
        properties: { name: 'sourceFunction' }
      };
      
      const node2: GraphNode = {
        id: 'target-node',
        label: 'Function' as NodeLabel,
        properties: { name: 'targetFunction' }
      };

      await graph.addNode(node1);
      await graph.addNode(node2);

      // Then add relationship
      const relationship: GraphRelationship = {
        id: 'test-rel-1',
        type: 'CALLS' as RelationshipType,
        source: 'source-node',
        target: 'target-node',
        properties: {
          strength: 0.8,
          confidence: 0.9
        }
      };

      await graph.addRelationship(relationship);
      
      expect(graph.getRelationshipCount()).toBe(1);
    });

    it('should handle batch operations efficiently', async () => {
      const nodes: GraphNode[] = [];
      const relationships: GraphRelationship[] = [];

      // Create 10 nodes
      for (let i = 0; i < 10; i++) {
        nodes.push({
          id: `node-${i}`,
          label: 'Function' as NodeLabel,
          properties: {
            name: `function${i}`,
            filePath: `/file${i}.ts`
          }
        });
      }

      // Create 9 relationships (connecting consecutive nodes)
      for (let i = 0; i < 9; i++) {
        relationships.push({
          id: `rel-${i}`,
          type: 'CALLS' as RelationshipType,
          source: `node-${i}`,
          target: `node-${i + 1}`,
          properties: { strength: 0.5 }
        });
      }

      // Add all nodes
      for (const node of nodes) {
        await graph.addNode(node);
      }

      // Add all relationships
      for (const rel of relationships) {
        await graph.addRelationship(rel);
      }

      expect(graph.getNodeCount()).toBe(10);
      expect(graph.getRelationshipCount()).toBe(9);
    });

    it('should execute Cypher queries', async () => {
      const result = await graph.executeQuery('MATCH (n) RETURN count(n) as count');
      expect(result).toBeDefined();
    });
  });

  describe('Performance', () => {
    it('should handle large datasets efficiently', async () => {
      const startTime = Date.now();
      
      // Add 100 nodes
      for (let i = 0; i < 100; i++) {
        await graph.addNode({
          id: `perf-node-${i}`,
          label: 'Function' as NodeLabel,
          properties: { name: `function${i}`, startLine: i }
        });
      }

      const nodeTime = Date.now() - startTime;
      console.log(`Added 100 nodes in ${nodeTime}ms`);

      // Add 99 relationships
      const relStartTime = Date.now();
      for (let i = 0; i < 99; i++) {
        await graph.addRelationship({
          id: `perf-rel-${i}`,
          type: 'CALLS' as RelationshipType,
          source: `perf-node-${i}`,
          target: `perf-node-${i + 1}`,
          properties: { strength: 0.5 }
        });
      }

      const relTime = Date.now() - relStartTime;
      console.log(`Added 99 relationships in ${relTime}ms`);

      expect(graph.getNodeCount()).toBe(100);
      expect(graph.getRelationshipCount()).toBe(99);

      // Verify performance is reasonable (should be under 5 seconds for 100 nodes)
      expect(nodeTime + relTime).toBeLessThan(5000);
    });
  });
});
