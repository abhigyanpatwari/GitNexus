/**
 * KuzuDB WASM Loader
 * Handles loading and initialization of KuzuDB WebAssembly module using the official npm package
 */

import kuzuWasm from 'kuzu-wasm';

// Define types for Kuzu query results
export interface KuzuQueryResult {
  results: unknown[];
  count: number;
}

// Define types for database info
export interface KuzuDatabaseInfo {
  tables: unknown[];
  nodeCount: number;
  relCount: number;
}

// Define types for Kuzu module (since it's from WASM)
type KuzuModule = {
  Database: new (path: string) => unknown;
  Connection: new (database: unknown) => unknown;
  FS: {
    mkdir: (path: string) => Promise<void>;
    mountIdbfs: (path: string) => Promise<void>;
    syncfs: (flag: boolean) => Promise<void>;
    unmount: (path: string) => Promise<void>;
  };
  setWorkerPath?: (path: string) => void;
};

export interface KuzuDBInstance {
  // Basic database operations
  createDatabase(path: string): Promise<void>;
  openDatabase(path: string): Promise<void>;
  closeDatabase(): Promise<void>;
  
  // Query execution
  executeQuery(query: string): Promise<KuzuQueryResult>;
  
  // Schema operations
  createNodeTable(tableName: string, properties: Record<string, string>): Promise<void>;
  createRelTable(tableName: string, properties: Record<string, string>, sourceTable?: string, targetTable?: string): Promise<void>;
  
  // Data operations
  insertNode(tableName: string, properties: Record<string, unknown>): Promise<void>;
  insertRel(tableName: string, sourceId: string, targetId: string, properties: Record<string, unknown>): Promise<void>;
  
  // Utility
  getDatabaseInfo(): Promise<KuzuDatabaseInfo>;
  clearDatabase(): Promise<void>;
}

let kuzuInstance: KuzuDBInstance | null = null;
let kuzuModule: KuzuModule | null = null;
let database: unknown = null;
let connection: unknown = null;

