import type { KnowledgeGraph, GraphNode, GraphRelationship } from './types.ts';

export interface QueryResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  data: Record<string, any>[];
}

export interface QueryOptions {
  limit?: number;
  offset?: number;
}

export class GraphQueryEngine {
  constructor(private graph: KnowledgeGraph) {}

  /**
   * Execute a simplified Cypher-like query against the knowledge graph
   */
  public executeQuery(cypher: string, options: QueryOptions = {}): QueryResult {
    const { limit = 100, offset = 0 } = options;
    
    try {
      const parsedQuery = this.parseCypher(cypher);
      
      switch (parsedQuery.type) {
        case 'MATCH':
          return this.executeMatchQuery(parsedQuery, limit, offset);
        case 'MATCH_WHERE':
          return this.executeWhereQuery(parsedQuery, limit, offset);
        case 'MATCH_PATH':
          return this.executePathQuery(parsedQuery, limit, offset);
        case 'MATCH_AGGREGATION':
          return this.executeAggregationQuery(parsedQuery, limit, offset);
        case 'MATCH_RELATIONSHIP':
          return this.executeRelationshipQuery(parsedQuery, limit, offset);
        default:
          throw new Error(`Unsupported query type: ${parsedQuery.type}`);
      }
    } catch (error) {
      console.error('Query execution failed:', error);
      return { nodes: [], relationships: [], data: [] };
    }
  }

  private parseCypher(cypher: string) {
    // Enhanced parsing with WHERE clause support
    const simpleMatchWithWherePattern = /MATCH\s+\((\w+):(\w+)(?:\s*\{([^}]*)\})?\)\s+WHERE\s+(.+?)\s+RETURN\s+(.+)/i;
    const whereMatch = cypher.match(simpleMatchWithWherePattern);
    
    if (whereMatch) {
      const [, variable, label, properties, whereClause, returnClause] = whereMatch;
      return {
        type: 'MATCH_WHERE',
        variable,
        label,
        properties: this.parseProperties(properties || ''),
        whereClause: whereClause.trim(),
        returnClause: returnClause.trim()
      };
    }

    // Variable-length relationship pattern: MATCH (a)-[:REL*1..3]->(b)
    const variableLengthPattern = /MATCH\s+\((\w+)(?::(\w+))?\)-\[:(\w+)\*(\d+)\.\.(\d+)\]->\((\w+)(?::(\w+))?\)\s+RETURN\s+(.+)/i;
    const varLenMatch = cypher.match(variableLengthPattern);
    
    if (varLenMatch) {
      const [, sourceVar, sourceLabel, relType, minDepth, maxDepth, targetVar, targetLabel, returnClause] = varLenMatch;
      return {
        type: 'MATCH_PATH',
        sourceVar,
        sourceLabel,
        relationshipType: relType,
        minDepth: parseInt(minDepth),
        maxDepth: parseInt(maxDepth),
        targetVar,
        targetLabel,
        returnClause: returnClause.trim()
      };
    }

