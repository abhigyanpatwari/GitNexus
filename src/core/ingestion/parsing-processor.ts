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
    const { filePaths, fileContents } = input;

    console.log('ParsingProcessor: Processing', filePaths.length, 'files');

    // Memory optimization: Process files in batches to prevent OOM
    const BATCH_SIZE = 10; // Process 10 files at a time
    const sourceFiles = filePaths.filter(path => this.isSourceFile(path));
    
    console.log(`ParsingProcessor: Found ${sourceFiles.length} source files, processing in batches of ${BATCH_SIZE}`);

    // Enable tree-sitter parsing once WASM files are available
    try {
      await this.initializeParser();
      
      let successfullyParsed = 0;
      let failedToParse = 0;
      
      // Process files in batches
      for (let i = 0; i < sourceFiles.length; i += BATCH_SIZE) {
        const batch = sourceFiles.slice(i, i + BATCH_SIZE);
        console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(sourceFiles.length / BATCH_SIZE)} (${batch.length} files)`);
        
        for (const filePath of batch) {
          const fileContent = fileContents.get(filePath);
          if (!fileContent) {
            console.warn(`No content found for source file: ${filePath}`);
            continue;
          }

          // Memory optimization: Skip very large files
          if (fileContent.length > 500000) { // Skip files larger than 500KB
            console.warn(`Skipping large file (${fileContent.length} chars): ${filePath}`);
            continue;
          }

          try {
            const definitions = this.parseFile(filePath, fileContent);
            
            // Find the existing file node created by StructureProcessor
            const existingFileNode = graph.nodes.find(node => 
              node.label === 'File' && 
              (node.properties.path === filePath || node.properties.filePath === filePath)
            );
            
            if (existingFileNode) {
              // Update the existing file node with parsing results
              const extension = this.getFileExtension(filePath);
              const language = this.getLanguageFromExtension(extension);
              
              existingFileNode.properties.filePath = filePath; // Ensure filePath is set
              existingFileNode.properties.extension = extension;
              existingFileNode.properties.language = language;
              existingFileNode.properties.definitionCount = definitions.length;
              
              // Create definition nodes and relationships
              for (const definition of definitions) {
                const defNode = this.createDefinitionNode(filePath, definition);
                graph.nodes.push(defNode);
                
                // Create CONTAINS relationship from file to definition
                graph.relationships.push({
                  id: generateId('relationship', `${existingFileNode.id}-contains-${defNode.id}`),
                  type: 'CONTAINS',
                  source: existingFileNode.id,
                  target: defNode.id,
                  properties: {}
                });
              }
              
              if (definitions.length > 0) {
                successfullyParsed++;
                console.log(`✅ Successfully parsed ${filePath} - found ${definitions.length} definitions`);
              } else {
                console.log(`⚠️ No definitions found in ${filePath} (file may be empty or contain only imports)`);
              }
            } else {
              console.warn(`⚠️ File node not found for ${filePath}, creating new one`);
              
              // Fallback: create file node if StructureProcessor missed it
              const extension = this.getFileExtension(filePath);
              const language = this.getLanguageFromExtension(extension);
              
              const fileNode: GraphNode = {
                id: generateId('file', filePath),
                label: 'File',
                properties: {
                  name: filePath.split('/').pop() || filePath,
                  filePath,
                  extension,
                  language,
                  definitionCount: definitions.length
                }
              };
              graph.nodes.push(fileNode);
              
              // Create definition nodes and relationships
              for (const definition of definitions) {
                const defNode = this.createDefinitionNode(filePath, definition);
                graph.nodes.push(defNode);
                
                // Create CONTAINS relationship from file to definition
                graph.relationships.push({
                  id: generateId('relationship', `${fileNode.id}-contains-${defNode.id}`),
                  type: 'CONTAINS',
                  source: fileNode.id,
                  target: defNode.id,
                  properties: {}
                });
              }
            }
            
          } catch (parseError) {
            failedToParse++;
            console.error(`❌ Failed to parse ${filePath}:`, parseError);
            
            // Find existing file node and mark it as failed to parse
            const existingFileNode = graph.nodes.find(node => 
              node.label === 'File' && 
              (node.properties.path === filePath || node.properties.filePath === filePath)
            );
            
            if (existingFileNode) {
              existingFileNode.properties.parseError = true;
              existingFileNode.properties.definitionCount = 0;
            }
          }
          
          // Clear AST cache periodically to save memory
          if (this.astCache.size > 20) {
            const oldestKeys = Array.from(this.astCache.keys()).slice(0, 10);
            for (const key of oldestKeys) {
              this.astCache.delete(key);
            }
          }
        }
        
        // Small delay between batches to prevent overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      console.log(`ParsingProcessor: Completed - ${successfullyParsed} successful, ${failedToParse} failed`);
    } catch (error) {
      console.warn('Tree-sitter parsing failed, falling back to basic file nodes:', error);
      
      // Fallback: create basic file nodes without parsing (also in batches)
      for (let i = 0; i < sourceFiles.length; i += BATCH_SIZE) {
        const batch = sourceFiles.slice(i, i + BATCH_SIZE);
        
        for (const filePath of batch) {
          const extension = this.getFileExtension(filePath);
          const language = this.getLanguageFromExtension(extension);
          
          const fileNode: GraphNode = {
            id: generateId('file', filePath),
            label: 'File',
            properties: {
              name: filePath.split('/').pop() || filePath,
              filePath,
              extension,
              language
            }
          };
          graph.nodes.push(fileNode);
        }
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

  private parseFile(filePath: string, fileContent: string): ParsedDefinition[] {
    const extension = this.getFileExtension(filePath);
    
    if (extension === '.py') {
      // Try Tree-sitter first, fallback to regex if it fails
      if (this.parser) {
        return this.parsePythonFile(filePath, fileContent);
      } else {
        console.warn(`Tree-sitter not available for ${filePath}, using regex fallback`);
        return this.parsePythonFileRegex(filePath, fileContent);
      }
    }
    
    // Only Python files are processed now
    return [];
  }

  private parsePythonFileRegex(filePath: string, fileContent: string): ParsedDefinition[] {
    const definitions: ParsedDefinition[] = [];
    const lines = fileContent.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNumber = i + 1;
      
      // Match function definitions: def function_name(
      const functionMatch = line.match(/^def\s+(\w+)\s*\(/);
      if (functionMatch) {
        definitions.push({
          name: functionMatch[1],
          type: 'function',
          startLine: lineNumber,
          endLine: lineNumber // Basic implementation
        });
      }
      
      // Match class definitions: class ClassName
      const classMatch = line.match(/^class\s+(\w+)(?:\s*\(.*\))?\s*:/);
      if (classMatch) {
        definitions.push({
          name: classMatch[1],
          type: 'class',
          startLine: lineNumber,
          endLine: lineNumber // Basic implementation
        });
      }
      
      // Match method definitions inside classes (indented def)
      const methodMatch = line.match(/^\s+def\s+(\w+)\s*\(/);
      if (methodMatch) {
        // Find the parent class by looking backwards
        let parentClass = 'UnknownClass';
        for (let j = i - 1; j >= 0; j--) {
          const prevLine = lines[j].trim();
          const classMatch = prevLine.match(/^class\s+(\w+)(?:\s*\(.*\))?\s*:/);
          if (classMatch) {
            parentClass = classMatch[1];
            break;
          }
          // Stop if we hit another function or class at root level
          if (prevLine.match(/^(def|class)\s+/)) {
            break;
          }
        }
        
        definitions.push({
          name: methodMatch[1],
          type: 'method',
          startLine: lineNumber,
          endLine: lineNumber,
          parentClass
        });
      }
    }
    
    console.log(`Regex-parsed ${definitions.length} Python definitions from ${filePath}`);
    return definitions;
  }

  private parsePythonFile(filePath: string, fileContent: string): ParsedDefinition[] {
    if (!this.parser) {
      console.warn('Parser not initialized. Cannot parse Python file:', filePath);
      return this.parsePythonFileRegex(filePath, fileContent);
    }

    try {
      // Parse the file content using tree-sitter
      const tree = this.parser.parse(fileContent);
      
      // Cache the AST for later use
      this.astCache.set(filePath, tree);
      
      const definitions: ParsedDefinition[] = [];
      const rootNode = tree.rootNode;

      this.traverseNode(rootNode, (currentNode: Parser.SyntaxNode) => {
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
            
            // Extract methods from this class
            const methods = this.extractMethodsFromClass(currentNode, className);
            definitions.push(...methods);
          }
        }
      });
      
      console.log(`Tree-sitter parsed ${definitions.length} Python definitions from ${filePath}`);
      return definitions;
    } catch (error) {
      console.error(`Error parsing Python file ${filePath}:`, error);
      console.log(`Falling back to regex parsing for ${filePath}`);
      return this.parsePythonFileRegex(filePath, fileContent);
    }
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

  private isSourceFile(filePath: string): boolean {
    // Only process Python source files
    if (!filePath) return false;
    const extension = this.getFileExtension(filePath).toLowerCase();
    return extension === '.py';
  }

  private getFileExtension(filePath: string): string {
    if (!filePath) return '';
    const lastDotIndex = filePath.lastIndexOf('.');
    if (lastDotIndex === -1) {
      return '';
    }
    return filePath.substring(lastDotIndex);
  }

  private getLanguageFromExtension(extension: string): string {
    switch (extension.toLowerCase()) {
      case '.py':
      case '.pyx':
      case '.pyi':
        return 'python';
      default:
        return 'unknown';
    }
  }

  public getAst(filePath: string): Parser.Tree | undefined {
    return this.astCache.get(filePath);
  }

  public getCachedAsts(): Map<string, Parser.Tree> {
    return new Map(this.astCache);
  }
} 
