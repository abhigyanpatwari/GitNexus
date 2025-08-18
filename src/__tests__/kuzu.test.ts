import { initKuzuDB, resetKuzuDB } from '../core/kuzu/kuzu-loader.js';
import { KuzuQueryEngine } from '../core/graph/kuzu-query-engine.js';
import { KuzuPerformanceBenchmark } from '../lib/kuzu-performance-benchmark.js';
import { kuzuPerformanceMonitor } from '../lib/kuzu-performance-monitor.js';
import { isKuzuDBEnabled, setFeatureFlag } from '../config/feature-flags.js';
import type { KnowledgeGraph } from '../core/graph/types.js';

// Mock KuzuDB for testing
jest.mock('kuzu-wasm', () => ({
  __esModule: true,
  default: jest.fn(() => Promise.resolve({
    Database: jest.fn(),
    Connection: jest.fn(),
    FS: {
      mkdir: jest.fn(),
      mountIdbfs: jest.fn(),
      syncfs: jest.fn(),
      unmount: jest.fn()
    },
    setWorkerPath: jest.fn()
  }))
}));

describe('KuzuDB Integration Tests', () => {
  beforeEach(() => {
    resetKuzuDB();
    kuzuPerformanceMonitor.clearMetrics();
  });

  afterEach(() => {
    resetKuzuDB();
  });

  describe('KuzuDB Loader', () => {
    test('should initialize KuzuDB successfully', async () => {
      const instance = await initKuzuDB();
      expect(instance).toBeDefined();
      expect(typeof instance.createDatabase).toBe('function');
      expect(typeof instance.executeQuery).toBe('function');
    });

    test('should create and manage database operations', async () => {
      const instance = await initKuzuDB();
      
      await instance.createDatabase('/test-db');
      await instance.createNodeTable('TestNode', {
        id: 'STRING',
        name: 'STRING',
        value: 'INT64'
      });
      
      await instance.insertNode('TestNode', {
        id: 'test1',
        name: 'Test Node',
        value: 42
      });
      
      const result = await instance.executeQuery('MATCH (n:TestNode) RETURN n.name, n.value');
      expect(result.results).toBeDefined();
      
      await instance.closeDatabase();
    });

    test('should handle database errors gracefully', async () => {
      const instance = await initKuzuDB();
      
      // Test invalid query
      await expect(instance.executeQuery('INVALID QUERY')).rejects.toThrow();
    });
  });

  describe('KuzuQueryEngine', () => {
    let queryEngine: KuzuQueryEngine;

    beforeEach(async () => {
      queryEngine = new KuzuQueryEngine();
      await queryEngine.initialize();
    });

    afterEach(async () => {
      await queryEngine.close();
    });

    test('should initialize query engine', () => {
      expect(queryEngine.isReady()).toBe(true);
    });

    test('should import graph data', async () => {
      const mockGraph: KnowledgeGraph = {
        nodes: [
          {
            id: 'func1',
            label: 'Function',
            properties: { name: 'testFunction', filePath: '/test.ts' }
          }
        ],
        relationships: []
      };

      await queryEngine.importGraph(mockGraph);
      expect(queryEngine.isReady()).toBe(true);
    });

    test('should execute Cypher queries', async () => {
      const mockGraph: KnowledgeGraph = {
        nodes: [
          {
            id: 'func1',
            label: 'Function',
            properties: { name: 'testFunction', filePath: '/test.ts' }
          }
        ],
        relationships: []
      };

      await queryEngine.importGraph(mockGraph);
      
      const result = await queryEngine.executeQuery('MATCH (f:Function) RETURN f.name');
      expect(result.nodes).toBeDefined();
      expect(result.executionTime).toBeGreaterThan(0);
    });
  });

  describe('Performance Monitoring', () => {
    test('should track performance metrics', () => {
      const opId = kuzuPerformanceMonitor.startOperation('test_operation');
      expect(opId).toBeDefined();
      
      kuzuPerformanceMonitor.endOperation(opId, true);
      
      const report = kuzuPerformanceMonitor.getReport();
      expect(report.totalOperations).toBe(1);
      expect(report.successfulOperations).toBe(1);
    });

    test('should generate performance reports', () => {
      // Add some test metrics
      kuzuPerformanceMonitor.addMetric({
        operation: 'test_query',
        duration: 100,
        timestamp: Date.now(),
        success: true
      });

      const report = kuzuPerformanceMonitor.getReport();
      expect(report.totalOperations).toBe(1);
      expect(report.averageDuration).toBe(100);
    });
  });

  describe('Performance Benchmarking', () => {
    let benchmark: KuzuPerformanceBenchmark;

    beforeEach(() => {
      benchmark = new KuzuPerformanceBenchmark();
    });

    test('should initialize benchmark with test queries', () => {
      expect(benchmark).toBeDefined();
    });

    test('should run performance comparison', async () => {
      const mockGraph: KnowledgeGraph = {
        nodes: [
          {
            id: 'func1',
            label: 'Function',
            properties: { name: 'testFunction', filePath: '/test.ts' }
          }
        ],
        relationships: []
      };

      const result = await benchmark.runBenchmark(mockGraph);
      expect(result.kuzuDBResults).toBeDefined();
      expect(result.inMemoryResults).toBeDefined();
      expect(result.improvement).toBeDefined();
    });
  });

  describe('Feature Flags', () => {
    test('should enable/disable KuzuDB features', () => {
      setFeatureFlag('enableKuzuDB', false);
      expect(isKuzuDBEnabled()).toBe(false);
      
      setFeatureFlag('enableKuzuDB', true);
      expect(isKuzuDBEnabled()).toBe(true);
    });
  });

  describe('Error Handling', () => {
    test('should handle initialization failures gracefully', async () => {
      // Mock failure
      jest.doMock('kuzu-wasm', () => ({
        __esModule: true,
        default: jest.fn(() => Promise.reject(new Error('WASM load failed')))
      }));

      await expect(initKuzuDB()).rejects.toThrow('KuzuDB initialization failed');
    });

    test('should provide fallback mechanisms', async () => {
      // Test that the system can work without KuzuDB
      setFeatureFlag('enableKuzuDB', false);
      
      // Should not throw when KuzuDB is disabled
      expect(() => isKuzuDBEnabled()).not.toThrow();
    });
  });

  describe('Integration Scenarios', () => {
    test('should handle complete workflow', async () => {
      // Initialize KuzuDB
      const instance = await initKuzuDB();
      
      // Create database and schema
      await instance.createDatabase('/integration-test');
      await instance.createNodeTable('Function', {
        id: 'STRING',
        name: 'STRING',
        filePath: 'STRING'
      });
      
      // Insert test data
      await instance.insertNode('Function', {
        id: 'func1',
        name: 'testFunction',
        filePath: '/test.ts'
      });
      
      // Execute query
      const result = await instance.executeQuery('MATCH (f:Function) RETURN f.name');
      expect(result.results).toBeDefined();
      
      // Clean up
      await instance.closeDatabase();
    });

    test('should handle performance monitoring in workflow', async () => {
      const opId = kuzuPerformanceMonitor.startOperation('integration_test');
      
      const instance = await initKuzuDB();
      await instance.createDatabase('/perf-test');
      
      kuzuPerformanceMonitor.endOperation(opId, true);
      
      const report = kuzuPerformanceMonitor.getReport();
      expect(report.successfulOperations).toBe(1);
      
      await instance.closeDatabase();
    });
  });
});
