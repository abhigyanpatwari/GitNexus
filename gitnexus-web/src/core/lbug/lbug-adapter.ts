/**
 * LadybugDB Adapter
 *
 * Manages the LadybugDB WASM instance for client-side graph database operations.
 * Uses the "Snapshot / Bulk Load" pattern with COPY FROM for performance.
 *
 * Multi-table schema: separate tables for File, Function, Class, etc.
 */

import { KnowledgeGraph } from '../graph/types';
import {
  NODE_TABLES,
  REL_TABLE_NAME,
  SCHEMA_QUERIES,
  EMBEDDING_TABLE_NAME,
  NodeTableName,
} from './schema';
import { generateAllCSVs } from './csv-generator';
import { getQueryRows } from './query-result';

// Holds the reference to the dynamically loaded module
let lbug: any = null;
let db: any = null;
let conn: any = null;

/**
 * Initialize LadybugDB WASM module and create in-memory database
 */
export const initLbug = async () => {
  if (conn) return { db, conn, lbug };

  try {
    if (import.meta.env.DEV) console.log('🚀 Initializing LadybugDB...');

    // 1. Dynamic Import (Fixes the "not a function" bundler issue)
    const lbugModule = await import('@ladybugdb/wasm-core');

    // 2. Handle Vite/Webpack "default" wrapping
    lbug = lbugModule.default || lbugModule;

    // 3. Initialize WASM
    await lbug.init();

    // 4. Create Database with 512MB buffer manager
    const BUFFER_POOL_SIZE = 512 * 1024 * 1024; // 512MB
    db = new lbug.Database(':memory:', BUFFER_POOL_SIZE);
    conn = new lbug.Connection(db);

    if (import.meta.env.DEV) console.log('✅ LadybugDB WASM Initialized');

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

    if (import.meta.env.DEV) console.log('✅ LadybugDB Multi-Table Schema Created');

    return { db, conn, lbug };
  } catch (error) {
    if (import.meta.env.DEV) console.error('❌ LadybugDB Initialization Failed:', error);
    throw error;
  }
};

/**
 * Load a KnowledgeGraph into LadybugDB using COPY FROM (bulk load)
 * Uses batched CSV writes and COPY statements for optimal performance
 */
