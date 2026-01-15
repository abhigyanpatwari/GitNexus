/**
 * KuzuDB Adapter
 * 
 * Manages the KuzuDB WASM instance for client-side graph database operations.
 * Uses the "Snapshot / Bulk Load" pattern with COPY FROM for performance.
 * 
 * Multi-table schema: separate tables for File, Function, Class, etc.
 */

import { KnowledgeGraph } from '../graph/types';
import {
  NODE_TABLES,
  REL_TABLE_NAME,
  SCHEMA_QUERIES,
  INDEX_QUERIES,
  EMBEDDING_TABLE_NAME,
  NodeTableName,
} from './schema';
import { generateAllCSVs } from './csv-generator';

// Holds the reference to the dynamically loaded module
let kuzu: any = null;
let db: any = null;
let conn: any = null;

/**
 * Initialize KuzuDB WASM module and create in-memory database
 */
export const initKuzu = async () => {
  if (conn) return { db, conn, kuzu };

  try {
    if (import.meta.env.DEV) console.log('🚀 Initializing KuzuDB...');

    // 1. Dynamic Import (Fixes the "not a function" bundler issue)
    const kuzuModule = await import('kuzu-wasm');
    
    // 2. Handle Vite/Webpack "default" wrapping
    kuzu = kuzuModule.default || kuzuModule;

    // 3. Initialize WASM
    await kuzu.init();
    
    // 4. Create Database with 512MB buffer pool
    const BUFFER_POOL_SIZE = 512 * 1024 * 1024; // 512MB
    db = new kuzu.Database(':memory:', BUFFER_POOL_SIZE);
    conn = new kuzu.Connection(db);
    
    if (import.meta.env.DEV) console.log('✅ KuzuDB WASM Initialized');

    // 5. Initialize Schema (all node tables, then rel tables, then embedding table)
    for (const schemaQuery of SCHEMA_QUERIES) {
      try {
        await conn.query(schemaQuery);
      } catch (e) {
        // Schema might already exist, skip
        if (import.meta.env.DEV) {
          console.warn('Schema creation skipped (may already exist):', e);
        }
      }
    }

    if (import.meta.env.DEV) console.log('✅ KuzuDB Multi-Table Schema Created');

    // 6. Create indexes for query performance optimization
    for (const indexQuery of INDEX_QUERIES) {
      try {
        await conn.query(indexQuery);
      } catch (e) {
        // Index might already exist, skip
        if (import.meta.env.DEV) {
          console.warn('Index creation skipped (may already exist):', e);
        }
      }
    }

    if (import.meta.env.DEV) console.log('✅ KuzuDB Indexes Created');

    return { db, conn, kuzu };
  } catch (error) {
    if (import.meta.env.DEV) console.error('❌ KuzuDB Initialization Failed:', error);
    throw error;
  }
};

/**
 * Load a KnowledgeGraph into KuzuDB using COPY FROM (bulk load)
 * Uses batched CSV writes and COPY statements for optimal performance
 */
