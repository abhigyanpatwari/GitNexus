import { KuzuService, type KuzuQueryResult } from '../../services/kuzu.service.js';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from './types.js';

export interface KuzuQueryOptions {
  timeout?: number;
  maxResults?: number;
  includeExecutionTime?: boolean;
}

export interface KuzuQueryResponse {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  executionTime: number;
  resultCount: number;
  warnings?: string[];
}

export class KuzuQueryEngine {
  private kuzuService: KuzuService;
  private isInitialized: boolean = false;

  constructor() {
    this.kuzuService = new KuzuService();
  }

  /**
   * Initialize the query engine
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    await this.kuzuService.initialize();
    this.isInitialized = true;
  }

  /**
   * Execute a Cypher query and return results in GitNexus format
   */
  async executeQuery(
    cypherQuery: string, 
    options: KuzuQueryOptions = {}
  ): Promise<KuzuQueryResponse> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const startTime = performance.now();
    
    try {
      // Execute query in KuzuDB
      const result = await this.kuzuService.executeQuery(cypherQuery);
      
      // Convert KuzuDB results to GitNexus format
      const { nodes, relationships } = this.convertKuzuResultsToGraph(result.results);
      
      const executionTime = performance.now() - startTime;

      return {
        nodes,
        relationships,
        executionTime,
        resultCount: result.count,
        warnings: options.includeExecutionTime ? [`Query executed in ${executionTime.toFixed(2)}ms`] : undefined
      };

    } catch (error) {
      console.error('KuzuDB query execution failed:', error);
      throw new Error(`Query execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Convert KuzuDB query results to GitNexus graph format
   */
  private convertKuzuResultsToGraph(kuzuResults: any[]): {
    nodes: GraphNode[];
    relationships: GraphRelationship[];
  } {
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const nodeMap = new Map<string, GraphNode>();
    const relMap = new Map<string, GraphRelationship>();

    for (const result of kuzuResults) {
      // Extract nodes from result
      for (const [key, value] of Object.entries(result)) {
        if (this.isNodeResult(value)) {
          const node = this.convertKuzuNodeToGraphNode(value);
          if (!nodeMap.has(node.id)) {
            nodeMap.set(node.id, node);
            nodes.push(node);
          }
        }
      }

      // Extract relationships from result
      for (const [key, value] of Object.entries(result)) {
        if (this.isRelationshipResult(value)) {
          const rel = this.convertKuzuRelToGraphRel(value);
          if (!relMap.has(rel.id)) {
            relMap.set(rel.id, rel);
            relationships.push(rel);
          }
        }
      }
    }

    return { nodes, relationships };
  }

  /**
   * Check if a result value represents a node
   */
  private isNodeResult(value: any): boolean {
    return value && typeof value === 'object' && 
           (value._label || value.label) && 
           (value._id || value.id);
  }

  /**
   * Check if a result value represents a relationship
   */
  private isRelationshipResult(value: any): boolean {
    return value && typeof value === 'object' && 
           (value._type || value.type) && 
           (value._source || value.source) && 
           (value._target || value.target);
  }

  /**
   * Convert KuzuDB node format to GitNexus node format
   */
  private convertKuzuNodeToGraphNode(kuzuNode: any): GraphNode {
    return {
      id: kuzuNode._id || kuzuNode.id,
      label: (kuzuNode._label || kuzuNode.label) as any,
      properties: {
        ...kuzuNode,
        // Remove internal KuzuDB properties
        _id: undefined,
        _label: undefined,
        id: kuzuNode._id || kuzuNode.id,
        label: kuzuNode._label || kuzuNode.label
      }
    };
  }

  /**
   * Convert KuzuDB relationship format to GitNexus relationship format
   */
  private convertKuzuRelToGraphRel(kuzuRel: any): GraphRelationship {
    return {
      id: kuzuRel._id || kuzuRel.id,
      type: (kuzuRel._type || kuzuRel.type) as any,
      source: kuzuRel._source || kuzuRel.source,
      target: kuzuRel._target || kuzuRel.target,
      properties: {
        ...kuzuRel,
        // Remove internal KuzuDB properties
        _id: undefined,
        _type: undefined,
        _source: undefined,
        _target: undefined,
        id: kuzuRel._id || kuzuRel.id,
        type: kuzuRel._type || kuzuRel.type,
        source: kuzuRel._source || kuzuRel.source,
        target: kuzuRel._target || kuzuRel.target
      }
    };
  }

  /**
   * Execute a simple node query
   */
  async queryNodes(
    nodeType?: string, 
    filters?: Record<string, any>,
    options: KuzuQueryOptions = {}
  ): Promise<GraphNode[]> {
    let cypherQuery = 'MATCH (n';
    
    if (nodeType) {
      cypherQuery += `:${nodeType}`;
    }
    
    cypherQuery += ')';
    
    if (filters && Object.keys(filters).length > 0) {
      const filterConditions = Object.entries(filters)
        .map(([key, value]) => `n.${key} = '${value}'`)
        .join(' AND ');
      cypherQuery += ` WHERE ${filterConditions}`;
    }
    
    cypherQuery += ' RETURN n';
    
    if (options.maxResults) {
      cypherQuery += ` LIMIT ${options.maxResults}`;
    }

    const result = await this.executeQuery(cypherQuery, options);
    return result.nodes;
  }

  /**
   * Execute a simple relationship query
   */
  async queryRelationships(
    relType?: string,
    sourceNodeId?: string,
    targetNodeId?: string,
    options: KuzuQueryOptions = {}
  ): Promise<GraphRelationship[]> {
    let cypherQuery = 'MATCH (a)';
    
    if (relType) {
      cypherQuery += `-[r:${relType}]`;
    } else {
      cypherQuery += '-[r]';
    }
    
    cypherQuery += '->(b)';
    
    const conditions = [];
    if (sourceNodeId) {
      conditions.push(`a.id = '${sourceNodeId}'`);
    }
    if (targetNodeId) {
      conditions.push(`b.id = '${targetNodeId}'`);
    }
    
    if (conditions.length > 0) {
      cypherQuery += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    cypherQuery += ' RETURN r';
    
    if (options.maxResults) {
      cypherQuery += ` LIMIT ${options.maxResults}`;
    }

    const result = await this.executeQuery(cypherQuery, options);
    return result.relationships;
  }

  /**
   * Get database statistics
   */
  async getDatabaseStats(): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    return await this.kuzuService.getDatabaseStats();
  }

  /**
   * Import knowledge graph into KuzuDB
   */
  async importGraph(graph: KnowledgeGraph): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    await this.kuzuService.importKnowledgeGraph(graph);
  }

  /**
   * Clear the database
   */
  async clearDatabase(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    await this.kuzuService.clearDatabase();
  }

  /**
   * Close the query engine
   */
  async close(): Promise<void> {
    await this.kuzuService.close();
    this.isInitialized = false;
  }

  /**
   * Check if the query engine is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.kuzuService.isReady();
  }
}
