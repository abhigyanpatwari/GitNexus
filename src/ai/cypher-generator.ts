import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
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

// Define Zod schema for structured output
const CypherQuerySchema = z.object({
  cypher: z.string().describe("The Cypher query to execute"),
  explanation: z.string().describe("Brief explanation of what the query does and why this pattern was chosen"),
  confidence: z.number().min(0).max(1).describe("Confidence level between 0 and 1")
});

export class CypherGenerator {
  private llmService: LLMService;
  private graphSchema: string = '';
  private outputParser: StructuredOutputParser<typeof CypherQuerySchema>;
  
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
    this.outputParser = StructuredOutputParser.fromZodSchema(CypherQuerySchema);
  }

  /**
   * Update the graph schema for better query generation
   */
  public updateSchema(graph: KnowledgeGraph): void {
    this.graphSchema = this.generateSchemaDescription(graph);
  }

  /**
   * Generate a Cypher query from natural language using structured output parsing
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
        // Get the format instructions for structured output
        const formatInstructions = this.outputParser.getFormatInstructions();
        
        const systemPrompt = this.buildSystemPrompt(includeExamples, strictMode, lastError, formatInstructions);
        const userPrompt = this.buildUserPrompt(question);
        
        const messages = [
          new SystemMessage(systemPrompt),
          new HumanMessage(userPrompt)
        ];
        
        // Get the model from the service
        const model = this.llmService.getModel(llmConfig);
        if (!model) {
          throw new Error('Failed to get LLM model');
        }
        
        // Invoke the model directly first
        const response = await model.invoke(messages);
        
        // Parse the response content
        let result;
        try {
          // Extract the content from the response
          const content = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);
          
          // Try to parse the structured output
          result = await this.outputParser.parse(content);
        } catch (parseError) {
          // If parsing fails, try to extract the query manually
          console.warn('Failed to parse structured output, attempting manual extraction:', parseError);
          
          const content = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);
          
          // Try to extract Cypher query from the response
          const cypherMatch = content.match(/```(?:cypher|sql)?\n?(.*?)\n?```/s) ||
                             content.match(/MATCH.*?(?:RETURN|$)/si);
          
          const cypherQuery = cypherMatch ? cypherMatch[1] || cypherMatch[0] : content.trim();
          
          result = {
            cypher: cypherQuery,
            explanation: 'Generated query from natural language',
            confidence: 0.7
          };
        }
        
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
  private buildSystemPrompt(
    includeExamples: boolean, 
    strictMode: boolean, 
    lastError?: string | null,
    formatInstructions?: string
  ): string {
    let prompt = `You are a Cypher query expert for a code knowledge graph using KuzuDB (a high-performance graph database). Your task is to convert natural language questions into valid Cypher queries optimized for KuzuDB.

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

KUZUDB OPTIMIZATION GUIDELINES:

1. PERFORMANCE: KuzuDB excels at complex graph traversals and pattern matching
   - Use variable-length paths (*1..5) for call chains and dependency analysis
   - Leverage WHERE clauses for efficient filtering
   - Use aggregation functions (COUNT, COLLECT) for statistics

2. QUERY PATTERNS SUPPORTED:

   SIMPLE MATCH: Find nodes by label and properties
   MATCH (f:Function {name: 'main'}) RETURN f

   RELATIONSHIP TRAVERSAL: Follow relationships between nodes
   MATCH (caller)-[:CALLS]->(target:Function) RETURN caller.name, target.name

   VARIABLE-LENGTH PATHS: Find chains of relationships
   MATCH (start:Function)-[:CALLS*1..3]->(end:Function) RETURN start.name, end.name

   AGGREGATION: Count and collect results
   MATCH (f:File)-[:CONTAINS]->(func:Function) RETURN f.name, COUNT(func)

   PATTERN MATCHING: Use WHERE clauses for filtering
   MATCH (f:Function) WHERE f.name CONTAINS 'user' RETURN f.name, f.filePath

3. COMMON PATTERNS:

   FIND FUNCTIONS IN FILE:
   MATCH (f:File {name: 'filename.py'})-[:CONTAINS]->(func:Function) RETURN func.name

   FIND CALLERS OF FUNCTION:
   MATCH (caller)-[:CALLS]->(target:Function {name: 'functionName'}) RETURN caller.name

   FIND INHERITANCE CHAIN:
   MATCH (child:Class)-[:INHERITS*1..5]->(parent:Class) RETURN child.name, parent.name

   FIND IMPORTS:
   MATCH (f:File)-[:IMPORTS]->(module) WHERE module.name CONTAINS 'requests' RETURN f.name

   COUNT ENTITIES:
   MATCH (f:Function) RETURN COUNT(f) as functionCount

   COMPLEX DEPENDENCY ANALYSIS:
   MATCH (start:Function)-[:CALLS*1..5]->(target:Function) 
   WHERE start.name = 'main' AND target.name CONTAINS 'db'
   RETURN start.name, target.name, LENGTH(shortestPath((start)-[:CALLS*]->(target))) as depth`;

    if (includeExamples) {
      prompt += `\n\nEXAMPLE QUERIES:\n`;
      CypherGenerator.CYPHER_EXAMPLES.forEach((example, index) => {
        prompt += `${index + 1}. Question: "${example.question}"\n   Cypher: ${example.cypher}\n\n`;
      });
    }

    if (strictMode) {
      prompt += `\n\nSTRICT MODE: Only generate queries that exactly match the schema. Do not make assumptions about node properties that aren't explicitly defined.`;
    }

    if (lastError) {
      prompt += `\n\nPREVIOUS ERROR: The last query attempt failed with: "${lastError}". Please fix this issue in your new query.`;
    }

    if (formatInstructions) {
      prompt += `\n\n${formatInstructions}`;
    }

    return prompt;
  }

  /**
   * Build the user prompt with the question
   */
  private buildUserPrompt(question: string): string {
    return `Please convert this question to a Cypher query: "${question}"`;
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
      .replace(/\s*([(),[\]{}])\s*/g, '$1')
      .replace(/\s*([=<>!]+)\s*/g, ' $1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }
} 
