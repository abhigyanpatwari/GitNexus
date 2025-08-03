import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.ts';
import { initTreeSitter, loadPythonParser } from '../tree-sitter/parser-loader.ts';
import { generateId } from '../../lib/utils.ts';

import type Parser from 'web-tree-sitter';

export interface ParsingInput {
  filePaths: string[];
  fileContents: Map<string, string>;
}

interface ParsedDefinition {
  name: string;
  type: 'function' | 'class' | 'method';
  startLine: number;
  endLine: number;
  parentClass?: string;
}

export class ParsingProcessor {
  private parser: Parser | null = null;
  private astCache: Map<string, Parser.Tree> = new Map();

  public async process(graph: KnowledgeGraph, input: ParsingInput): Promise<void> {
    const { filePaths } = input;

    console.log('ParsingProcessor: Processing', filePaths.length, 'files');

    // Temporarily disable tree-sitter parsing due to WASM loading issues
    console.warn('Tree-sitter parsing temporarily disabled due to WASM loading issues');
    
    // Create basic file nodes without parsing
    for (const filePath of filePaths) {
      if (this.isPythonFile(filePath)) {
        const fileNode: GraphNode = {
          id: generateId('file', filePath),
          label: 'File',
          properties: {
            name: filePath.split('/').pop() || filePath,
            filePath,
            extension: '.py',
            language: 'python'
          }
        };
        graph.nodes.push(fileNode);
      }
    }

    console.log('ParsingProcessor: Created', graph.nodes.filter(n => n.label === 'File').length, 'file nodes');
  }

  private async initializeParser(): Promise<void> {
    if (this.parser) return;

    try {
      await initTreeSitter();
      await loadPythonParser();
      
      this.parser = await initTreeSitter();
      const pythonLang = await loadPythonParser();
      this.parser.setLanguage(pythonLang);
      
      console.log('Tree-sitter parser initialized successfully');
    } catch (error) {
      console.error('Failed to initialize parser:', error);
      throw new Error(`Parser initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseFile(): ParsedDefinition[] {
    // Temporarily return empty array - parsing disabled
    return [];
  }

  private createDefinitionNode(filePath: string, definition: ParsedDefinition): GraphNode {
    const nodeLabel = definition.type === 'function' ? 'Function' : 
                     (definition.type === 'method' ? 'Method' : 'Class');
    
    return {
      id: generateId(definition.type, `${filePath}:${definition.name}`),
      label: nodeLabel as 'Function' | 'Method' | 'Class',
      properties: {
        name: definition.name,
        filePath,
        startLine: definition.startLine,
        endLine: definition.endLine,
        ...(definition.parentClass && { parentClass: definition.parentClass })
      }
    };
  }

  private createDefinitionRelationships(
    graph: KnowledgeGraph,
    filePath: string,
    definitions: ParsedDefinition[]
  ): void {
    const fileNodeId = generateId('file', filePath);
    
    for (const definition of definitions) {
      const defNodeId = generateId(definition.type, `${filePath}:${definition.name}`);
      
      const relationship: GraphRelationship = {
        id: generateId('relationship', `${fileNodeId}-contains-${defNodeId}`),
        source: fileNodeId,
        target: defNodeId,
        type: 'CONTAINS',
        properties: {}
      };
      
      graph.relationships.push(relationship);
      
      if (definition.type === 'method' && definition.parentClass) {
        const classNodeId = generateId('class', `${filePath}:${definition.parentClass}`);
        const methodRelationship: GraphRelationship = {
          id: generateId('relationship', `${classNodeId}-has-method-${defNodeId}`),
          source: classNodeId,
          target: defNodeId,
          type: 'CONTAINS',
          properties: {}
        };
        
        graph.relationships.push(methodRelationship);
      }
    }
  }

  private extractDefinitions(node: Parser.SyntaxNode): ParsedDefinition[] {
    const definitions: ParsedDefinition[] = [];
    
    this.traverseNode(node, (currentNode: Parser.SyntaxNode) => {
      if (currentNode.type === 'function_definition') {
        const nameNode = currentNode.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            type: 'function',
            startLine: currentNode.startPosition.row + 1,
            endLine: currentNode.endPosition.row + 1
          });
        }
      } else if (currentNode.type === 'class_definition') {
        const nameNode = currentNode.childForFieldName('name');
        if (nameNode) {
          const className = nameNode.text;
          definitions.push({
            name: className,
            type: 'class',
            startLine: currentNode.startPosition.row + 1,
            endLine: currentNode.endPosition.row + 1
          });
          
          const methods = this.extractMethodsFromClass(currentNode, className);
          definitions.push(...methods);
        }
      }
    });
    
    return definitions;
  }

  private extractMethodsFromClass(classNode: Parser.SyntaxNode, className: string): ParsedDefinition[] {
    const methods: ParsedDefinition[] = [];
    
    this.traverseNode(classNode, (node: Parser.SyntaxNode) => {
      if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          methods.push({
            name: nameNode.text,
            type: 'method',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            parentClass: className
          });
        }
      }
    });
    
    return methods;
  }

  private traverseNode(node: Parser.SyntaxNode, callback: (node: Parser.SyntaxNode) => void): void {
    callback(node);
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.traverseNode(child, callback);
      }
    }
  }

  private isPythonFile(filePath: string): boolean {
    return filePath.endsWith('.py');
  }

  public getAst(filePath: string): Parser.Tree | undefined {
    return this.astCache.get(filePath);
  }

  public getCachedAsts(): Map<string, Parser.Tree> {
    return new Map(this.astCache);
  }
} 
