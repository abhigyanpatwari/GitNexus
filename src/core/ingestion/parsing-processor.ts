import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.ts';
import { initTreeSitter, loadPythonParser } from '../tree-sitter/parser-loader.ts';
import { generateId } from '../../lib/utils.ts';

import type Parser from 'web-tree-sitter';

export interface ParsingInput {
  filePaths: string[];
  fileContents: Map<string, string>;
}

interface ParsedDefinition {
  type: 'function' | 'class' | 'method';
  name: string;
  startLine: number;
  endLine: number;
  parentClass?: string;
}

export class ParsingProcessor {
  private parser: Parser | null = null;
  private astCache: Map<string, Parser.Tree> = new Map();

  public async process(graph: KnowledgeGraph, input: ParsingInput): Promise<void> {
    const { filePaths, fileContents } = input;
    
    // Initialize Tree-sitter parser
    await this.initializeParser();
    
    // Process each Python file
    for (const filePath of filePaths) {
      if (this.isPythonFile(filePath)) {
        const content = fileContents.get(filePath);
        if (content) {
          await this.parseFile(graph, filePath, content);
        }
      }
    }
  }

  private async initializeParser(): Promise<void> {
    if (!this.parser) {
      this.parser = await initTreeSitter();
      const pythonLanguage = await loadPythonParser();
      this.parser.setLanguage(pythonLanguage);
    }
  }

  private async parseFile(graph: KnowledgeGraph, filePath: string, content: string): Promise<void> {
    if (!this.parser) {
      throw new Error('Parser not initialized');
    }

    try {
      // Parse the file and cache the AST
      const tree = this.parser.parse(content);
      this.astCache.set(filePath, tree);
      
      // Create module node
      const moduleNode = this.createModuleNode(filePath);
      graph.nodes.push(moduleNode);
      
      // Extract definitions from the AST
      const definitions = this.extractDefinitions(tree.rootNode);
      
      // Create nodes for definitions and establish relationships
      for (const definition of definitions) {
        const definitionNode = this.createDefinitionNode(filePath, definition);
        graph.nodes.push(definitionNode);
        
        // Create CONTAINS relationship between module and definition
        const relationship = this.createContainsRelationship(moduleNode.id, definitionNode.id);
        graph.relationships.push(relationship);
        
        // If it's a method, create relationship with its class
        if (definition.type === 'method' && definition.parentClass) {
          const classNode = this.findClassNode(graph, filePath, definition.parentClass);
          if (classNode) {
            const methodRelationship = this.createContainsRelationship(classNode.id, definitionNode.id);
            graph.relationships.push(methodRelationship);
          }
        }
      }
      
    } catch (error) {
      console.warn(`Failed to parse file ${filePath}:`, error);
    }
  }

  private createModuleNode(filePath: string): GraphNode {
    const pathParts = filePath.split('/');
    const fileName = pathParts[pathParts.length - 1];
    const moduleName = fileName.replace(/\.py$/, '');
    
    return {
      id: generateId('module', filePath),
      label: 'Module',
      properties: {
        name: moduleName,
        path: filePath,
        language: 'python'
      }
    };
  }

  private createDefinitionNode(filePath: string, definition: ParsedDefinition): GraphNode {
    const nodeLabel = definition.type === 'function' ? 'Function' : 
                     definition.type === 'method' ? 'Method' : 'Class';
    
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

  private createContainsRelationship(sourceId: string, targetId: string): GraphRelationship {
    return {
      id: generateId('relationship', `${sourceId}-contains-${targetId}`),
      type: 'CONTAINS',
      source: sourceId,
      target: targetId
    };
  }

  private extractDefinitions(node: Parser.SyntaxNode): ParsedDefinition[] {
    const definitions: ParsedDefinition[] = [];
    
    this.traverseNode(node, (currentNode: Parser.SyntaxNode) => {
      if (currentNode.type === 'function_definition') {
        const nameNode = currentNode.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            type: 'function',
            name: nameNode.text,
            startLine: currentNode.startPosition.row + 1,
            endLine: currentNode.endPosition.row + 1
          });
        }
      } else if (currentNode.type === 'class_definition') {
        const nameNode = currentNode.childForFieldName('name');
        if (nameNode) {
          const className = nameNode.text;
          definitions.push({
            type: 'class',
            name: className,
            startLine: currentNode.startPosition.row + 1,
            endLine: currentNode.endPosition.row + 1
          });
          
          // Extract methods from the class
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
            type: 'method',
            name: nameNode.text,
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

  private findClassNode(graph: KnowledgeGraph, filePath: string, className: string): GraphNode | null {
    return graph.nodes.find(node => 
      node.label === 'Class' && 
      node.properties.name === className && 
      node.properties.filePath === filePath
    ) || null;
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
