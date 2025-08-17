import { initKuzuDB } from '../core/kuzu/kuzu-loader.js';

/**
 * Simple test to verify KuzuDB integration
 */
export async function testKuzuDBIntegration(): Promise<void> {
  try {
    console.log('🧪 Testing KuzuDB Integration...');
    
    // Initialize KuzuDB
    const kuzuInstance = await initKuzuDB();
    console.log('✅ KuzuDB initialized successfully');
    
    // Create database
    await kuzuInstance.createDatabase('/database');
    console.log('✅ Database created successfully');
    
    // Create a simple test table
    await kuzuInstance.createNodeTable('TestNode', {
      id: 'STRING',
      name: 'STRING',
      value: 'INT64'
    });
    console.log('✅ Test table created successfully');
    
    // Insert test data
    await kuzuInstance.insertNode('TestNode', {
      id: 'test1',
      name: 'Test Node 1',
      value: 42
    });
    console.log('✅ Test data inserted successfully');
    
    // Query the data
    const result = await kuzuInstance.executeQuery('MATCH (n:TestNode) RETURN n.name, n.value');
    console.log('✅ Query executed successfully');
    console.log('Query result:', result);
    
    // Get database info
    const dbInfo = await kuzuInstance.getDatabaseInfo();
    console.log('✅ Database info retrieved');
    console.log('Database info:', dbInfo);
    
    // Close database
    await kuzuInstance.closeDatabase();
    console.log('✅ Database closed successfully');
    
    console.log('🎉 All KuzuDB tests passed!');
    
  } catch (error) {
    console.error('❌ KuzuDB test failed:', error);
    throw error;
  }
}

/**
 * Test KuzuDB with GitNexus-like schema
 */
export async function testGitNexusSchema(): Promise<void> {
  try {
    console.log('🧪 Testing GitNexus Schema with KuzuDB...');
    
    const kuzuInstance = await initKuzuDB();
    await kuzuInstance.createDatabase('/gitnexus');
    
    // Create GitNexus-like schema
    await kuzuInstance.createNodeTable('File', {
      id: 'STRING',
      name: 'STRING',
      path: 'STRING',
      language: 'STRING',
      size: 'INT64'
    });
    
    await kuzuInstance.createNodeTable('Function', {
      id: 'STRING',
      name: 'STRING',
      filePath: 'STRING',
      startLine: 'INT64',
      endLine: 'INT64',
      parameters: 'STRING'
    });
    
    await kuzuInstance.createRelTable('CALLS', {
      id: 'STRING',
      source: 'STRING',
      target: 'STRING',
      confidence: 'DOUBLE'
    });
    
    // Insert test data
    await kuzuInstance.insertNode('File', {
      id: 'file1',
      name: 'main.ts',
      path: '/src/main.ts',
      language: 'typescript',
      size: 1024
    });
    
    await kuzuInstance.insertNode('Function', {
      id: 'func1',
      name: 'processData',
      filePath: '/src/main.ts',
      startLine: 10,
      endLine: 25,
      parameters: 'data: string'
    });
    
    await kuzuInstance.insertNode('Function', {
      id: 'func2',
      name: 'validateInput',
      filePath: '/src/main.ts',
      startLine: 30,
      endLine: 40,
      parameters: 'input: any'
    });
    
    await kuzuInstance.insertRel('CALLS', 'func1', 'func2', {
      id: 'call1',
      source: 'func1',
      target: 'func2',
      confidence: 0.95
    });
    
    // Query the knowledge graph
    const result = await kuzuInstance.executeQuery(`
      MATCH (f:Function)-[:CALLS]->(g:Function)
      RETURN f.name as caller, g.name as callee
    `);
    
    console.log('✅ GitNexus schema test completed');
    console.log('Query result:', result);
    
    await kuzuInstance.closeDatabase();
    
  } catch (error) {
    console.error('❌ GitNexus schema test failed:', error);
    throw error;
  }
}