export const loadGraphToLbug = async (
  graph: KnowledgeGraph,
  fileContents: Map<string, string>
) => {
  const { conn, lbug } = await initLbug();

  try {
    if (import.meta.env.DEV) console.log(`LadybugDB: Generating CSVs for ${graph.nodeCount} nodes...`);

    // 1. Generate all CSVs (per-table)
    const csvData = generateAllCSVs(graph, fileContents);

    const fs = lbug.FS;

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
      console.log(`LadybugDB: Wrote ${nodeFiles.length} node CSVs, ${relCount} relations to insert`);
    }

    // 4. COPY all node tables (must complete before rels due to FK constraints)
    for (const { table, path } of nodeFiles) {
      const copyQuery = getCopyQuery(table, path);
      await conn.query(copyQuery);
    }

    // 5. INSERT relations one by one (COPY doesn't work with multi-pair REL tables)
    // Build a set of valid table names for fast lookup
    const validTables = new Set<string>(NODE_TABLES as readonly string[]);

    const getNodeLabel = (nodeId: string): string => {
      if (nodeId.startsWith('comm_')) return 'Community';
      if (nodeId.startsWith('proc_')) return 'Process';
      return nodeId.split(':')[0];
    };

    // All multi-language tables are created with backticks - must always reference them with backticks
    const escapeLabel = (label: string): string => {
      return BACKTICK_TABLES.has(label) ? `\`${label}\`` : label;
    };

    let insertedRels = 0;
    let skippedRels = 0;
    const skippedRelStats = new Map<string, number>();
    for (const line of relLines) {
      try {
        // Format: "from","to","type",confidence,"reason",step
        const match = line.match(/"([^"]*)","([^"]*)","([^"]*)",([0-9.]+),"([^"]*)",([0-9-]+)/);
        if (!match) continue;

        const [, fromId, toId, relType, confidenceStr, reason, stepStr] = match;

        const fromLabel = getNodeLabel(fromId);
        const toLabel = getNodeLabel(toId);

        // Skip relationships where either node's label doesn't have a table in LadybugDB
        // Querying a non-existent table causes a fatal native crash
        if (!validTables.has(fromLabel) || !validTables.has(toLabel)) {
          skippedRels++;
          continue;
        }

        const confidence = parseFloat(confidenceStr) || 1.0;
        const step = parseInt(stepStr) || 0;

        const insertQuery = `
          MATCH (a:${escapeLabel(fromLabel)} {id: '${fromId.replace(/'/g, "''")}'}),
                (b:${escapeLabel(toLabel)} {id: '${toId.replace(/'/g, "''")}'})
          CREATE (a)-[:${REL_TABLE_NAME} {type: '${relType}', confidence: ${confidence}, reason: '${reason.replace(/'/g, "''")}', step: ${step}}]->(b)
        `;
        await conn.query(insertQuery);
        insertedRels++;
      } catch (err) {
        skippedRels++;
        const match = line.match(/"([^"]*)","([^"]*)","([^"]*)",([0-9.]+),"([^"]*)"/);
        if (match) {
          const [, fromId, toId, relType] = match;
          const fromLabel = getNodeLabel(fromId);
          const toLabel = getNodeLabel(toId);
          const key = `${relType}:${fromLabel}->` + toLabel;
          skippedRelStats.set(key, (skippedRelStats.get(key) || 0) + 1);

          if (import.meta.env.DEV) {
            console.warn(`⚠️ Skipped: ${key} | "${fromId}" → "${toId}" | ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    if (import.meta.env.DEV) {
      console.log(`LadybugDB: Inserted ${insertedRels}/${relCount} relations`);
      if (skippedRels > 0) {
        const topSkipped = Array.from(skippedRelStats.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        console.warn(`LadybugDB: Skipped ${skippedRels}/${relCount} relations (top by kind/pair):`, topSkipped);
      }
    }

    // 6. Verify results
    let totalNodes = 0;
    for (const tableName of NODE_TABLES) {
      try {
        const countRes = await conn.query(`MATCH (n:${tableName}) RETURN count(n) AS cnt`);
        const countRows = await getQueryRows(countRes);
        const countRow = countRows[0];
        const count = countRow ? (countRow.cnt ?? countRow[0] ?? 0) : 0;
        totalNodes += Number(count);
      } catch {
        // Table might be empty, skip
      }
    }

    if (import.meta.env.DEV) console.log(`✅ LadybugDB Bulk Load Complete. Total nodes: ${totalNodes}, edges: ${insertedRels}`);

    // 7. Cleanup CSV files
    for (const { path } of nodeFiles) {
      try { await fs.unlink(path); } catch {}
    }

    return { success: true, count: totalNodes };

  } catch (error) {
    if (import.meta.env.DEV) console.error('❌ LadybugDB Bulk Load Failed:', error);
    return { success: false, count: 0 };
  }
};

// LadybugDB default ESCAPE is '\' (backslash), but our CSV uses RFC 4180 escaping ("" for literal quotes).
// Source code content is full of backslashes which confuse the auto-detection.
// We MUST explicitly set ESCAPE='"' and disable auto_detect.
const COPY_CSV_OPTS = `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

// Multi-language table names created with backticks in CODE_ELEMENT_BASE
const BACKTICK_TABLES = new Set([
  'Struct', 'Enum', 'Macro', 'Typedef', 'Union', 'Namespace', 'Trait', 'Impl',
  'TypeAlias', 'Const', 'Static', 'Property', 'Record', 'Delegate', 'Annotation',
  'Constructor', 'Template', 'Module',
]);

const escapeTableName = (table: string): string => {
  return BACKTICK_TABLES.has(table) ? `\`${table}\`` : table;
};

/** Tables with isExported column (TypeScript/JS-native types) */
const TABLES_WITH_EXPORTED = new Set<string>(['Function', 'Class', 'Interface', 'Method', 'CodeElement']);

/**
 * Get the COPY query for a node table with correct column mapping
 */
const getCopyQuery = (table: NodeTableName, path: string): string => {
  const t = escapeTableName(table);
  if (table === 'File') {
    return `COPY ${t}(id, name, filePath, content) FROM "${path}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Folder') {
    return `COPY ${t}(id, name, filePath) FROM "${path}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Community') {
    return `COPY ${t}(id, label, heuristicLabel, keywords, description, enrichedBy, cohesion, symbolCount) FROM "${path}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Process') {
    return `COPY ${t}(id, label, heuristicLabel, processType, stepCount, communities, entryPointId, terminalId) FROM "${path}" ${COPY_CSV_OPTS}`;
  }
  // TypeScript/JS code element tables have isExported; multi-language tables do not
  if (TABLES_WITH_EXPORTED.has(table)) {
    return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content) FROM "${path}" ${COPY_CSV_OPTS}`;
  }
  // Multi-language tables (Struct, Impl, Trait, Macro, etc.)
  return `COPY ${t}(id, name, filePath, startLine, endLine, content) FROM "${path}" ${COPY_CSV_OPTS}`;
};

/**
 * Execute a Cypher query against the database
 * Returns results as named objects (not tuples) for better usability
 */
export const executeQuery = async (cypher: string): Promise<any[]> => {
  if (!conn) {
    await initLbug();
  }

  try {
    const result = await conn.query(cypher);

    // Extract column names from RETURN clause
    const returnMatch = cypher.match(/RETURN\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+SKIP|\s*$)/is);
    let columnNames: string[] = [];
    if (returnMatch) {
      // Parse RETURN clause to get column names/aliases
      // Handles: "a.name, b.filePath AS path, count(x) AS cnt"
      const returnClause = returnMatch[1];
      columnNames = returnClause.split(',').map(col => {
        col = col.trim();
        // Check for AS alias
        const asMatch = col.match(/\s+AS\s+(\w+)\s*$/i);
        if (asMatch) return asMatch[1];
        // Check for property access like n.name
        const propMatch = col.match(/\.(\w+)\s*$/);
        if (propMatch) return propMatch[1];
        // Check for function call like count(x)
        const funcMatch = col.match(/^(\w+)\s*\(/);
        if (funcMatch) return funcMatch[1];
        // Just use as-is if simple identifier
        return col.replace(/[^a-zA-Z0-9_]/g, '_');
      });
    }

    // Collect all rows
    const allRows = await getQueryRows(result);
    const rows: any[] = [];
    for (const row of allRows) {
      // Convert tuple to named object if we have column names and row is array
      if (Array.isArray(row) && columnNames.length === row.length) {
        const namedRow: Record<string, any> = {};
        for (let i = 0; i < row.length; i++) {
          namedRow[columnNames[i]] = row[i];
        }
        rows.push(namedRow);
      } else {
        // Already an object or column count doesn't match
        rows.push(row);
      }
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
export const getLbugStats = async (): Promise<{ nodes: number; edges: number }> => {
  if (!conn) {
    return { nodes: 0, edges: 0 };
  }

  try {
    // Count nodes across all tables
    let totalNodes = 0;
    for (const tableName of NODE_TABLES) {
      try {
        const nodeResult = await conn.query(`MATCH (n:${tableName}) RETURN count(n) AS cnt`);
        const nodeRows = await getQueryRows(nodeResult);
        const nodeRow = nodeRows[0];
        totalNodes += Number(nodeRow?.cnt ?? nodeRow?.[0] ?? 0);
      } catch {
        // Table might not exist or be empty
      }
    }

    // Count edges from single relation table
    let totalEdges = 0;
    try {
      const edgeResult = await conn.query(`MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`);
      const edgeRows = await getQueryRows(edgeResult);
      const edgeRow = edgeRows[0];
      totalEdges = Number(edgeRow?.cnt ?? edgeRow?.[0] ?? 0);
    } catch {
      // Table might not exist or be empty
    }

    return { nodes: totalNodes, edges: totalEdges };
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to get LadybugDB stats:', error);
    }
    return { nodes: 0, edges: 0 };
  }
};

/**
 * Check if LadybugDB is initialized and has data
 */
export const isLbugReady = (): boolean => {
  return conn !== null && db !== null;
};

/**
 * Close the database connection (cleanup)
 */
export const closeLbug = async (): Promise<void> => {
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
  lbug = null;
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
    await initLbug();
  }

  try {
    const stmt = await conn.prepare(cypher);
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Prepare failed: ${errMsg}`);
    }

    const result = await conn.execute(stmt, params);

    const rows = await getQueryRows(result);

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
    await initLbug();
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
    await initLbug();
  }

  try {
    const testEmbedding = new Array(384).fill(0).map((_, i) => i / 384);

    // Get any node ID to test with (try File first, then others)
    let testNodeId: string | null = null;
    for (const tableName of NODE_TABLES) {
      try {
        const nodeResult = await conn.query(`MATCH (n:${tableName}) RETURN n.id AS id LIMIT 1`);
        const nodeRows = await getQueryRows(nodeResult);
        const nodeRow = nodeRows[0];
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
    const verifyRows = await getQueryRows(verifyResult);
    const verifyRow = verifyRows[0];
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
