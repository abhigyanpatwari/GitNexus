import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { LLMService, LLMConfig } from './llm-service.ts';
import type { KnowledgeGraph } from '../core/graph/types.ts';

export interface CypherQuery {
  cypher: string;
  explanation: string;
  confidence: number;
  warnings?: string[];
}

export interface CypherGenerationOptions {
  maxRetries?: number;
  includeExamples?: boolean;
  strictMode?: boolean;
}

export class CypherGenerator {
  private llmService: LLMService;
  private graphSchema: string = '';
  
  // Common Cypher patterns and examples
  private static readonly CYPHER_EXAMPLES = [
    {
      question: "What functions are in the main.py file?",
      cypher: "MATCH (f:File {name: 'main.py'})-[:CONTAINS]->(func:Function) RETURN func.name, func.startLine"
    },
    {
      question: "Which functions call the authenticate function?",
      cypher: "MATCH (caller)-[:CALLS]->(target:Function {name: 'authenticate'}) RETURN caller.name, caller.filePath"
    },
    {
      question: "Show me all classes in the project",
      cypher: "MATCH (c:Class) RETURN c.name, c.filePath"
    },
    {
      question: "What classes inherit from BaseService?",
      cypher: "MATCH (child:Class)-[:INHERITS]->(parent:Class {name: 'BaseService'}) RETURN child.name, child.filePath"
    },
    {
      question: "Find all methods in the UserService class",
      cypher: "MATCH (c:Class {name: 'UserService'})-[:CONTAINS]->(m:Method) RETURN m.name, m.startLine"
    },
    {
      question: "Which methods override the save method?",
      cypher: "MATCH (child:Method)-[:OVERRIDES]->(parent:Method {name: 'save'}) RETURN child.name, child.parentClass"
    },
    {
      question: "Show all interfaces and the classes that implement them",
      cypher: "MATCH (c:Class)-[:IMPLEMENTS]->(i:Interface) RETURN i.name, c.name"
    },
    {
      question: "Find functions decorated with @app.route",
      cypher: "MATCH (d:Decorator {name: 'app.route'})-[:DECORATES]->(f:Function) RETURN f.name, f.filePath"
    },
    {
      question: "What files import the requests module?",
      cypher: "MATCH (f:File)-[:IMPORTS]->(target) WHERE target.name CONTAINS 'requests' RETURN f.name"
    },
    {
      question: "Show the call chain from main to database functions",
      cypher: "MATCH (main:Function {name: 'main'})-[:CALLS*1..3]->(db:Function) WHERE db.name CONTAINS 'db' OR db.name CONTAINS 'database' RETURN main.name, db.name"
    },
    {
      question: "Find all functions containing 'user' in their name",
      cypher: "MATCH (f:Function) WHERE f.name CONTAINS 'user' RETURN f.name, f.filePath"
    },
    {
      question: "What functions are called through a chain of 2-4 calls from the main function?",
      cypher: "MATCH (main:Function {name: 'main'})-[:CALLS*2..4]->(target:Function) RETURN main.name, target.name"
    },
    {
      question: "How many classes are in each file?",
      cypher: "MATCH (f:File)-[:CONTAINS]->(c:Class) RETURN f.name, COUNT(c)"
    },
    {
      question: "Count all functions in the project",
      cypher: "MATCH (f:Function) RETURN COUNT(f)"
    },
    {
      question: "List all function names in alphabetical order",
      cypher: "MATCH (f:Function) RETURN COLLECT(f.name)"
    },
    {
      question: "Find files that contain both classes and functions",
      cypher: "MATCH (f:File)-[:CONTAINS]->(c:Class) WHERE EXISTS((f)-[:CONTAINS]->(:Function)) RETURN f.name"
    },
    {
      question: "Show methods that start with 'get'",
      cypher: "MATCH (m:Method) WHERE m.name CONTAINS 'get' RETURN m.name, m.filePath"
    },
    {
      question: "Find all indirect dependencies (functions that call functions that call a target)",
      cypher: "MATCH (caller:Function)-[:CALLS*2..2]->(target:Function {name: 'database_query'}) RETURN caller.name, target.name"
    }
  ];

  constructor(llmService: LLMService) {
    this.llmService = llmService;
  }

  /**
   * Update the graph schema for better query generation
   */
  public updateSchema(graph: KnowledgeGraph): void {
    this.graphSchema = this.generateSchemaDescription(graph);
  }