export const loadGraphToKuzu = async (
  graph: KnowledgeGraph, 
  fileContents: Map<string, string>
) => {
  const { conn, kuzu } = await initKuzu();
  
  try {
    if (import.meta.env.DEV) console.log(`KuzuDB: Generating CSVs for ${graph.nodeCount} nodes...`);
    
    // 1. Generate all CSVs (per-table)
    const csvData = generateAllCSVs(graph, fileContents);
    
    const fs = kuzu.FS;
    
    // 2. Write all node CSVs to virtual filesystem
    const nodeFiles: Array<{ table: NodeTableName; path: string }> = [];
    for (const [tableName, csv] of csvData.nodes.entries()) {
      // Skip empty CSVs (only header row)
      if (csv.split('\n').length <= 1) continue;
      
      const path = `/${tableName.toLowerCase()}.csv`;
      try { await fs.unlink(path); } catch {}
      await fs.writeFile(path, csv);
      nodeFiles.push({ table: tableName, path });
    }
    
    // 3. Parse relation CSV and prepare for INSERT (COPY FROM doesn't work with multi-pair tables)
    const relLines = csvData.relCSV.split('\n').slice(1).filter(line => line.trim());
    const relCount = relLines.length;
    
    if (import.meta.env.DEV) {
      console.log(`KuzuDB: Wrote ${nodeFiles.length} node CSVs, ${relCount} relations to insert`);
    }
    
    // 4. COPY all node tables (must complete before rels due to FK constraints)
    for (const { table, path } of nodeFiles) {
      const copyQuery = getCopyQuery(table, path);
      await conn.query(copyQuery);
    }
    
    // 5. INSERT relations one by one (COPY doesn't work with multi-pair REL tables)
    // Parse CSV format: "from","to","type"
    let insertedRels = 0;
    for (const line of relLines) {
      try {
        // Parse CSV - handle quoted fields
        const match = line.match(/"([^"]*)","([^"]*)","([^"]*)"/);
        if (!match) continue;
        
        const [, fromId, toId, relType] = match;
        
        // Extract labels from node IDs (format: Label:path:name)
        const fromLabel = fromId.split(':')[0];
        const toLabel = toId.split(':')[0];
        
        // INSERT with explicit node matching
        const insertQuery = `
          MATCH (a:${fromLabel} {id: '${fromId.replace(/'/g, "''")}'})
          MATCH (b:${toLabel} {id: '${toId.replace(/'/g, "''")}'})
          CREATE (a)-[:${REL_TABLE_NAME} {type: '${relType}'}]->(b)
        `;
        await conn.query(insertQuery);
        insertedRels++;
      } catch {
        // Skip failed insertions (nodes might not exist)
      }
    }
    
    if (import.meta.env.DEV) {
      console.log(`KuzuDB: Inserted ${insertedRels}/${relCount} relations`);
    }
    
    // 6. Verify results
    let totalNodes = 0;
    for (const tableName of NODE_TABLES) {
      try {
        const countRes = await conn.query(`MATCH (n:${tableName}) RETURN count(n) AS cnt`);
        const countRow = await countRes.getNext();
        const count = countRow ? (countRow.cnt ?? countRow[0] ?? 0) : 0;
        totalNodes += Number(count);
      } catch {
        // Table might be empty, skip
      }
    }
    
    if (import.meta.env.DEV) console.log(`✅ KuzuDB Bulk Load Complete. Total nodes: ${totalNodes}, edges: ${insertedRels}`);

    // 7. Cleanup CSV files
    for (const { path } of nodeFiles) {
      try { await fs.unlink(path); } catch {}
    }

    return { success: true, count: totalNodes };

  } catch (error) {
    if (import.meta.env.DEV) console.error('❌ KuzuDB Bulk Load Failed:', error);
    return { success: false, count: 0 };
  }
};

/**
 * Get the COPY query for a node table with correct column mapping
 */
const getCopyQuery = (table: NodeTableName, path: string): string => {
  // File and Folder have different columns than code elements
  if (table === 'File') {
    return `COPY File(id, name, filePath, content) FROM "${path}" (HEADER=true, PARALLEL=false)`;
  }
  if (table === 'Folder') {
    return `COPY Folder(id, name, filePath) FROM "${path}" (HEADER=true, PARALLEL=false)`;
  }
  // All code element tables: Function, Class, Interface, Method, CodeElement
  return `COPY ${table}(id, name, filePath, startLine, endLine, content) FROM "${path}" (HEADER=true, PARALLEL=false)`;
};

/**
 * Execute a Cypher query against the database
 */
export const executeQuery = async (cypher: string): Promise<any[]> => {
  if (!conn) {
    await initKuzu();
  }
  
  try {
    const result = await conn.query(cypher);
    
    // Collect all rows
    const rows: any[] = [];
    while (await result.hasNext()) {
      const row = await result.getNext();
      rows.push(row);
    }
    
    return rows;
  } catch (error) {
    if (import.meta.env.DEV) console.error('Query execution failed:', error);
    throw error;
  }
};

/**
 * Get database statistics
 */
export const getKuzuStats = async (): Promise<{ nodes: number; edges: number }> => {
  if (!conn) {
    return { nodes: 0, edges: 0 };
  }

  try {
    // Count nodes across all tables
    let totalNodes = 0;
    for (const tableName of NODE_TABLES) {
      try {
        const nodeResult = await conn.query(`MATCH (n:${tableName}) RETURN count(n) AS cnt`);
        const nodeRow = await nodeResult.getNext();
        totalNodes += Number(nodeRow?.cnt ?? nodeRow?.[0] ?? 0);
      } catch {
        // Table might not exist or be empty
      }
    }
    
    // Count edges from single relation table
    let totalEdges = 0;
    try {
      const edgeResult = await conn.query(`MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`);
      const edgeRow = await edgeResult.getNext();
      totalEdges = Number(edgeRow?.cnt ?? edgeRow?.[0] ?? 0);
    } catch {
      // Table might not exist or be empty
    }
    
    return { nodes: totalNodes, edges: totalEdges };
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to get Kuzu stats:', error);
    }
    return { nodes: 0, edges: 0 };
  }
};

