/**
 * KuzuDB WASM Loader
 * Handles loading and initialization of KuzuDB WebAssembly module using the official npm package
 */

import kuzu from 'kuzu-wasm';

export interface KuzuDBInstance {
  // Basic database operations
  createDatabase(path: string): Promise<void>;
  openDatabase(path: string): Promise<void>;
  closeDatabase(): Promise<void>;
  
  // Query execution
  executeQuery(query: string): Promise<any>;
  
  // Schema operations
  createNodeTable(tableName: string, properties: Record<string, string>): Promise<void>;
  createRelTable(tableName: string, properties: Record<string, string>): Promise<void>;
  
  // Data operations
  insertNode(tableName: string, properties: Record<string, any>): Promise<void>;
  insertRel(tableName: string, sourceId: string, targetId: string, properties: Record<string, any>): Promise<void>;
  
  // Utility
  getDatabaseInfo(): Promise<any>;
  clearDatabase(): Promise<void>;
}

let kuzuInstance: KuzuDBInstance | null = null;
let kuzuModule: any = null;
let database: any = null;
let connection: any = null;

export async function initKuzuDB(): Promise<KuzuDBInstance> {
  if (kuzuInstance) {
    return kuzuInstance;
  }

  try {
    console.log('Loading KuzuDB WASM...');
    
    // Set worker path for browser environment
    if (typeof window !== 'undefined') {
      kuzu.setWorkerPath('/node_modules/kuzu-wasm/dist/worker.js');
    }
    
    // Initialize KuzuDB module
    kuzuModule = await kuzu();
    
    console.log('KuzuDB WASM loaded successfully');
    
    // Create KuzuDB instance wrapper
    kuzuInstance = createKuzuDBInstance(kuzuModule);
    
    return kuzuInstance;
    
  } catch (error) {
    console.error('Failed to initialize KuzuDB:', error);
    throw new Error(`KuzuDB initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function createKuzuDBInstance(kuzuModule: any): KuzuDBInstance {
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
        await connection.close();
        connection = null;
      }
      
      if (database) {
        await database.close();
        database = null;
      }
      
      // Sync filesystem for persistence
      if (typeof window !== 'undefined' && kuzuModule.FS) {
        await kuzuModule.FS.syncfs(false);
        await kuzuModule.FS.unmount('/database');
      }
    },
    
    async executeQuery(query: string): Promise<any> {
      console.log(`Executing query: ${query}`);
      
      if (!connection) {
        throw new Error('Database not initialized. Call createDatabase() or openDatabase() first.');
      }
      
      const queryResult = await connection.query(query);
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
    
    async createRelTable(tableName: string, properties: Record<string, string>): Promise<void> {
      console.log(`Creating relationship table: ${tableName}`, properties);
      
      const propertyDefs = Object.entries(properties)
        .map(([name, type]) => `${name} ${type}`)
        .join(', ');
      
      const query = `CREATE REL TABLE ${tableName}(FROM Node TO Node, ${propertyDefs})`;
      await this.executeQuery(query);
    },
    
    async insertNode(tableName: string, properties: Record<string, any>): Promise<void> {
      console.log(`Inserting node into ${tableName}:`, properties);
      
      const columns = Object.keys(properties).join(', ');
      const values = Object.values(properties)
        .map(value => typeof value === 'string' ? `'${value}'` : value)
        .join(', ');
      
      const query = `INSERT INTO ${tableName}(${columns}) VALUES (${values})`;
      await this.executeQuery(query);
    },
    
    async insertRel(tableName: string, sourceId: string, targetId: string, properties: Record<string, any>): Promise<void> {
      console.log(`Inserting relationship into ${tableName}: ${sourceId} -> ${targetId}`, properties);
      
      const columns = ['FROM', 'TO', ...Object.keys(properties)].join(', ');
      const values = [`'${sourceId}'`, `'${targetId}'`, ...Object.values(properties)
        .map(value => typeof value === 'string' ? `'${value}'` : value)
      ].join(', ');
      
      const query = `INSERT INTO ${tableName}(${columns}) VALUES (${values})`;
      await this.executeQuery(query);
    },
    
    async getDatabaseInfo(): Promise<any> {
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
        nodeCount: nodeResult.results[0]?.count || 0,
        relCount: relResult.results[0]?.count || 0
      };
    },
    
    async clearDatabase(): Promise<void> {
      console.log('Clearing database');
      
      // Drop all tables
      const tablesQuery = "SHOW TABLES";
      const tablesResult = await this.executeQuery(tablesQuery);
      
      for (const table of tablesResult.results) {
        const tableName = table.name;
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