  /**
   * Generate a Cypher query from natural language
   */
  public async generateQuery(
    question: string,
    llmConfig: LLMConfig,
    options: CypherGenerationOptions = {}
  ): Promise<CypherQuery> {
    const { maxRetries = 2, includeExamples = true, strictMode = false } = options;
    
    let lastError: string | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const systemPrompt = this.buildSystemPrompt(includeExamples, strictMode, lastError);
        const userPrompt = this.buildUserPrompt(question);
        
        const messages = [
          new SystemMessage(systemPrompt),
          new HumanMessage(userPrompt)
        ];
        
        const response = await this.llmService.chat(llmConfig, messages);
        const result = this.parseResponse(String(response.content || ''));
        
        // Validate the generated query
        const validation = this.validateQuery(result.cypher);
        if (!validation.isValid) {
          lastError = validation.error!;
          if (attempt < maxRetries) {
            console.warn(`Query validation failed (attempt ${attempt + 1}): ${validation.error}`);
            continue;
          }
        }
        
        return {
          ...result,
          warnings: validation.warnings
        };
        
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
        if (attempt < maxRetries) {
          console.warn(`Query generation failed (attempt ${attempt + 1}): ${lastError}`);
          continue;
        }
        
        throw new Error(`Failed to generate Cypher query after ${maxRetries + 1} attempts: ${lastError}`);
      }
    }
    
    throw new Error('Unexpected error in query generation');
  }

  /**
   * Build the system prompt with schema and examples
   */
  private buildSystemPrompt(includeExamples: boolean, strictMode: boolean, lastError?: string | null): string {
    let prompt = `You are a Cypher query expert for a code knowledge graph. Your task is to convert natural language questions into valid Cypher queries.

GRAPH SCHEMA:
${this.graphSchema}

NODE TYPES:
- Project: Root project node
- Folder: Directory containers  
- File: Source code files
- Module: Python modules (.py files)
- Class: Class definitions
- Function: Function definitions
- Method: Class method definitions
- Variable: Variable declarations

RELATIONSHIP TYPES:
- CONTAINS: Hierarchical containment (Project->Folder, Folder->File, File->Function, etc.)
- CALLS: Function/method calls between code entities
- INHERITS: Class inheritance relationships
- IMPORTS: Module import relationships
- OVERRIDES: Method override relationships
- IMPLEMENTS: Interface implementation
- DECORATES: Decorator relationships

QUERY PATTERNS SUPPORTED:

1. SIMPLE MATCH: Find nodes by label and properties
   Pattern: MATCH (n:Label {property: 'value'}) RETURN n.property
   
2. WHERE CLAUSE: Filter nodes with complex conditions
   Pattern: MATCH (n:Label) WHERE n.property CONTAINS 'text' RETURN n.property
   
3. RELATIONSHIP TRAVERSAL: Follow direct relationships
   Pattern: MATCH (a)-[:RELATIONSHIP]->(b:Label) RETURN a.name, b.name
   
4. VARIABLE-LENGTH PATHS: Multi-hop relationships
   Pattern: MATCH (a)-[:RELATIONSHIP*1..3]->(b) RETURN a.name, b.name
   
5. AGGREGATION: Count, collect, or summarize data
   Pattern: MATCH (n:Label) RETURN COUNT(n)
   Pattern: MATCH (n:Label) RETURN COLLECT(n.name)

QUERY SELECTION GUIDELINES:

- Use SIMPLE MATCH for direct property lookups
- Use WHERE for text search, pattern matching, or complex conditions  
- Use RELATIONSHIP TRAVERSAL for direct connections
- Use VARIABLE-LENGTH PATHS for call chains, dependency analysis
- Use AGGREGATION for counting, statistics, or collecting lists

IMPORTANT RULES:
1. Always use MATCH patterns to find nodes
2. Use WHERE clauses for filtering by text content or complex conditions
3. Node properties include: name, filePath, startLine, endLine, type, qualifiedName
4. Return meaningful information, not just node IDs
5. Use case-insensitive matching: WHERE toLower(n.name) CONTAINS toLower('search')
6. Prefer specific node types over generic matches
7. Always return results in a readable format
8. Use variable-length paths (*1..3) for call chains and dependency analysis
9. Use aggregation functions (COUNT, COLLECT) for statistics and summaries
10. Limit variable-length path depth to avoid performance issues (max *1..5)`;

    if (includeExamples) {
      prompt += `\n\nEXAMPLES:`;
      for (const example of CypherGenerator.CYPHER_EXAMPLES) {
        prompt += `\nQ: "${example.question}"\nA: ${example.cypher}\n`;
      }
    }

    if (strictMode) {
      prompt += `\n\nSTRICT MODE: Only generate queries that exactly match the schema. Do not make assumptions about node properties that aren't explicitly defined.`;
    }

    if (lastError) {
      prompt += `\n\nPREVIOUS ERROR: The last query attempt failed with: "${lastError}". Please fix this issue in your new query.`;
    }

    prompt += `\n\nRESPONSE FORMAT:
Provide your response in this exact JSON format:
{
  "cypher": "your cypher query here",
  "explanation": "brief explanation of what the query does and why this pattern was chosen",
  "confidence": 0.85
}

The confidence should be a number between 0 and 1 indicating how confident you are in the query.`;

    return prompt;
  }

  /**
   * Build the user prompt with the question
   */
  private buildUserPrompt(question: string): string {
    return `Please convert this question to a Cypher query: "${question}"`;
  }

  /**
   * Parse the LLM response to extract Cypher query
   */
  private parseResponse(response: string): { cypher: string; explanation: string; confidence: number } {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          cypher: parsed.cypher || '',
          explanation: parsed.explanation || '',
          confidence: parsed.confidence || 0.5
        };
      }
      
      // Fallback: try to extract Cypher from code blocks
      const cypherMatch = response.match(/```(?:cypher)?\s*(.*?)\s*```/s);
      if (cypherMatch) {
        return {
          cypher: cypherMatch[1].trim(),
          explanation: 'Generated Cypher query',
          confidence: 0.7
        };
      }
      
      // Last resort: use the entire response as cypher
      return {
        cypher: response.trim(),
        explanation: 'Raw LLM response',
        confidence: 0.3
      };
      
    } catch (error) {
      throw new Error(`Failed to parse LLM response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate the generated Cypher query
   */
  private validateQuery(cypher: string): { isValid: boolean; error?: string; warnings?: string[] } {
    const warnings: string[] = [];
    
    if (!cypher || cypher.trim().length === 0) {
      return { isValid: false, error: 'Empty query generated' };
    }
    
    // Basic syntax checks
    const upperCypher = cypher.toUpperCase();
    
    // Must have MATCH or CREATE or other valid starting keywords
    if (!upperCypher.match(/^\s*(MATCH|CREATE|MERGE|WITH|RETURN|CALL|SHOW)/)) {
      return { isValid: false, error: 'Query must start with a valid Cypher keyword (MATCH, CREATE, etc.)' };
    }
    
    // Check for balanced parentheses
    const openParens = (cypher.match(/\(/g) || []).length;
    const closeParens = (cypher.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      return { isValid: false, error: 'Unbalanced parentheses in query' };
    }
    
    // Check for balanced brackets
    const openBrackets = (cypher.match(/\[/g) || []).length;
    const closeBrackets = (cypher.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
      return { isValid: false, error: 'Unbalanced brackets in query' };
    }
    
    // Check for balanced braces
    const openBraces = (cypher.match(/\{/g) || []).length;
    const closeBraces = (cypher.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      return { isValid: false, error: 'Unbalanced braces in query' };
    }
    
    // Warn about potentially expensive operations
    if (upperCypher.includes('MATCH ()') || upperCypher.includes('MATCH (*)')) {
      warnings.push('Query matches all nodes - this could be expensive');
    }
    
    if (!upperCypher.includes('RETURN') && !upperCypher.includes('DELETE') && !upperCypher.includes('SET')) {
      warnings.push('Query does not return results');
    }
    
    return { isValid: true, warnings };
  }

  /**
   * Generate a schema description from the knowledge graph
   */
  private generateSchemaDescription(graph: KnowledgeGraph): string {
    const nodeTypes = new Set<string>();
    const relationshipTypes = new Set<string>();
    const nodeProperties = new Map<string, Set<string>>();
    
    // Analyze nodes
    graph.nodes.forEach(node => {
      nodeTypes.add(node.label);
      
      if (!nodeProperties.has(node.label)) {
        nodeProperties.set(node.label, new Set());
      }
      
      Object.keys(node.properties).forEach(prop => {
        nodeProperties.get(node.label)!.add(prop);
      });
    });
    
    // Analyze relationships
    graph.relationships.forEach(rel => {
      relationshipTypes.add(rel.type);
    });
    
    let schema = `NODES (${graph.nodes.length} total):\n`;
    for (const nodeType of Array.from(nodeTypes).sort()) {
      const props = nodeProperties.get(nodeType);
      const propList = props ? Array.from(props).sort().join(', ') : 'none';
      const count = graph.nodes.filter(n => n.label === nodeType).length;
      schema += `- ${nodeType} (${count}): ${propList}\n`;
    }
    
    schema += `\nRELATIONSHIPS (${graph.relationships.length} total):\n`;
    for (const relType of Array.from(relationshipTypes).sort()) {
      const count = graph.relationships.filter(r => r.type === relType).length;
      schema += `- ${relType} (${count})\n`;
    }
    
    return schema;
  }

  /**
   * Get the current schema description
   */
  public getSchema(): string {
    return this.graphSchema;
  }

  /**
   * Clean and format a Cypher query
   */
  public cleanQuery(cypher: string): string {
    return cypher
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\s*([(),\[\]{}])\s*/g, '$1')
      .replace(/\s*([=<>!]+)\s*/g, ' $1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }
} 
