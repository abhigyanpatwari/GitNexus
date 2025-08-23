import type { GraphNode, GraphRelationship, KuzuKnowledgeGraphInterface, KnowledgeGraph, NodeLabel, NodeProperties, RelationshipType, RelationshipProperties } from './types';
import { KuzuService } from '../../services/kuzu.service';

/**
 * KuzuKnowledgeGraph - Direct KuzuDB Integration
 *
 * Implements both KuzuKnowledgeGraphInterface and KnowledgeGraph interfaces
 * for maximum compatibility with direct KuzuDB operations and traditional graph access.
 */
export class KuzuKnowledgeGraph implements KuzuKnowledgeGraphInterface, KnowledgeGraph {
  private kuzuService: KuzuService;
  private nodeCount: number = 0;
  private relationshipCount: number = 0;
  private isInitialized: boolean = false;
  private _nodes: GraphNode[] = [];
  private _relationships: GraphRelationship[] = [];

  constructor() {
    this.kuzuService = new KuzuService();
  }

  /**
   * Get nodes array (implements KnowledgeGraph interface)
   * Returns cached nodes from KuzuDB queries
   */
  get nodes(): GraphNode[] {
    return this._nodes;
  }

  /**
   * Get relationships array (implements KnowledgeGraph interface)
   * Returns cached relationships from KuzuDB queries
   */
  get relationships(): GraphRelationship[] {
    return this._relationships;
  }

  /**
   * Initialize the KuzuKnowledgeGraph with KuzuDB
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    console.log('🔧 Initializing KuzuKnowledgeGraph with KuzuDB...');
    await this.kuzuService.initialize();
    
    // Verify schema was created properly
    await this.verifySchema();
    
    this.isInitialized = true;
    console.log('✅ KuzuKnowledgeGraph initialized with direct KuzuDB integration');
  }

  /**
   * Verify that the schema was created properly
   */
  private async verifySchema(): Promise<void> {
    console.log('🔍 Verifying KuzuDB schema...');
    
    try {
      // Test if we can query basic node types
      const nodeTypes = ['Project', 'Folder', 'File', 'Function', 'Class', 'Method'];
      for (const nodeType of nodeTypes) {
        try {
          await this.kuzuService.executeQuery(`MATCH (n:${nodeType}) RETURN count(n) as count LIMIT 1`);
          console.log(`✅ Node table ${nodeType} exists and is queryable`);
        } catch (error) {
          console.error(`❌ Node table ${nodeType} is not queryable:`, error);
        }
      }

      // Test if we can query basic relationship types
      const relTypes = ['CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS'];
      for (const relType of relTypes) {
        try {
          await this.kuzuService.executeQuery(`MATCH ()-[r:${relType}]->() RETURN count(r) as count LIMIT 1`);
          console.log(`✅ Relationship table ${relType} exists and is queryable`);
        } catch (error) {
          console.error(`❌ Relationship table ${relType} is not queryable:`, error);
        }
      }
      
      console.log('🔍 Schema verification completed');
    } catch (error) {
      console.error('❌ Schema verification failed:', error);
      throw error;
    }
  }

