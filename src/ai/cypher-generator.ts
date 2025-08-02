// @ts-expect-error - npm: imports are resolved at runtime in Deno
import { HumanMessage, SystemMessage } from 'npm:@langchain/core/messages';
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
      cypher: "MATCH (f:File {name: 'main.py'})-[:CONTAINS]->(func:Function) RETURN func.name"
    },
    {
      question: "Which functions call the authenticate function?",
      cypher: "MATCH (caller)-[:CALLS]->(target:Function {name: 'authenticate'}) RETURN caller.name"
    },
    {
      question: "Show me all classes in the project",
      cypher: "MATCH (c:Class) RETURN c.name, c.filePath"
    },
    {
      question: "What modules import numpy?",
      cypher: "MATCH (m:Module)-[:IMPORTS]->(lib) WHERE lib.name CONTAINS 'numpy' RETURN m.name"
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
        const result = this.parseResponse(response.content);
        
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

IMPORTANT RULES:
1. Always use MATCH patterns to find nodes
2. Use WHERE clauses for filtering by properties
3. Node properties include: name, filePath, startLine, endLine, type
4. Return meaningful information, not just node IDs
5. Use case-insensitive matching when appropriate (e.g., WHERE toLower(n.name) CONTAINS toLower('search'))
6. Prefer specific node types over generic matches
7. Always return results in a readable format`;

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
  "explanation": "brief explanation of what the query does",
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