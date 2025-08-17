import { testKuzuDBIntegration, testGitNexusSchema } from './kuzu-test.js';

/**
 * Browser-friendly integration test for KuzuDB
 * Can be called from browser console: window.testKuzuDB()
 */
export async function testKuzuDB(): Promise<void> {
  try {
    console.log('🚀 Starting KuzuDB Integration Test...');
    
    // Test basic functionality
    await testKuzuDBIntegration();
    
    // Test GitNexus schema
    await testGitNexusSchema();
    
    console.log('🎉 All KuzuDB integration tests completed successfully!');
    
  } catch (error) {
    console.error('❌ KuzuDB integration test failed:', error);
    throw error;
  }
}

/**
 * Quick performance test for KuzuDB
 */
export async function testKuzuDBPerformance(): Promise<void> {
  try {
    console.log('⚡ Starting KuzuDB Performance Test...');
    
    const { initKuzuDB } = await import('../core/kuzu/kuzu-loader.js');
    const kuzuInstance = await initKuzuDB();
    
    // Create database
    const startTime = performance.now();
    await kuzuInstance.createDatabase('/perf-test');
    const initTime = performance.now() - startTime;
    
    // Create schema
    const schemaStart = performance.now();
    await kuzuInstance.createNodeTable('PerfNode', {
      id: 'STRING',
      name: 'STRING',
      value: 'INT64',
      data: 'STRING'
    });
    const schemaTime = performance.now() - schemaStart;
    
    // Insert bulk data
    const insertStart = performance.now();
    const insertCount = 1000;
    for (let i = 0; i < insertCount; i++) {
      await kuzuInstance.insertNode('PerfNode', {
        id: `node${i}`,
        name: `Node ${i}`,
        value: i,
        data: `Data for node ${i}`
      });
    }
    const insertTime = performance.now() - insertStart;
    
    // Query performance
    const queryStart = performance.now();
    const result = await kuzuInstance.executeQuery('MATCH (n:PerfNode) RETURN COUNT(n) as count');
    const queryTime = performance.now() - queryStart;
    
    // Close database
    await kuzuInstance.closeDatabase();
    
    console.log('📊 KuzuDB Performance Results:');
    console.log(`  Initialization: ${initTime.toFixed(2)}ms`);
    console.log(`  Schema Creation: ${schemaTime.toFixed(2)}ms`);
    console.log(`  Insert ${insertCount} nodes: ${insertTime.toFixed(2)}ms (${(insertTime / insertCount).toFixed(2)}ms per node)`);
    console.log(`  Query execution: ${queryTime.toFixed(2)}ms`);
    console.log(`  Total time: ${(initTime + schemaTime + insertTime + queryTime).toFixed(2)}ms`);
    console.log(`  Query result: ${result.results[0]?.count || 0} nodes`);
    
  } catch (error) {
    console.error('❌ KuzuDB performance test failed:', error);
    throw error;
  }
}

// Make functions available globally for browser testing
if (typeof window !== 'undefined') {
  (window as any).testKuzuDB = testKuzuDB;
  (window as any).testKuzuDBPerformance = testKuzuDBPerformance;
}