export async function initKuzuDB(): Promise<KuzuDBInstance> {
  if (kuzuInstance) {
    return kuzuInstance;
  }

  try {
    console.log('Loading KuzuDB WASM...');
    
    // Initialize KuzuDB module - it's a function that returns a promise
    if (typeof kuzuWasm === 'function') {
      kuzuModule = await kuzuWasm();
    } else {
      // If it's already an object, use it directly
      kuzuModule = kuzuWasm;
    }
    
    console.log('KuzuDB WASM loaded successfully', kuzuModule);
    
    // Set worker path for multithreaded operations
    if (kuzuModule && kuzuModule.setWorkerPath) {
      kuzuModule.setWorkerPath('/kuzu/kuzu_wasm_worker.js');
      console.log('KuzuDB worker path set');
    }
    
    // Create KuzuDB instance wrapper
    if (!kuzuModule) {
      throw new Error('KuzuDB module not loaded');
    }
    kuzuInstance = createKuzuDBInstance(kuzuModule);
    
    return kuzuInstance;
    
  } catch (error) {
    console.error('Failed to initialize KuzuDB:', error);
    throw new Error(`KuzuDB initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function createKuzuDBInstance(kuzuModule: KuzuModule): KuzuDBInstance {
  return {
    async createDatabase(path: string): Promise<void> {
      console.log(`Creating database at: ${path}`);
      
      // Set up IDBFS for persistent storage
      if (typeof window !== 'undefined') {
        await kuzuModule.FS.mkdir('/database');
        await kuzuModule.FS.mountIdbfs('/database');
      }
      
      // Create database instance
      database = new kuzuModule.Database(path);
      connection = new kuzuModule.Connection(database);
    },
    
    async openDatabase(path: string): Promise<void> {
      console.log(`Opening database at: ${path}`);
      
      if (!database) {
        // Set up IDBFS for persistent storage
        if (typeof window !== 'undefined') {
          await kuzuModule.FS.mkdir('/database');
          await kuzuModule.FS.mountIdbfs('/database');
          await kuzuModule.FS.syncfs(true);
        }
        
        // Open database instance
        database = new kuzuModule.Database(path);
        connection = new kuzuModule.Connection(database);
      }
    },
    
    async closeDatabase(): Promise<void> {
      console.log('Closing database');
      
      if (connection) {
        const conn = connection as { close: () => Promise<void> };
        await conn.close();
        connection = null;
      }
      
      if (database) {
        const db = database as { close: () => Promise<void> };
        await db.close();
        database = null;
      }
      
      // Sync filesystem for persistence
      if (typeof window !== 'undefined' && kuzuModule.FS) {
        await kuzuModule.FS.syncfs(false);
        await kuzuModule.FS.unmount('/database');
      }
    },
    
    async executeQuery(query: string): Promise<KuzuQueryResult> {
      console.log(`Executing query: ${query}`);
      
      if (!connection) {
        throw new Error('Database not initialized. Call createDatabase() or openDatabase() first.');
      }
      
      // Type assertion for connection since it comes from WASM
      interface QueryResult {
        getAllObjects: () => Promise<unknown[]>;
        close: () => Promise<void>;
      }
      
      const conn = connection as { query: (q: string) => Promise<QueryResult> };
      const queryResult = await conn.query(query);
      const results = await queryResult.getAllObjects();
      const count = results.length;
      
      await queryResult.close();
      
      return { results, count };
    },
    
    async createNodeTable(tableName: string, properties: Record<string, string>): Promise<void> {
      console.log(`Creating node table: ${tableName}`, properties);
      
      const propertyDefs = Object.entries(properties)
        .map(([name, type]) => `${name} ${type}`)
        .join(', ');
      
      const query = `CREATE NODE TABLE ${tableName}(${propertyDefs}, PRIMARY KEY (id))`;
      await this.executeQuery(query);
    },
    
         async createRelTable(tableName: string, properties: Record<string, string>, sourceTable: string = 'Node_File', targetTable: string = 'Node_File'): Promise<void> {
       console.log(`Creating relationship table: ${tableName}`, properties);
       
       const propertyDefs = Object.entries(properties)
         .map(([name, type]) => `${name} ${type}`)
         .join(', ');
       
       const query = `CREATE REL TABLE ${tableName}(FROM ${sourceTable} TO ${targetTable}, ${propertyDefs})`;
       await this.executeQuery(query);
     },
    
    async insertNode(tableName: string, properties: Record<string, unknown>): Promise<void> {
      console.log(`Inserting node into ${tableName}:`, properties);
      
      const columns = Object.keys(properties).join(', ');
      const values = Object.values(properties)
        .map(value => typeof value === 'string' ? `'${value}'` : value)
        .join(', ');
      
      const query = `INSERT INTO ${tableName}(${columns}) VALUES (${values})`;
      await this.executeQuery(query);
    },
    
    async insertRel(tableName: string, sourceId: string, targetId: string, properties: Record<string, unknown>): Promise<void> {
      console.log(`Inserting relationship into ${tableName}: ${sourceId} -> ${targetId}`, properties);
      
      const columns = ['FROM', 'TO', ...Object.keys(properties)].join(', ');
      const values = [`'${sourceId}'`, `'${targetId}'`, ...Object.values(properties)
        .map(value => typeof value === 'string' ? `'${value}'` : value)
      ].join(', ');
      
      const query = `INSERT INTO ${tableName}(${columns}) VALUES (${values})`;
      await this.executeQuery(query);
    },
    
    async getDatabaseInfo(): Promise<KuzuDatabaseInfo> {
      console.log('Getting database info');
      
      // Get table information
      const tablesQuery = "SHOW TABLES";
      const tablesResult = await this.executeQuery(tablesQuery);
      
      // Get node count
      const nodeCountQuery = "MATCH (n) RETURN COUNT(n) as count";
      const nodeResult = await this.executeQuery(nodeCountQuery);
      
      // Get relationship count
      const relCountQuery = "MATCH ()-[r]->() RETURN COUNT(r) as count";
      const relResult = await this.executeQuery(relCountQuery);
      
      return {
        tables: tablesResult.results,
        nodeCount: (nodeResult.results[0] as { count?: number })?.count || 0,
        relCount: (relResult.results[0] as { count?: number })?.count || 0
      };
    },
    
    async clearDatabase(): Promise<void> {
      console.log('Clearing database');
      
      // Drop all tables
      const tablesQuery = "SHOW TABLES";
      const tablesResult = await this.executeQuery(tablesQuery);
      
      for (const table of tablesResult.results) {
        const tableName = (table as { name: string }).name;
        await this.executeQuery(`DROP TABLE ${tableName}`);
      }
    }
  };
}

export function getKuzuDBInstance(): KuzuDBInstance | null {
  return kuzuInstance;
}

export function resetKuzuDB(): void {
  kuzuInstance = null;
}