    // Aggregation pattern: MATCH (n:Label) RETURN COUNT(n)
    const aggregationPattern = /MATCH\s+\((\w+):(\w+)(?:\s*\{([^}]*)\})?\)\s+RETURN\s+(COUNT|COLLECT|AVG|SUM)\(([^)]+)\)/i;
    const aggMatch = cypher.match(aggregationPattern);
    
    if (aggMatch) {
      const [, variable, label, properties, aggFunction, aggTarget] = aggMatch;
      return {
        type: 'MATCH_AGGREGATION',
        variable,
        label,
        properties: this.parseProperties(properties || ''),
        aggregationFunction: aggFunction.toUpperCase(),
        aggregationTarget: aggTarget.trim(),
        returnClause: `${aggFunction}(${aggTarget})`
      };
    }

    // Pattern: MATCH (n:Label {property: 'value'}) RETURN n.property
    const simpleMatchPattern = /MATCH\s+\((\w+):(\w+)(?:\s*\{([^}]*)\})?\)\s+RETURN\s+(.+)/i;
    const simpleMatch = cypher.match(simpleMatchPattern);
    
    if (simpleMatch) {
      const [, variable, label, properties, returnClause] = simpleMatch;
      return {
        type: 'MATCH',
        variable,
        label,
        properties: this.parseProperties(properties || ''),
        returnClause: returnClause.trim()
      };
    }

    // Pattern: MATCH (a)-[:RELATIONSHIP]->(b:Label) RETURN a, b
    const relationshipPattern = /MATCH\s+\((\w+)(?::(\w+))?\)-\[:(\w+)\]->\((\w+)(?::(\w+))?\)\s+RETURN\s+(.+)/i;
    const relMatch = cypher.match(relationshipPattern);
    
    if (relMatch) {
      const [, sourceVar, sourceLabel, relType, targetVar, targetLabel, returnClause] = relMatch;
      return {
        type: 'MATCH_RELATIONSHIP',
        sourceVar,
        sourceLabel,
        relationshipType: relType,
        targetVar,
        targetLabel,
        returnClause: returnClause.trim()
      };
    }

    throw new Error(`Cannot parse Cypher query: ${cypher}`);
  }

  private parseProperties(propString: string): Record<string, string> {
    const props: Record<string, string> = {};
    if (!propString.trim()) return props;

    // Simple property parsing: name: 'value', type: 'Function'
    const matches = propString.match(/(\w+):\s*['"]([^'"]*)['"]/g);
    if (matches) {
      matches.forEach(match => {
        const [, key, value] = match.match(/(\w+):\s*['"]([^'"]*)['"]/!) || [];
        if (key && value) {
          props[key] = value;
        }
      });
    }

    return props;
  }

  private executeMatchQuery(query: any, limit: number, offset: number): QueryResult {
    let matchingNodes = this.graph.nodes.filter(node => {
      // Match by label
      if (query.label && node.label !== query.label) {
        return false;
      }

      // Match by properties
      for (const [key, value] of Object.entries(query.properties)) {
        if (node.properties[key] !== value) {
          return false;
        }
      }

      return true;
    });

    // Apply pagination
    matchingNodes = matchingNodes.slice(offset, offset + limit);

    // Process return clause
    const data = matchingNodes.map(node => {
      const result: Record<string, any> = {};
      
      if (query.returnClause.includes(`${query.variable}.`)) {
        // Return specific properties: n.name, n.filePath
        const propertyMatches = query.returnClause.match(new RegExp(`${query.variable}\\.(\\w+)`, 'g'));
        if (propertyMatches) {
          propertyMatches.forEach((match: string) => {
            const prop = match.split('.')[1];
            result[prop] = node.properties[prop];
          });
        }
      } else if (query.returnClause === query.variable) {
        // Return entire node
        result.node = node;
      }

      return result;
    });

    return {
      nodes: matchingNodes,
      relationships: [],
      data
    };
  }

  private executeWhereQuery(query: any, limit: number, offset: number): QueryResult {
    let matchingNodes = this.graph.nodes.filter(node => {
      if (query.label && node.label !== query.label) return false;
      
      for (const [key, value] of Object.entries(query.properties)) {
        if (node.properties[key] !== value) return false;
      }
      
      return this.evaluateWhereClause(node, query.whereClause, query.variable);
    });

    matchingNodes = matchingNodes.slice(offset, offset + limit);
    
    const data = matchingNodes.map(node => {
      const result: Record<string, any> = {};
      if (query.returnClause.includes(`${query.variable}.`)) {
        const propertyMatches = query.returnClause.match(new RegExp(`${query.variable}\\.(\\w+)`, 'g'));
        if (propertyMatches) {
          propertyMatches.forEach((match: string) => {
            const prop = match.split('.')[1];
            result[prop] = node.properties[prop];
          });
        }
      } else if (query.returnClause === query.variable) {
        result.node = node;
      }
      return result;
    });

    return { nodes: matchingNodes, relationships: [], data };
  }

  private evaluateWhereClause(node: GraphNode, whereClause: string, variable: string): boolean {
    // Simple WHERE clause evaluation
    const containsPattern = new RegExp(`${variable}\\.(\\w+)\\s+CONTAINS\\s+['"]([^'"]*)['"]/i`);
    const containsMatch = whereClause.match(containsPattern);
    
    if (containsMatch) {
      const [, property, value] = containsMatch;
      const nodeValue = node.properties[property];
      return typeof nodeValue === 'string' && nodeValue.toLowerCase().includes(value.toLowerCase());
    }
    
    const equalsPattern = new RegExp(`${variable}\\.(\\w+)\\s*=\\s*['"]([^'"]*)['"]/i`);
    const equalsMatch = whereClause.match(equalsPattern);
    
    if (equalsMatch) {
      const [, property, value] = equalsMatch;
      return node.properties[property] === value;
    }
    
    return true;
  }

  private executePathQuery(query: any, limit: number, offset: number): QueryResult {
    // Use existing pathsBetween function from query.ts
    const sourceNodes = this.graph.nodes.filter(n => 
      !query.sourceLabel || n.label === query.sourceLabel
    );
    const targetNodes = this.graph.nodes.filter(n => 
      !query.targetLabel || n.label === query.targetLabel
    );

    const allResults: { source: GraphNode; target: GraphNode; path: GraphRelationship[] }[] = [];
    
    for (const source of sourceNodes.slice(0, 50)) { // Limit source nodes to avoid explosion
      for (const target of targetNodes.slice(0, 50)) {
        if (source.id === target.id) continue;
        
        const paths = this.findPaths(source.id, target.id, query.relationshipType, query.minDepth, query.maxDepth);
        paths.forEach(path => {
          allResults.push({ source, target, path });
        });
      }
    }

    const paginatedResults = allResults.slice(offset, offset + limit);
    
    const data = paginatedResults.map(({ source, target, path }) => {
      const result: Record<string, any> = {};
      if (query.returnClause.includes(query.sourceVar)) {
        result[query.sourceVar] = source;
      }
      if (query.returnClause.includes(query.targetVar)) {
        result[query.targetVar] = target;
      }
      result.pathLength = path.length;
      return result;
    });

    return {
      nodes: paginatedResults.flatMap(r => [r.source, r.target]),
      relationships: paginatedResults.flatMap(r => r.path),
      data
    };
  }

  private findPaths(sourceId: string, targetId: string, relType: string, minDepth: number, maxDepth: number): GraphRelationship[][] {
    const paths: GraphRelationship[][] = [];
    const visited = new Set<string>();
    
    const dfs = (currentId: string, currentPath: GraphRelationship[], depth: number) => {
      if (depth > maxDepth) return;
      if (currentId === targetId && depth >= minDepth) {
        paths.push([...currentPath]);
        return;
      }
      
      visited.add(currentId);
      
      const outgoingRels = this.graph.relationships.filter(r => 
        r.source === currentId && r.type === relType && !visited.has(r.target)
      );
      
      for (const rel of outgoingRels) {
        dfs(rel.target, [...currentPath, rel], depth + 1);
      }
      
      visited.delete(currentId);
    };
    
    dfs(sourceId, [], 0);
    return paths.slice(0, 10); // Limit paths to prevent explosion
  }

  private executeAggregationQuery(query: any, _limit: number, _offset: number): QueryResult {
    let matchingNodes = this.graph.nodes.filter(node => {
      if (query.label && node.label !== query.label) return false;
      
      for (const [key, value] of Object.entries(query.properties)) {
        if (node.properties[key] !== value) return false;
      }
      
      return true;
    });

    let aggregatedValue: any;
    
    switch (query.aggregationFunction) {
      case 'COUNT':
        aggregatedValue = matchingNodes.length;
        break;
      case 'COLLECT':
        const targetProperty = query.aggregationTarget.includes('.') 
          ? query.aggregationTarget.split('.')[1] 
          : 'name';
        aggregatedValue = matchingNodes.map(n => n.properties[targetProperty]).filter(Boolean);
        break;
      default:
        aggregatedValue = matchingNodes.length;
    }

    return {
      nodes: [],
      relationships: [],
      data: [{ [query.returnClause]: aggregatedValue }]
    };
  }

  private executeRelationshipQuery(query: any, limit: number, offset: number): QueryResult {
    const results: { source: GraphNode; target: GraphNode; relationship: GraphRelationship }[] = [];

    // Find all relationships of the specified type
    const matchingRels = this.graph.relationships.filter(rel => 
      rel.type === query.relationshipType
    );

    for (const rel of matchingRels) {
      const sourceNode = this.graph.nodes.find(n => n.id === rel.source);
      const targetNode = this.graph.nodes.find(n => n.id === rel.target);

      if (!sourceNode || !targetNode) continue;

      // Apply label filters
      if (query.sourceLabel && sourceNode.label !== query.sourceLabel) continue;
      if (query.targetLabel && targetNode.label !== query.targetLabel) continue;

      results.push({ source: sourceNode, target: targetNode, relationship: rel });
    }

    // Apply pagination
    const paginatedResults = results.slice(offset, offset + limit);

    // Process return clause
    const data = paginatedResults.map(({ source, target }) => {
      const result: Record<string, any> = {};
      
      if (query.returnClause.includes(query.sourceVar)) {
        result[query.sourceVar] = source;
      }
      if (query.returnClause.includes(query.targetVar)) {
        result[query.targetVar] = target;
      }

      return result;
    });

    return {
      nodes: paginatedResults.flatMap(r => [r.source, r.target]),
      relationships: paginatedResults.map(r => r.relationship),
      data
    };
  }

  /**
   * Test the query engine with sample queries (for development/debugging)
   */
  public testQueries(): { query: string; result: any; success: boolean }[] {
    const testCases = [
      "MATCH (f:Function) RETURN COUNT(f)",
      "MATCH (c:Class) WHERE c.name CONTAINS 'Service' RETURN c.name",
      "MATCH (a:Function)-[:CALLS*1..2]->(b:Function) RETURN a.name, b.name",
      "MATCH (f:File)-[:CONTAINS]->(c:Class) RETURN f.name, COUNT(c)",
      "MATCH (m:Method) WHERE m.name CONTAINS 'get' RETURN COLLECT(m.name)"
    ];

    return testCases.map(query => {
      try {
        const result = this.executeQuery(query, { limit: 5 });
        return { query, result, success: true };
      } catch (error) {
        return { 
          query, 
          result: error instanceof Error ? error.message : 'Unknown error', 
          success: false 
        };
      }
    });
  }

  /**
   * Get query statistics
   */
  public getStats(): { nodeCount: number; relationshipCount: number; nodeTypes: string[]; relationshipTypes: string[] } {
    const nodeTypes = [...new Set(this.graph.nodes.map(n => n.label))];
    const relationshipTypes = [...new Set(this.graph.relationships.map(r => r.type))];

    return {
      nodeCount: this.graph.nodes.length,
      relationshipCount: this.graph.relationships.length,
      nodeTypes,
      relationshipTypes
    };
  }

  /**
   * Find nodes by text search
   */
  public searchNodes(searchTerm: string, nodeType?: string): GraphNode[] {
    const lowerSearch = searchTerm.toLowerCase();
    
    return this.graph.nodes.filter(node => {
      if (nodeType && node.label !== nodeType) return false;
      
      // Search in node properties
      const searchableText = [
        node.properties.name,
        node.properties.filePath,
        node.properties.qualifiedName
      ].filter(Boolean).join(' ').toLowerCase();
      
      return searchableText.includes(lowerSearch);
    });
  }

  /**
   * Get all relationships for a node
   */
  public getNodeRelationships(nodeId: string): { incoming: GraphRelationship[]; outgoing: GraphRelationship[] } {
    const incoming = this.graph.relationships.filter(r => r.target === nodeId);
    const outgoing = this.graph.relationships.filter(r => r.source === nodeId);
    
    return { incoming, outgoing };
  }
} 