  /**
   * Add a node directly to KuzuDB
   */
  async addNode(node: GraphNode): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('KuzuKnowledgeGraph not initialized');
    }

    try {
      await this.kuzuService['insertNode'](node);
      this.nodeCount++;
      
      if (this.nodeCount % 100 === 0) {
        console.log(`Added ${this.nodeCount} nodes to KuzuDB`);
      }
    } catch (error) {
      console.error(`Failed to add node ${node.id}:`, error);
      throw error;
    }
  }

  /**
   * Populate cached arrays from KuzuDB for compatibility with KnowledgeGraph interface
   * This method should be called after data is inserted to ensure import service can access the data
   */
  async populateCache(): Promise<void> {
    if (!this.isInitialized) {
      console.error('❌ POPULATE CACHE: KuzuKnowledgeGraph not initialized');
      throw new Error('KuzuKnowledgeGraph not initialized');
    }

    console.log('🔄 Starting cache population from KuzuDB...');

    // Check database state first
    try {
      const dbStats = await this.kuzuService.getDatabaseStats();
      console.log('🔍 Database stats:', dbStats);
    } catch (dbError) {
      console.error('❌ Failed to get database stats:', dbError);
    }

    try {
      // Clear existing arrays first
      console.log('🔄 POPULATE CACHE: Clearing existing arrays...');
      this._nodes = [];
      this._relationships = [];

      let nodes: GraphNode[] = [];
      try {
        nodes = await this.getNodesForVisualization(10000);
        console.log(`🔄 Retrieved ${nodes.length} nodes from KuzuDB`);
      } catch (nodeError) {
        console.error('❌ Failed to fetch nodes:', nodeError);
        nodes = [];
      }

      let relationships: GraphRelationship[] = [];
      try {
        relationships = await this.getRelationshipsForVisualization(10000);
        console.log(`🔄 Retrieved ${relationships.length} relationships from KuzuDB`);
      } catch (relError) {
        console.error('❌ Failed to fetch relationships:', relError);
        relationships = [];
      }

      this._nodes = nodes;
      this._relationships = relationships;

      if (nodes.length === 0) {
        console.warn('⚠️ No nodes found in KuzuDB!');
      }
      if (relationships.length === 0) {
        console.warn('⚠️ No relationships found in KuzuDB!');
      }

      console.log(`✅ Cache populated: ${nodes.length} nodes, ${relationships.length} relationships`);

    } catch (error) {
      console.error('❌❌❌ POPULATE CACHE: Failed to populate cache:', error);
      console.error('❌ POPULATE CACHE: Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : 'Unknown'
      });
      throw error;
    }
  }

  /**
   * Add a relationship directly to KuzuDB (implements KuzuKnowledgeGraphInterface)
   */
  async addRelationship(relationship: GraphRelationship): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('KuzuKnowledgeGraph not initialized');
    }

    try {
      await this.kuzuService['insertRelationship'](relationship);
      this.relationshipCount++;
      
      if (this.relationshipCount % 100 === 0) {
        console.log(`Added ${this.relationshipCount} relationships to KuzuDB`);
      }
    } catch (error) {
      console.error(`Failed to add relationship ${relationship.id}:`, error);
      throw error;
    }
  }

  /**
   * Get node count (implements KuzuKnowledgeGraphInterface)
   */
  getNodeCount(): number {
    return this.nodeCount;
  }

  /**
   * Get relationship count (implements KuzuKnowledgeGraphInterface)
   */
  getRelationshipCount(): number {
    return this.relationshipCount;
  }

  /**
   * Execute a Cypher query directly (implements KuzuKnowledgeGraphInterface)
   */
  async executeQuery(cypher: string): Promise<unknown> {
    if (!this.isInitialized) {
      throw new Error('KuzuKnowledgeGraph not initialized');
    }

    return await this.kuzuService.executeQuery(cypher);
  }

  /**
   * Clear all data (implements KuzuKnowledgeGraphInterface)
   */
  async clear(): Promise<void> {
    if (!this.isInitialized) return;

    await this.kuzuService.executeQuery('MATCH (n) DETACH DELETE n');
    this.nodeCount = 0;
    this.relationshipCount = 0;
  }



  /**
   * Get the underlying KuzuService for advanced operations
   */
  getKuzuService(): KuzuService {
    return this.kuzuService;
  }

  /**
   * Get nodes for visualization (on-demand query)
   * This method queries KuzuDB to get nodes for visualization purposes
   */
  async getNodesForVisualization(limit: number = 1000): Promise<GraphNode[]> {
    if (!this.isInitialized) {
      throw new Error('KuzuKnowledgeGraph not initialized');
    }

    const cypher = `MATCH (n) RETURN n LIMIT ${limit}`;
    // console.log('🔍 KuzuKnowledgeGraph: Executing query for nodes:', cypher);
    const result = await this.kuzuService.executeQuery(cypher);

    // console.log('🔍 KuzuKnowledgeGraph: Node query result:', {
    //   count: result.count,
    //   resultsLength: result.results?.length || 0,
    //   results: result.results
    // });
    
    // Debug: Log the structure of the first result
    // if (result.results && result.results.length > 0) {
    //   console.log('🔍 KuzuKnowledgeGraph: First result structure:', {
    //     firstResult: result.results[0],
    //     keys: Object.keys(result.results[0]),
    //     firstResultType: typeof result.results[0],
    //     firstResultKeys: result.results[0] ? Object.keys(result.results[0]) : []
    //   });
    // }
    
    // Convert KuzuDB result to GraphNode format
    // KuzuDB returns nodes as objects with properties
    const nodes: GraphNode[] = [];
    if (result.results && Array.isArray(result.results)) {
      for (const row of result.results) {
        // console.log('🔍 KuzuKnowledgeGraph: Processing row:', row);
        
        // Each row should have a 'n' property containing the node
        if (row.n && typeof row.n === 'object') {
          const nodeData = row.n;
          // console.log('🔍 KuzuKnowledgeGraph: Node data:', nodeData);
          
          // Extract node properties from KuzuDB format
          const node: GraphNode = {
            id: String((nodeData as Record<string, unknown>).id || (nodeData as Record<string, unknown>)._id || ''),
            label: this.extractNodeLabel(nodeData as Record<string, unknown>),
            properties: this.extractNodeProperties(nodeData as Record<string, unknown>)
          };
          
          // console.log('🔍 KuzuKnowledgeGraph: Converted node:', node);
          nodes.push(node);
        }
      }
    }
    
    // console.log('🔍 KuzuKnowledgeGraph: Extracted nodes:', nodes.length);
    return nodes;
  }

  /**
   * TEST METHOD: Test relationship queries using KuzuDB-compatible patterns
   * This method tests individual relationship types since LABEL() function isn't supported
   */
  async testRelationshipQuery(limit: number = 10): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('KuzuKnowledgeGraph not initialized');
    }

    // console.log('🧪 TESTING: Relationship query patterns for KuzuDB');

    // Test individual relationship types (since LABEL() isn't supported in KuzuDB)
    const relationshipTypes = ['CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS'];
    let totalFound = 0;

    for (const relType of relationshipTypes) {
      try {
        console.log(`🧪 Testing ${relType} relationships...`);
        const cypher = `MATCH (a)-[r:${relType}]->(b) RETURN a.id as sourceId, r, b.id as targetId LIMIT ${limit}`;
        const result = await this.kuzuService.executeQuery(cypher);

        console.log(`🧪 ${relType}: Found ${result.results?.length || 0} relationships`);
        totalFound += result.results?.length || 0;

        if (result.results && result.results.length > 0) {
          console.log(`🧪 SUCCESS: ${relType} query works!`);
          // Show first relationship as example
          const first = result.results[0];
          console.log(`🧪 Sample ${relType}:`, {
            source: typeof first.sourceId === 'string' ? first.sourceId : 'unknown',
            target: typeof first.targetId === 'string' ? first.targetId : 'unknown',
            relationshipData: first.r
          });
        }
      } catch (error) {
        console.error(`🧪 ERROR testing ${relType}:`, error);
      }
    }

    console.log(`🧪 TOTAL: Found ${totalFound} relationships across all tested types`);

    if (totalFound === 0) {
      console.log('🧪 WARNING: No relationships found with any query pattern');
    } else {
      console.log('🧪 SUCCESS: At least some relationship queries are working!');
    }
  }

  /**
   * Test individual relationship types to debug which ones work
   */
  private async testIndividualRelationshipTypes(limit: number = 5): Promise<void> {
    const relationshipTypes = ['CONTAINS', 'DEFINES', 'EXTENDS', 'IMPLEMENTS', 'IMPORTS', 'BELONGS_TO', 'CALLS'];

    console.log('🧪 Testing individual relationship types...');

    for (const relType of relationshipTypes) {
      try {
        const cypher = `MATCH (a)-[r:${relType}]->(b) RETURN a, r, b LIMIT ${limit}`;
        const result = await this.kuzuService.executeQuery(cypher);

        console.log(`🧪 ${relType}: Found ${result.results?.length || 0} relationships`);
      } catch (error) {
        console.error(`🧪 ${relType}: Error -`, error);
      }
    }
  }

  /**
   * DEBUG: Inspect KuzuDB relationship data using working query patterns
   */
  async debugRelationshipSchema(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('KuzuKnowledgeGraph not initialized');
    }

    console.log('🔍 DEBUG: Inspecting KuzuDB relationship data...');

    try {
      // Test individual relationship types that we know exist
      const relationshipTypes = ['CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS'];

      for (const relType of relationshipTypes) {
        try {
          console.log(`🔍 DEBUG: Testing ${relType} relationships...`);
          const query = `MATCH (a)-[r:${relType}]->(b) RETURN a.id as source, b.id as target, r LIMIT 3`;
          const result = await this.kuzuService.executeQuery(query);

          console.log(`🔍 DEBUG: ${relType} found ${result.results?.length || 0} relationships`);
          if (result.results && result.results.length > 0) {
            console.log(`🔍 DEBUG: Sample ${relType} relationship:`, result.results[0]);
          }
        } catch (error) {
          console.error(`🔍 DEBUG: Error querying ${relType}:`, error);
        }
      }

      // Test if any relationships exist at all
      console.log('🔍 DEBUG: Testing if any relationships exist...');
      const anyRelQuery = `MATCH (a)-[r]->(b) RETURN a.id as source, b.id as target LIMIT 1`;
      const anyRelResult = await this.kuzuService.executeQuery(anyRelQuery);
      console.log('🔍 DEBUG: Any relationships found:', anyRelResult.results?.length || 0);

      if (anyRelResult.results && anyRelResult.results.length > 0) {
        console.log('🔍 DEBUG: Sample relationship structure:', anyRelResult.results[0]);
      }

    } catch (error) {
      console.error('🔍 DEBUG: Error inspecting relationships:', error);
    }
  }

  /**
   * Get relationships for visualization (on-demand query)
   * This method queries KuzuDB to get relationships for visualization purposes
   * Using simplified patterns that work reliably with KuzuDB
   */
  async getRelationshipsForVisualization(limit: number = 1000): Promise<GraphRelationship[]> {
    if (!this.isInitialized) {
      throw new Error('KuzuKnowledgeGraph not initialized');
    }

    // console.log('🔍 KuzuKnowledgeGraph: Getting relationships for visualization...');

    // First, check which relationship tables actually exist in the database
    const existingRelationshipTypes = await this.getExistingRelationshipTypes();
    
    if (existingRelationshipTypes.length === 0) {
      console.log('🔍 KuzuKnowledgeGraph: No relationship tables found in database');
      return [];
    }

    console.log('🔍 KuzuKnowledgeGraph: Found relationship tables:', existingRelationshipTypes);

    const workingRelationships: GraphRelationship[] = [];

    for (const relType of existingRelationshipTypes) {
      try {
        // console.log(`🔍 Testing relationship type: ${relType}`);
        const cypher = `MATCH (a)-[r:${relType}]->(b) RETURN a, r, b LIMIT ${Math.ceil(limit / existingRelationshipTypes.length)}`;
        const result = await this.kuzuService.executeQuery(cypher);

        // console.log(`🔍 ${relType}: Found ${result.results?.length || 0} relationships`);

        if (result.results && result.results.length > 0) {
          const processed = this.processRelationshipResultsForType(result.results, relType);
          workingRelationships.push(...processed);
          // console.log(`✅ ${relType}: Successfully processed ${processed.length} relationships`);
        }
      } catch (error) {
        console.error(`❌ ${relType}: Query failed:`, error);
      }
    }

    // console.log(`🔍 KuzuKnowledgeGraph: Total relationships found: ${workingRelationships.length}`);
    return workingRelationships.slice(0, limit); // Ensure we don't exceed the limit
  }

  /**
   * Process relationship query results into GraphRelationship format
   */
  private processRelationshipResults(results: unknown[]): GraphRelationship[] {
    const relationships: GraphRelationship[] = [];

    if (results && Array.isArray(results)) {
      for (const row of results) {
        // console.log('🔍 KuzuKnowledgeGraph: Processing relationship row:', row);

        // Check if row is a valid object with expected properties
        if (typeof row === 'object' && row !== null &&
            'r' in row && 'a' in row && 'b' in row &&
            typeof row.r === 'object' && row.r !== null &&
            typeof row.a === 'object' && row.a !== null &&
            typeof row.b === 'object' && row.b !== null) {
          const relData = row.r as Record<string, unknown>;
          const sourceData = row.a as Record<string, unknown>;
          const targetData = row.b as Record<string, unknown>;

          // console.log('🔍 KuzuKnowledgeGraph: Relationship data:', relData);
          // console.log('🔍 KuzuKnowledgeGraph: Source data:', sourceData);
          // console.log('🔍 KuzuKnowledgeGraph: Target data:', targetData);

          // Extract relationship properties from KuzuDB format
          const relationship: GraphRelationship = {
            id: String(relData.id || relData._id || ''),
            type: this.extractRelationshipType(relData),
            source: String(sourceData.id || sourceData._id || ''),
            target: String(targetData.id || targetData._id || ''),
            properties: this.extractRelationshipProperties(relData)
          };

          // console.log('🔍 KuzuKnowledgeGraph: Converted relationship:', relationship);
          relationships.push(relationship);
        }
      }
    }

    // console.log('🔍 KuzuKnowledgeGraph: Processed relationships:', relationships.length);
    return relationships;
  }

  /**
   * Process relationship query results for a specific relationship type
   */
  private processRelationshipResultsForType(results: unknown[], relationshipType: string): GraphRelationship[] {
    const relationships: GraphRelationship[] = [];

    if (results && Array.isArray(results)) {
      for (const row of results) {
        // Check if row is a valid object with expected properties
        if (typeof row === 'object' && row !== null &&
            'r' in row && 'a' in row && 'b' in row &&
            typeof row.r === 'object' && row.r !== null &&
            typeof row.a === 'object' && row.a !== null &&
            typeof row.b === 'object' && row.b !== null) {
          const relData = row.r as Record<string, unknown>;
          const sourceData = row.a as Record<string, unknown>;
          const targetData = row.b as Record<string, unknown>;

          // Extract relationship properties from KuzuDB format
          const relationship: GraphRelationship = {
            id: String(relData.id || relData._id || ''),
            type: relationshipType as RelationshipType,
            source: String(sourceData.id || sourceData._id || ''),
            target: String(targetData.id || targetData._id || ''),
            properties: this.extractRelationshipProperties(relData)
          };

          relationships.push(relationship);
        }
      }
    }

    return relationships;
  }

  /**
   * Extract node label from KuzuDB node data
   */
  private extractNodeLabel(nodeData: Record<string, unknown>): NodeLabel {
    // Try to extract label from KuzuDB node format
    if (nodeData._label && typeof nodeData._label === 'string') {
      return nodeData._label as NodeLabel;
    }

    // Fallback: try to determine label from properties
    if (nodeData.type && typeof nodeData.type === 'string') {
      return nodeData.type as NodeLabel;
    }

    // Default to File if we can't determine
    return 'File';
  }

  /**
   * Extract node properties from KuzuDB node data
   */
  private extractNodeProperties(nodeData: Record<string, unknown>): NodeProperties {
    const properties: NodeProperties = {};

    // Copy all properties except internal KuzuDB properties
    for (const [key, value] of Object.entries(nodeData)) {
      if (!key.startsWith('_') && key !== 'id' && key !== '_id') {
        properties[key] = value as string | number | boolean | string[] | undefined;
      }
    }

    return properties;
  }

  /**
   * Extract relationship label from KuzuDB relationship data
   */
  private extractRelationshipType(relData: Record<string, unknown>): RelationshipType {
    // Try to extract type from KuzuDB relationship format
    if (relData._type && typeof relData._type === 'string') {
      return relData._type as RelationshipType;
    }

    if (relData.type && typeof relData.type === 'string') {
      return relData.type as RelationshipType;
    }

    // Default to CONTAINS if we can't determine
    return 'CONTAINS';
  }

  /**
   * Extract relationship properties from KuzuDB relationship data
   */
  private extractRelationshipProperties(relData: Record<string, unknown>): RelationshipProperties {
    const properties: RelationshipProperties = {};

    // Copy all properties except internal KuzuDB properties
    for (const [key, value] of Object.entries(relData)) {
      if (!key.startsWith('_') && key !== 'id' && key !== '_id' && key !== 'source' && key !== 'target') {
        properties[key] = value as string | number | boolean | string[] | undefined;
      }
    }

    return properties;
  }

  async getGraphForVisualization(limit: number = 1000): Promise<KnowledgeGraph> {
    if (!this.isInitialized) {
      throw new Error('KuzuKnowledgeGraph not initialized');
    }

    // console.log('🔍 KuzuKnowledgeGraph: Getting visualization data with limit:', limit);

    const [nodes, relationships] = await Promise.all([
      this.getNodesForVisualization(limit),
      this.getRelationshipsForVisualization(limit)
    ]);

    // console.log('🔍 KuzuKnowledgeGraph: Retrieved visualization data:', {
    //   nodeCount: nodes.length,
    //   relationshipCount: relationships.length,
    //   nodeTypes: [...new Set(nodes.map(n => n.label))],
    //   relationshipTypes: [...new Set(relationships.map(r => r.type))]
    // });

    return {
      nodes,
      relationships
    };
  }

  /**
   * Get list of relationship tables that actually exist in the database
   */
  private async getExistingRelationshipTypes(): Promise<string[]> {
    try {
      // Try a simpler approach - just return the known relationship types
      // since KuzuDB might not support type(r) function
      const knownTypes = ['CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS', 'INHERITS', 'OVERRIDES', 'USES', 'DECORATES', 'IMPLEMENTS', 'ACCESSES', 'EXTENDS', 'BELONGS_TO'];
      
      // Test each type to see if it exists by trying a simple query
      const existingTypes: string[] = [];
      
      console.log('🔍 KuzuKnowledgeGraph: Testing relationship types for existence...');
      
      for (const relType of knownTypes) {
        try {
          const testQuery = `MATCH ()-[r:${relType}]->() RETURN count(r) as count LIMIT 1`;
          console.log(`🔍 Testing ${relType} with query: ${testQuery}`);
          const result = await this.kuzuService.executeQuery(testQuery);
          
          // If the query succeeds (no exception thrown), the relationship type exists
          const count = (result.results[0] as { count?: number })?.count || 0;
          console.log(`✅ ${relType} exists with ${count} relationships`);
          existingTypes.push(relType);
        } catch (error) {
          // Relationship type doesn't exist, skip it
          console.log(`❌ Relationship type ${relType} not found in database:`, error);
        }
      }
      
      console.log(`🔍 KuzuKnowledgeGraph: Found ${existingTypes.length} existing relationship types:`, existingTypes);
      return existingTypes;
    } catch (error) {
      console.warn('🔍 KuzuKnowledgeGraph: Could not query existing relationship types:', error);
      // Fallback: return empty array if we can't query
      return [];
    }
  }

  /**
   * Execute a Cypher query (implements KuzuKnowledgeGraphInterface)
   */
  async query(cypher: string): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('KuzuKnowledgeGraph not initialized');
    }
    return await this.kuzuService.executeQuery(cypher);
  }

  /**
   * Close the KuzuKnowledgeGraph (implements KuzuKnowledgeGraphInterface)
   */
  async close(): Promise<void> {
    if (this.isInitialized) {
      await this.kuzuService.close();
      this.isInitialized = false;
    }
  }
}
