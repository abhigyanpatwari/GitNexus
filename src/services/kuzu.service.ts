import { initKuzuDB, type KuzuDBInstance } from '../core/kuzu/kuzu-loader.js';
import type { KnowledgeGraph, GraphNode, GraphRelationship, NodeLabel, RelationshipType } from '../core/graph/types.js';

export interface KuzuDBSchema {
  nodeTables: Map<string, NodeTableSchema>;
  relTables: Map<string, RelTableSchema>;
}

interface NodeTableSchema {
  name: string;
  properties: Record<string, string>; // property name -> type
  primaryKey: string;
}

interface RelTableSchema {
  name: string;
  sourceTable: string;
  targetTable: string;
  properties: Record<string, string>; // property name -> type
}

export interface KuzuQueryResult {
  results: any[];
  count: number;
  executionTime: number;
}

export class KuzuService {
  private kuzuInstance: KuzuDBInstance | null = null;
  private schema: KuzuDBSchema;
  private databasePath: string;
  private isInitialized: boolean = false;

  constructor() {
    this.schema = {
      nodeTables: new Map(),
      relTables: new Map()
    };
    this.databasePath = '/kuzu/gitnexus.db';
  }

  /**
   * Initialize KuzuDB and create schema
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      console.log('Initializing KuzuDB service...');
      
      // Initialize KuzuDB WASM
      this.kuzuInstance = await initKuzuDB();
      
      // Create or open database
      await this.kuzuInstance.createDatabase(this.databasePath);
      
      // Create schema
      await this.createSchema();
      
      this.isInitialized = true;
      console.log('KuzuDB service initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize KuzuDB service:', error);
      throw error;
    }
  }

  /**
   * Create the database schema for GitNexus knowledge graph
   */
  private async createSchema(): Promise<void> {
    if (!this.kuzuInstance) {
      throw new Error('KuzuDB not initialized');
    }

    console.log('Creating KuzuDB schema...');

    // Create node tables for each node type
    const nodeTypes: NodeLabel[] = [
      'Project', 'Package', 'Module', 'Folder', 'File', 
      'Class', 'Function', 'Method', 'Variable', 'Interface', 
      'Enum', 'Decorator', 'Import', 'Type', 'CodeElement'
    ];

    for (const nodeType of nodeTypes) {
      const tableName = `Node_${nodeType}`;
      const properties = {
        id: 'STRING',
        name: 'STRING',
        path: 'STRING',
        filePath: 'STRING',
        language: 'STRING',
        startLine: 'INT64',
        endLine: 'INT64',
        type: 'STRING',
        parameters: 'STRING', // JSON string
        returnType: 'STRING',
        accessibility: 'STRING',
        isStatic: 'BOOL',
        isAsync: 'BOOL',
        parentClass: 'STRING',
        decorators: 'STRING', // JSON string
        extends: 'STRING', // JSON string
        implements: 'STRING', // JSON string
        importPath: 'STRING',
        exportType: 'STRING',
        docstring: 'STRING',
        size: 'INT64',
        definitionCount: 'INT64',
        lineCount: 'INT64',
        qualifiedName: 'STRING'
      };

      this.schema.nodeTables.set(nodeType, {
        name: tableName,
        properties,
        primaryKey: 'id'
      });

      await this.kuzuInstance.createNodeTable(tableName, properties);
    }

    // Create relationship tables
    const relTypes: RelationshipType[] = [
      'CONTAINS', 'CALLS', 'INHERITS', 'OVERRIDES', 'IMPORTS',
      'USES', 'DEFINES', 'DECORATES', 'IMPLEMENTS', 'ACCESSES',
      'EXTENDS', 'BELONGS_TO'
    ];

    for (const relType of relTypes) {
      const tableName = `Rel_${relType}`;
      const properties = {
        id: 'STRING',
        source: 'STRING',
        target: 'STRING',
        strength: 'DOUBLE',
        confidence: 'DOUBLE',
        importType: 'STRING',
        alias: 'STRING',
        callType: 'STRING',
        arguments: 'STRING', // JSON string
        dependencyType: 'STRING',
        version: 'STRING',
        filePath: 'STRING',
        line_number: 'INT64'
      };

      this.schema.relTables.set(relType, {
        name: tableName,
        sourceTable: 'Node_File', // Default, will be updated based on actual relationships
        targetTable: 'Node_File',
        properties
      });

      await this.kuzuInstance.createRelTable(tableName, properties);
    }

    console.log('KuzuDB schema created successfully');
  }

  /**
   * Import knowledge graph data into KuzuDB
   */
  async importKnowledgeGraph(graph: KnowledgeGraph): Promise<void> {
    if (!this.kuzuInstance) {
      throw new Error('KuzuDB not initialized');
    }

    console.log(`Importing knowledge graph with ${graph.nodes.length} nodes and ${graph.relationships.length} relationships`);

    // Import nodes
    for (const node of graph.nodes) {
      await this.insertNode(node);
    }

    // Import relationships
    for (const rel of graph.relationships) {
      await this.insertRelationship(rel);
    }

    console.log('Knowledge graph imported successfully');
  }

  /**
   * Insert a node into KuzuDB
   */
  private async insertNode(node: GraphNode): Promise<void> {
    if (!this.kuzuInstance) {
      throw new Error('KuzuDB not initialized');
    }

    const tableName = `Node_${node.label}`;
    const properties = {
      ...node.properties,
      id: node.id
    };

    await this.kuzuInstance.insertNode(tableName, properties);
  }

  /**
   * Insert a relationship into KuzuDB
   */
  private async insertRelationship(rel: GraphRelationship): Promise<void> {
    if (!this.kuzuInstance) {
      throw new Error('KuzuDB not initialized');
    }

    const tableName = `Rel_${rel.type}`;
    const properties = {
      ...rel.properties,
      id: rel.id,
      source: rel.source,
      target: rel.target
    };

    await this.kuzuInstance.insertRel(tableName, rel.source, rel.target, properties);
  }

  /**
   * Execute a Cypher query
   */
  async executeQuery(query: string): Promise<KuzuQueryResult> {
    if (!this.kuzuInstance) {
      throw new Error('KuzuDB not initialized');
    }

    const startTime = performance.now();
    
    try {
      const result = await this.kuzuInstance.executeQuery(query);
      const executionTime = performance.now() - startTime;

      return {
        results: result.results || [],
        count: result.count || 0,
        executionTime
      };
    } catch (error) {
      console.error('KuzuDB query execution failed:', error);
      throw new Error(`Query execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get database statistics
   */
  async getDatabaseStats(): Promise<any> {
    if (!this.kuzuInstance) {
      throw new Error('KuzuDB not initialized');
    }

    return await this.kuzuInstance.getDatabaseInfo();
  }

  /**
   * Clear all data from the database
   */
  async clearDatabase(): Promise<void> {
    if (!this.kuzuInstance) {
      throw new Error('KuzuDB not initialized');
    }

    await this.kuzuInstance.clearDatabase();
    console.log('KuzuDB database cleared');
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.kuzuInstance) {
      await this.kuzuInstance.closeDatabase();
      this.isInitialized = false;
      console.log('KuzuDB connection closed');
    }
  }

  /**
   * Get the current schema
   */
  getSchema(): KuzuDBSchema {
    return this.schema;
  }

  /**
   * Check if the service is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.kuzuInstance !== null;
  }
}