/**
 * Check if KuzuDB is initialized and has data
 */
export const isKuzuReady = (): boolean => {
  return conn !== null && db !== null;
};

/**
 * Close the database connection (cleanup)
 */
export const closeKuzu = async (): Promise<void> => {
  if (conn) {
    try {
      await conn.close();
    } catch {}
    conn = null;
  }
  if (db) {
    try {
      await db.close();
    } catch {}
    db = null;
  }
  kuzu = null;
};

/**
 * Execute a prepared statement with parameters
 * @param cypher - Cypher query with $param placeholders
 * @param params - Object mapping param names to values
 * @returns Query results
 */
export const executePrepared = async (
  cypher: string,
  params: Record<string, any>
): Promise<any[]> => {
  if (!conn) {
    await initKuzu();
  }
  
  try {
    const stmt = await conn.prepare(cypher);
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Prepare failed: ${errMsg}`);
    }
    
    const result = await conn.execute(stmt, params);
    
    const rows: any[] = [];
    while (await result.hasNext()) {
      const row = await result.getNext();
      rows.push(row);
    }
    
    await stmt.close();
    return rows;
  } catch (error) {
    if (import.meta.env.DEV) console.error('Prepared query failed:', error);
    throw error;
  }
};

/**
 * Execute a prepared statement with multiple parameter sets in small sub-batches
 */
export const executeWithReusedStatement = async (
  cypher: string,
  paramsList: Array<Record<string, any>>
): Promise<void> => {
  if (!conn) {
    await initKuzu();
  }
  
  if (paramsList.length === 0) return;
  
  const SUB_BATCH_SIZE = 4;
  
  for (let i = 0; i < paramsList.length; i += SUB_BATCH_SIZE) {
    const subBatch = paramsList.slice(i, i + SUB_BATCH_SIZE);
    
    const stmt = await conn.prepare(cypher);
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Prepare failed: ${errMsg}`);
    }
    
    try {
      for (const params of subBatch) {
        await conn.execute(stmt, params);
      }
    } finally {
      await stmt.close();
    }
    
    if (i + SUB_BATCH_SIZE < paramsList.length) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
};

/**
 * Test if array parameters work with prepared statements
 */
export const testArrayParams = async (): Promise<{ success: boolean; error?: string }> => {
  if (!conn) {
    await initKuzu();
  }
  
  try {
    const testEmbedding = new Array(384).fill(0).map((_, i) => i / 384);
    
    // Get any node ID to test with (try File first, then others)
    let testNodeId: string | null = null;
    for (const tableName of NODE_TABLES) {
      try {
        const nodeResult = await conn.query(`MATCH (n:${tableName}) RETURN n.id AS id LIMIT 1`);
        const nodeRow = await nodeResult.getNext();
        if (nodeRow) {
          testNodeId = nodeRow.id ?? nodeRow[0];
          break;
        }
      } catch {}
    }
    
    if (!testNodeId) {
      return { success: false, error: 'No nodes found to test with' };
    }
    
    if (import.meta.env.DEV) {
      console.log('🧪 Testing array params with node:', testNodeId);
    }
    
    // First create an embedding entry
    const createQuery = `CREATE (e:${EMBEDDING_TABLE_NAME} {nodeId: $nodeId, embedding: $embedding})`;
    const stmt = await conn.prepare(createQuery);
    
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      return { success: false, error: `Prepare failed: ${errMsg}` };
    }
    
    await conn.execute(stmt, {
      nodeId: testNodeId,
      embedding: testEmbedding,
    });
    
    await stmt.close();
    
    // Verify it was stored
    const verifyResult = await conn.query(
      `MATCH (e:${EMBEDDING_TABLE_NAME} {nodeId: '${testNodeId}'}) RETURN e.embedding AS emb`
    );
    const verifyRow = await verifyResult.getNext();
    const storedEmb = verifyRow?.emb ?? verifyRow?.[0];
    
    if (storedEmb && Array.isArray(storedEmb) && storedEmb.length === 384) {
      if (import.meta.env.DEV) {
        console.log('✅ Array params WORK! Stored embedding length:', storedEmb.length);
      }
      return { success: true };
    } else {
      return { 
        success: false, 
        error: `Embedding not stored correctly. Got: ${typeof storedEmb}, length: ${storedEmb?.length}` 
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (import.meta.env.DEV) {
      console.error('❌ Array params test failed:', errorMsg);
    }
    return { success: false, error: errorMsg };
  }
};
