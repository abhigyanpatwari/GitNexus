import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.ts';
import { initTreeSitter } from '../tree-sitter/parser-loader.ts';
import { generateId } from '../../lib/utils.ts';
import { FunctionRegistryTrie } from '../graph/trie.ts';

import type Parser from 'web-tree-sitter';
// Add JS/TS loaders
import { loadJavaScriptParser, loadTypeScriptParser, loadTsxParser } from '../tree-sitter/parser-loader.ts';

export interface ParsingInput {
  filePaths: string[];
  fileContents: Map<string, string>;
  options?: {
    directoryFilter?: string;
    fileExtensions?: string;
  };
}

interface ParsedDefinition {
  name: string;
  type: 'function' | 'class' | 'method' | 'interface' | 'enum' | 'decorator' | 'variable';
  startLine: number;
  endLine: number;
  parentClass?: string;
  decorators?: string[];
  baseClasses?: string[];
  decoratedTarget?: string; // For decorator nodes - what they decorate
  variableType?: string;    // For variable nodes - inferred type
}

export interface ParsedAST {
  tree: Parser.Tree | null;
  language: string;
}

export class ParsingProcessor {
  private parser: Parser | null = null;
  private astCache: Map<string, Parser.Tree> = new Map();
  private langPython: Parser.Language | null = null;
  private langJavaScript: Parser.Language | null = null;
  private langTypeScript: Parser.Language | null = null;
  private langTsx: Parser.Language | null = null;
  private functionTrie: FunctionRegistryTrie = new FunctionRegistryTrie();

  // Comprehensive ignore patterns for directories that should not be parsed
  private static readonly IGNORE_PATTERNS = new Set([
    // Version Control
    '.git',
    '.svn',
    '.hg',
    
    // Package Managers & Dependencies
    'node_modules',
    'bower_components',
    'jspm_packages',
    'vendor',
    'deps',
    
    // Python Virtual Environments & Cache
    'venv',
    'env',
    '.venv',
    '.env',
    'envs',
    'virtualenv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.tox',
    
    // Build & Distribution Directories
    'build',
    'dist',
    'out',
    'target',
    'bin',
    'obj',
    '.gradle',
    '_build',
    
    // IDE & Editor Directories
    '.vs',
    '.vscode',
    '.idea',
    '.eclipse',
    '.settings',
    
    // Temporary & Log Directories
    'tmp',
    '.tmp',
    'temp',
    'logs',
    'log',
    
    // Coverage & Testing
    'coverage',
    '.coverage',
    'htmlcov',
    '.nyc_output',
    
    // OS & System
    '.DS_Store',
    'Thumbs.db',
    
    // Documentation Build Output
    '_site',
    '.docusaurus',
    
    // Cache Directories
    '.cache',
    '.parcel-cache',
    '.next',
    '.nuxt'
  ]);

  public async process(graph: KnowledgeGraph, input: ParsingInput): Promise<void> {
    const { filePaths, fileContents, options } = input;

    console.log(`ParsingProcessor: Processing ${filePaths.length} total paths`);

    // Apply filtering based on user options (this is where filtering now happens!)
    const filteredFiles = this.applyFiltering(filePaths, fileContents, options);
    
    console.log(`ParsingProcessor: After filtering: ${filteredFiles.length} files to parse`);

    // Memory optimization: Process files in batches to prevent OOM
    const BATCH_SIZE = 10;
    const sourceFiles = filteredFiles.filter((path: string) => this.isSourceFile(path));
    const configFiles = filteredFiles.filter((path: string) => this.isConfigFile(path));
    const allProcessableFiles = [...sourceFiles, ...configFiles];
    
    console.log(`ParsingProcessor: Found ${sourceFiles.length} source files and ${configFiles.length} config files, processing in batches of ${BATCH_SIZE}`);

    // Enable tree-sitter parsing once WASM files are available
    try {
      await this.initializeParser();
      
      let successfullyParsed = 0;
      let failedToParse = 0;
      
      // Process files in batches
      for (let i = 0; i < allProcessableFiles.length; i += BATCH_SIZE) {
        const batch = allProcessableFiles.slice(i, i + BATCH_SIZE);
        console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allProcessableFiles.length / BATCH_SIZE)} (${batch.length} files)`);
        
        for (const filePath of batch) {
          const fileContent = fileContents.get(filePath);
          if (!fileContent) {
            console.warn(`No content found for file: ${filePath}`);
            continue;
          }

          // Memory optimization: Skip very large files
          if (fileContent.length > 500000) { // Skip files larger than 500KB
            console.warn(`Skipping large file (${fileContent.length} chars): ${filePath}`);
            continue;
          }

          try {
            let definitions: ParsedDefinition[] = [];
            
            if (this.isSourceFile(filePath)) {
              definitions = this.parseFile(filePath, fileContent);
            } else if (this.isConfigFile(filePath)) {
              definitions = this.parseConfigFile(filePath, fileContent);
            }
            
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
              
              // Create class-to-method CONTAINS relationships
              this.createClassMethodRelationships(graph, filePath, definitions);
              
              // Create inheritance and override relationships
              this.createInheritanceRelationships(graph, filePath, definitions);
              
              // Create interface implementation relationships
              this.createImplementsRelationships(graph, filePath, definitions);
              
              // Create decorator relationships
              this.createDecoratorRelationships(graph, filePath, definitions);
              
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
              
              // Create class-to-method CONTAINS relationships
              this.createClassMethodRelationships(graph, filePath, definitions);
              
              // Create inheritance and override relationships
              this.createInheritanceRelationships(graph, filePath, definitions);
              
              // Create interface implementation relationships
              this.createImplementsRelationships(graph, filePath, definitions);
              
              // Create decorator relationships
              this.createDecoratorRelationships(graph, filePath, definitions);
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

  /**
   * Apply user filtering options to determine which files should be parsed
   * This is where filtering now happens - during parsing, not before structure discovery
   */
  private applyFiltering(
    allPaths: string[], 
    fileContents: Map<string, string>, 
    options?: { directoryFilter?: string; fileExtensions?: string }
  ): string[] {
    // Only consider files that have content (not directories)
    let filesToProcess = allPaths.filter(path => fileContents.has(path));
    
    console.log(`ParsingProcessor: Starting with ${filesToProcess.length} files with content`);
    
    // STAGE 1: Prune ignored directories (NEW - Two-stage filtering)
    const beforePruning = filesToProcess.length;
    filesToProcess = this.pruneIgnoredPaths(filesToProcess);
    console.log(`ParsingProcessor: After pruning ignored directories: ${beforePruning} -> ${filesToProcess.length} files`);
    
    if (!options) {
      return filesToProcess;
    }

    // STAGE 2: Apply user filters (EXISTING)
    // Apply directory filtering
    if (options.directoryFilter?.trim()) {
      const dirPatterns = options.directoryFilter.toLowerCase().split(',').map(p => p.trim());
      const beforeCount = filesToProcess.length;
      
      filesToProcess = filesToProcess.filter(path => 
        dirPatterns.some(pattern => path.toLowerCase().includes(pattern))
      );
      
      console.log(`ParsingProcessor: Directory filter applied: ${beforeCount} -> ${filesToProcess.length} files`);
    }

    // Apply file extension filtering
    if (options.fileExtensions?.trim()) {
      const extensions = options.fileExtensions.toLowerCase().split(',').map(ext => ext.trim());
      const beforeCount = filesToProcess.length;
      
      filesToProcess = filesToProcess.filter(path => 
        extensions.some(ext => path.toLowerCase().endsWith(ext))
      );
      
      console.log(`ParsingProcessor: Extension filter applied: ${beforeCount} -> ${filesToProcess.length} files`);
    }

    return filesToProcess;
  }

  /**
   * Prune paths that contain ignored directory segments
   * This implements the intelligent filtering to avoid parsing massive directories
   * like node_modules, .git, etc.
   */
  private pruneIgnoredPaths(filePaths: string[]): string[] {
    return filePaths.filter(path => {
      const pathSegments = path.split('/');
      
      // Check if any segment of the path matches an ignore pattern
      const hasIgnoredSegment = pathSegments.some(segment => 
        ParsingProcessor.IGNORE_PATTERNS.has(segment.toLowerCase())
      );
      
      if (hasIgnoredSegment) {
        console.log(`ParsingProcessor: Pruning ignored path: ${path}`);
        return false;
      }
      
      // Additional checks for pattern-based ignoring
      return !this.matchesIgnorePatterns(path);
    });
  }

  /**
   * Check if a path matches additional ignore patterns beyond directory names
   */
  private matchesIgnorePatterns(path: string): boolean {
    const lowerPath = path.toLowerCase();
    
    // Ignore Python egg-info directories
    if (lowerPath.includes('.egg-info/')) {
      return true;
    }
    
    // Ignore site-packages directories (Python virtual environments)
    if (lowerPath.includes('site-packages/')) {
      return true;
    }
    
    // Ignore hidden directories (except specific ones we want)
    const pathParts = path.split('/');
    for (const part of pathParts) {
      if (part.startsWith('.') && !this.isImportantHiddenDirectory(part)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if a hidden directory is important and should not be ignored
   */
  private isImportantHiddenDirectory(dirName: string): boolean {
    // Allow .github but still ignore .vscode (which is in main ignore patterns)
    return dirName === '.github';
  }

  private async initializeParser(): Promise<void> {
    if (this.parser) return;

    try {
      await initTreeSitter();
      this.parser = await initTreeSitter();
      // Eagerly try to load languages; missing WASMs will be tolerated
      try { this.langPython = await (await import('../tree-sitter/parser-loader.ts')).loadPythonParser(); } catch (e) { console.debug('Python grammar not available:', e); }
      try { this.langJavaScript = await loadJavaScriptParser(); } catch (e) { console.debug('JavaScript grammar not available:', e); }
      try { this.langTypeScript = await loadTypeScriptParser(); } catch (e) { console.debug('TypeScript grammar not available:', e); }
      try { this.langTsx = await loadTsxParser(); } catch (e) { console.debug('TSX grammar not available:', e); }
      // Don't set a fixed language here; we'll set per-file below
      console.log('Tree-sitter parser initialized successfully');
    } catch (error) {
      console.error('Failed to initialize parser:', error);
      throw new Error(`Parser initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseFile(filePath: string, fileContent: string): ParsedDefinition[] {
    const extension = this.getFileExtension(filePath);

    // Select language and parse per file using cached languages
    if (this.parser) {
      try {
        const lang = this.getCachedLanguageForExtension(extension);
        if (lang) this.parser.setLanguage(lang);
      } catch (e) {
        console.warn(`Language set failed for ${filePath} (${extension}):`, e);
      }
    }

    if (extension === '.py') {
      if (this.parser) {
        return this.parsePythonFile(filePath, fileContent);
      } else {
        return this.parsePythonFileRegex(filePath, fileContent);
      }
    }

    if (extension === '.js' || extension === '.mjs' || extension === '.cjs' || extension === '.jsx') {
      if (this.parser) {
        return this.parseJavaScriptFile(filePath, fileContent);
      }
      return [];
    }

    if (extension === '.ts') {
      if (this.parser) {
        return this.parseTypeScriptFile(filePath, fileContent);
      }
      return [];
    }

    if (extension === '.tsx') {
      if (this.parser) {
        return this.parseTsxFile(filePath, fileContent);
      }
      return [];
    }

    return [];
  }

  private parsePythonFileRegex(filePath: string, fileContent: string): ParsedDefinition[] {
    const definitions: ParsedDefinition[] = [];
    const lines = fileContent.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNumber = i + 1;
      
      // Extract decorators for upcoming function/class definitions
      const decorators = this.extractDecoratorsRegex(lines, i);
      
      // Match function definitions: def function_name(
      const functionMatch = line.match(/^def\s+(\w+)\s*\(/);
      if (functionMatch) {
        definitions.push({
          name: functionMatch[1],
          type: 'function',
          startLine: lineNumber,
          endLine: lineNumber,
          decorators: decorators.length > 0 ? decorators : undefined
        });
      }
      
      // Match class definitions: class ClassName
      const classMatch = line.match(/^class\s+(\w+)(?:\s*\(.*\))?\s*:/);
      if (classMatch) {
        const baseClasses = this.extractBaseClassesRegex(line);
        definitions.push({
          name: classMatch[1],
          type: 'class',
          startLine: lineNumber,
          endLine: lineNumber,
          decorators: decorators.length > 0 ? decorators : undefined,
          baseClasses: baseClasses.length > 0 ? baseClasses : undefined
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
        
        // Extract decorators for methods (look for indented decorators)
        const methodDecorators = this.extractMethodDecoratorsRegex(lines, i);
        
        definitions.push({
          name: methodMatch[1],
          type: 'method',
          startLine: lineNumber,
          endLine: lineNumber,
          parentClass,
          decorators: methodDecorators.length > 0 ? methodDecorators : undefined
        });
      }
    }
    
    console.log(`Regex-parsed ${definitions.length} Python definitions from ${filePath}`);
    return definitions;
  }

  private extractDecoratorsRegex(lines: string[], currentIndex: number): string[] {
    const decorators: string[] = [];
    
    // Look backwards for decorator lines
    for (let i = currentIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      
      // Stop if we hit a non-decorator, non-empty line
      if (line && !line.startsWith('@')) {
        break;
      }
      
      if (line.startsWith('@')) {
        const decoratorName = this.parseDecoratorNameRegex(line);
        if (decoratorName) {
          decorators.unshift(decoratorName);
        }
      }
    }
    
    return decorators;
  }

  private extractMethodDecoratorsRegex(lines: string[], currentIndex: number): string[] {
    const decorators: string[] = [];
    
    // Look backwards for indented decorator lines
    for (let i = currentIndex - 1; i >= 0; i--) {
      const line = lines[i];
      const trimmedLine = line.trim();
      
      // Stop if we hit a non-decorator line that's not just whitespace
      if (trimmedLine && !trimmedLine.startsWith('@')) {
        break;
      }
      
      if (trimmedLine.startsWith('@') && line.match(/^\s+@/)) {
        const decoratorName = this.parseDecoratorNameRegex(trimmedLine);
        if (decoratorName) {
          decorators.unshift(decoratorName);
        }
      }
    }
    
    return decorators;
  }

  private extractBaseClassesRegex(classLine: string): string[] {
    const baseClasses: string[] = [];
    
    // Match class definition with parentheses: class Child(Parent1, Parent2):
    const match = classLine.match(/^class\s+\w+\s*\(([^)]+)\)\s*:/);
    if (match) {
      const baseClassesStr = match[1].trim();
      if (baseClassesStr) {
        // Split by comma and clean up each base class name
        const classes = baseClassesStr.split(',').map(cls => cls.trim());
        for (const cls of classes) {
          // Handle simple names and qualified names
          const cleanClass = cls.replace(/\s+/g, '');
          if (cleanClass && cleanClass.match(/^[a-zA-Z_][a-zA-Z0-9_.]*$/)) {
            baseClasses.push(cleanClass);
          }
        }
      }
    }
    
    return baseClasses;
  }

  private parseDecoratorNameRegex(decoratorLine: string): string | null {
    // Remove @ symbol and extract decorator name
    const withoutAt = decoratorLine.substring(1);
    
    // Handle simple decorators: @decorator_name
    const simpleMatch = withoutAt.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/);
    if (simpleMatch) {
      return simpleMatch[1];
    }
    
    // Handle decorators with arguments: @decorator_name(args)
    const withArgsMatch = withoutAt.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\(/);
    if (withArgsMatch) {
      return withArgsMatch[1];
    }
    
    return null;
  }

  private parsePythonFile(filePath: string, fileContent: string): ParsedDefinition[] {
    if (!this.parser) {
      console.warn('Parser not initialized. Cannot parse Python file:', filePath);
      return this.parsePythonFileRegex(filePath, fileContent);
    }

    try {
      const tree = this.parser.parse(fileContent);
      
      this.astCache.set(filePath, tree);
      
      const definitions: ParsedDefinition[] = [];
      const rootNode = tree.rootNode;
      const processedMethodNodes = new Set<string>(); // Use unique identifiers instead of node references

      // First pass: identify all methods inside classes and track their positions
      this.traverseNode(rootNode, (currentNode: Parser.SyntaxNode) => {
        if (currentNode.type === 'class_definition') {
          this.traverseNode(currentNode, (methodNode: Parser.SyntaxNode) => {
            if (methodNode.type === 'function_definition' && methodNode !== currentNode) {
              // Create unique identifier for this method node
              const methodId = `${methodNode.startPosition.row}-${methodNode.startPosition.column}-${methodNode.endPosition.row}-${methodNode.endPosition.column}`;
              processedMethodNodes.add(methodId);
            }
          });
        }
      });

      // Second pass: process all definitions, skipping methods that will be handled as class methods
      this.traverseNode(rootNode, (currentNode: Parser.SyntaxNode) => {
        if (currentNode.type === 'function_definition') {
          // Check if this function is actually a method inside a class
          const nodeId = `${currentNode.startPosition.row}-${currentNode.startPosition.column}-${currentNode.endPosition.row}-${currentNode.endPosition.column}`;
          if (processedMethodNodes.has(nodeId)) {
            // Skip this - it's a method that will be processed as part of a class
            return;
          }
          
          const nameNode = currentNode.childForFieldName('name');
          if (nameNode) {
            const decorators = this.extractDecorators(currentNode);
            definitions.push({
              name: nameNode.text,
              type: 'function',
              startLine: currentNode.startPosition.row + 1,
              endLine: currentNode.endPosition.row + 1,
              decorators: decorators.length > 0 ? decorators : undefined
            });
            
            // Extract decorators as separate nodes
            const decoratorNodes = this.extractDecoratorsAsNodes(currentNode, nameNode.text);
            definitions.push(...decoratorNodes);
          }
        } else if (currentNode.type === 'class_definition') {
          const nameNode = currentNode.childForFieldName('name');
          if (nameNode) {
            const className = nameNode.text;
            const decorators = this.extractDecorators(currentNode);
            const baseClasses = this.extractBaseClasses(currentNode);
            definitions.push({
              name: className,
              type: 'class',
              startLine: currentNode.startPosition.row + 1,
              endLine: currentNode.endPosition.row + 1,
              decorators: decorators.length > 0 ? decorators : undefined,
              baseClasses: baseClasses.length > 0 ? baseClasses : undefined
            });
            
            const methods = this.extractMethodsFromClass(currentNode, className);
            definitions.push(...methods);
            
            // Extract decorators as separate nodes
            const decoratorNodes = this.extractDecoratorsAsNodes(currentNode, className);
            definitions.push(...decoratorNodes);
          }
        } else if (currentNode.type === 'assignment') {
          // Extract variable assignments at module level
          const variables = this.extractVariableAssignments(currentNode);
          definitions.push(...variables);
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
                     (definition.type === 'method' ? 'Method' : 
                     (definition.type === 'interface' ? 'Interface' :
                     (definition.type === 'enum' ? 'Enum' :
                     (definition.type === 'decorator' ? 'Decorator' :
                     (definition.type === 'variable' ? 'Variable' : 'Class')))));
    
    const nodeId = generateId(definition.type, `${filePath}:${definition.name}`);
    
    // Create qualified name for trie
    const filePathParts = filePath.replace(/\.(py|js|ts|tsx|jsx)$/, '').split('/');
    const qualifiedName = definition.parentClass 
      ? `${filePathParts.join('.')}.${definition.parentClass}.${definition.name}`
      : `${filePathParts.join('.')}.${definition.name}`;
    
    // Add to function registry trie (extend to include new types)
    this.functionTrie.addDefinition({
      nodeId,
      qualifiedName,
      filePath,
      functionName: definition.name,
      type: definition.type === 'class' ? 'class' : 
            definition.type === 'method' ? 'method' : 
            definition.type === 'interface' ? 'interface' :
            definition.type === 'enum' ? 'enum' :
            definition.type === 'decorator' ? 'function' : // Treat decorators as functions in trie
            definition.type === 'variable' ? 'function' :   // Treat variables as functions in trie
            'function',
      startLine: definition.startLine,
      endLine: definition.endLine
    });
    
    return {
      id: nodeId,
      label: nodeLabel as 'Function' | 'Method' | 'Class' | 'Interface' | 'Enum' | 'Decorator' | 'Variable',
      properties: {
        name: definition.name,
        filePath,
        startLine: definition.startLine,
        endLine: definition.endLine,
        ...(definition.parentClass && { parentClass: definition.parentClass }),
        ...(definition.decorators && { decorators: definition.decorators }),
        ...(definition.baseClasses && { baseClasses: definition.baseClasses }),
        ...(definition.decoratedTarget && { decoratedTarget: definition.decoratedTarget }),
        ...(definition.variableType && { variableType: definition.variableType })
      }
    };
  }

  private createInheritanceRelationships(
    graph: KnowledgeGraph,
    filePath: string,
    definitions: ParsedDefinition[]
  ): void {
    // Create INHERITS relationships for classes with base classes
    const classDefinitions = definitions.filter(def => def.type === 'class');
    
    for (const classDef of classDefinitions) {
      if (classDef.baseClasses && classDef.baseClasses.length > 0) {
        const childClassId = generateId('class', `${filePath}:${classDef.name}`);
        
        for (const baseClassName of classDef.baseClasses) {
          // Try to find the base class in the same file first
          let baseClassId = generateId('class', `${filePath}:${baseClassName}`);
          let baseClassExists = graph.nodes.some(node => node.id === baseClassId);
          
          if (!baseClassExists) {
            // If not found in same file, look for it in other files
            const baseClassNode = graph.nodes.find(node => 
              node.label === 'Class' && 
              node.properties.name === baseClassName
            );
            
            if (baseClassNode) {
              baseClassId = baseClassNode.id;
              baseClassExists = true;
            }
          }
          
          if (baseClassExists) {
            // Create INHERITS relationship
            const inheritanceRelationship: GraphRelationship = {
              id: generateId('relationship', `${childClassId}-inherits-${baseClassId}`),
              type: 'INHERITS',
              source: childClassId,
              target: baseClassId,
              properties: {}
            };
            
            graph.relationships.push(inheritanceRelationship);
            
            // Create OVERRIDES relationships for methods
            this.createOverrideRelationships(graph, filePath, classDef, baseClassName, definitions);
          }
        }
      }
    }
  }

  private createOverrideRelationships(
    graph: KnowledgeGraph,
    filePath: string,
    childClass: ParsedDefinition,
    baseClassName: string,
    allDefinitions: ParsedDefinition[]
  ): void {
    // Get all methods from the child class
    const childMethods = allDefinitions.filter(def => 
      def.type === 'method' && def.parentClass === childClass.name
    );
    
    for (const childMethod of childMethods) {
      // Look for a method with the same name in the base class
      const baseMethodId = this.findBaseClassMethod(graph, baseClassName, childMethod.name);
      
      if (baseMethodId) {
        const childMethodId = generateId('method', `${filePath}:${childMethod.name}`);
        
        // Create OVERRIDES relationship
        const overrideRelationship: GraphRelationship = {
          id: generateId('relationship', `${childMethodId}-overrides-${baseMethodId}`),
          type: 'OVERRIDES',
          source: childMethodId,
          target: baseMethodId,
          properties: {
            methodName: childMethod.name,
            childClass: childClass.name,
            baseClass: baseClassName
          }
        };
        
        graph.relationships.push(overrideRelationship);
      }
    }
  }

  private findBaseClassMethod(graph: KnowledgeGraph, baseClassName: string, methodName: string): string | null {
    // Look for a method with the given name in the base class
    const baseMethod = graph.nodes.find(node => 
      node.label === 'Method' && 
      node.properties.name === methodName &&
      node.properties.parentClass === baseClassName
    );
    
    return baseMethod ? baseMethod.id : null;
  }

  // Remove unused methods to fix linter warnings
  // private createDefinitionRelationships and extractDefinitions are not used

  private extractMethodsFromClass(classNode: Parser.SyntaxNode, className: string): ParsedDefinition[] {
    const methods: ParsedDefinition[] = [];
    
    this.traverseNode(classNode, (node: Parser.SyntaxNode) => {
      if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const decorators = this.extractDecorators(node);
          methods.push({
            name: nameNode.text,
            type: 'method',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            parentClass: className,
            decorators: decorators.length > 0 ? decorators : undefined
          });
        }
      }
    });
    
    return methods;
  }

  private extractBaseClasses(classNode: Parser.SyntaxNode): string[] {
    const baseClasses: string[] = [];
    
    // Look for argument_list node which contains base classes
    const argumentList = classNode.childForFieldName('superclasses');
    if (argumentList) {
      this.traverseNode(argumentList, (node: Parser.SyntaxNode) => {
        if (node.type === 'identifier') {
          baseClasses.push(node.text);
        } else if (node.type === 'attribute') {
          // Handle qualified names like module.ClassName
          baseClasses.push(node.text);
        }
      });
    }
    
    return baseClasses;
  }

  private extractDecorators(node: Parser.SyntaxNode): string[] {
    const decorators: string[] = [];
    
    // Look for decorator nodes that are siblings before the function/class definition
    let currentNode = node.previousSibling;
    
    while (currentNode && currentNode.type === 'decorator') {
      const decoratorName = this.getDecoratorName(currentNode);
      if (decoratorName) {
        decorators.unshift(decoratorName); // Add to beginning to maintain order
      }
      currentNode = currentNode.previousSibling;
    }
    
    return decorators;
  }

  private getDecoratorName(decoratorNode: Parser.SyntaxNode): string | null {
    // Find the identifier or attribute after the '@' symbol
    for (let i = 0; i < decoratorNode.childCount; i++) {
      const child = decoratorNode.child(i);
      if (!child) continue;
      
      if (child.type === 'identifier') {
        return child.text;
      } else if (child.type === 'attribute') {
        // Handle dotted decorators like @app.route
        return child.text;
      } else if (child.type === 'call') {
        // Handle decorators with arguments like @retry(attempts=3)
        const functionNode = child.childForFieldName('function');
        if (functionNode) {
          if (functionNode.type === 'identifier') {
            return functionNode.text;
          } else if (functionNode.type === 'attribute') {
            return functionNode.text;
          }
        }
      }
    }
    
    return null;
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
    // Process Python source files and important Python files
    if (!filePath) return false;
    const fileName = filePath.split('/').pop() || '';
    
    // Include __init__.py files as they're essential for Python packages
    if (fileName === '__init__.py') return true;
    
    const extension = this.getFileExtension(filePath).toLowerCase();
    const sourceExtensions = new Set(['.py', '.js', '.jsx', '.ts', '.tsx']);
    return sourceExtensions.has(extension);
  }

  private isConfigFile(filePath: string): boolean {
    if (!filePath) return false;
    const fileName = filePath.split('/').pop() || '';
    
    const configFiles = new Set([
      'package.json', 'tsconfig.json', 'tsconfig.base.json',
      'vite.config.ts', 'vite.config.js',
      '.eslintrc', '.eslintrc.json', '.eslintrc.js',
      '.prettierrc', '.prettierrc.json',
      'docker-compose.yml', 'docker-compose.yaml',
      'dockerfile', 'Dockerfile',
      '.env', '.env.example', '.env.local',
      'pyproject.toml', 'setup.py', 'requirements.txt'
    ]);
    
    return configFiles.has(fileName.toLowerCase());
  }

  private parseConfigFile(filePath: string, fileContent: string): ParsedDefinition[] {
    const fileName = filePath.split('/').pop() || '';
    const definitions: ParsedDefinition[] = [];
    
    try {
      if (fileName === 'package.json') {
        const packageJson = JSON.parse(fileContent);
        
        // Extract scripts as functions
        if (packageJson.scripts) {
          for (const [scriptName] of Object.entries(packageJson.scripts)) {
            definitions.push({
              name: scriptName,
              type: 'function',
              startLine: 1,
              endLine: 1
            });
          }
        }
        
        // Extract dependencies as metadata (could be used for import resolution)
        const allDeps = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
          ...packageJson.peerDependencies
        };
        
        for (const depName of Object.keys(allDeps)) {
          definitions.push({
            name: depName,
            type: 'class', // Treat dependencies as classes for graph purposes
            startLine: 1,
            endLine: 1
          });
        }
      }
      
      else if (fileName.startsWith('tsconfig')) {
        const tsConfig = JSON.parse(fileContent);
        
        // Extract compiler options as configuration metadata
        if (tsConfig.compilerOptions) {
          definitions.push({
            name: 'TypeScriptConfig',
            type: 'class',
            startLine: 1,
            endLine: 1
          });
        }
      }
      
      else if (fileName.toLowerCase().includes('docker')) {
        // Parse Dockerfile for FROM, COPY, RUN commands
        const lines = fileContent.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('FROM ')) {
            const baseImage = line.substring(5).trim();
            definitions.push({
              name: `FROM_${baseImage.replace(/[^a-zA-Z0-9]/g, '_')}`,
              type: 'class',
              startLine: i + 1,
              endLine: i + 1
            });
          }
        }
      }
      
      else if (fileName.startsWith('.env')) {
        // Parse environment variables
        const lines = fileContent.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line && !line.startsWith('#') && line.includes('=')) {
            const [varName] = line.split('=');
            if (varName) {
              definitions.push({
                name: varName.trim(),
                type: 'function', // Treat env vars as functions for graph purposes
                startLine: i + 1,
                endLine: i + 1
              });
            }
          }
        }
      }
      
    } catch (error) {
      console.warn(`Failed to parse config file ${filePath}:`, error);
    }
    
    return definitions;
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
      case '.js':
      case '.mjs':
      case '.cjs':
      case '.jsx':
        return 'javascript';
      case '.ts':
        return 'typescript';
      case '.tsx':
        return 'tsx';
      default:
        return 'unknown';
    }
  }

  private getCachedLanguageForExtension(extension: string): Parser.Language | null {
    switch (extension) {
      case '.py':
        return this.langPython;
      case '.js':
      case '.mjs':
      case '.cjs':
      case '.jsx':
        return this.langJavaScript;
      case '.ts':
        return this.langTypeScript;
      case '.tsx':
        return this.langTsx;
      default:
        return null;
    }
  }

  private parseJavaScriptFile(filePath: string, fileContent: string): ParsedDefinition[] {
    if (!this.parser) {
      console.warn('Parser not initialized. Cannot parse JavaScript file:', filePath);
      return this.parseJavaScriptFileRegex(filePath, fileContent);
    }

    try {
      const tree = this.parser.parse(fileContent);
      this.astCache.set(filePath, tree);
      
      const definitions: ParsedDefinition[] = [];
      const rootNode = tree.rootNode;

      this.traverseNode(rootNode, (node: Parser.SyntaxNode) => {
        // Function declarations: function foo() {}
        if (node.type === 'function_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            definitions.push({
              name: nameNode.text,
              type: 'function',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          }
        }
        
        // Arrow functions and function expressions: const foo = () => {}
        else if (node.type === 'variable_declarator') {
          const nameNode = node.childForFieldName('name');
          const valueNode = node.childForFieldName('value');
          
          if (nameNode && valueNode && 
              (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
            definitions.push({
              name: nameNode.text,
              type: 'function',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          } else if (nameNode && valueNode) {
            // This is a variable assignment
            definitions.push({
              name: nameNode.text,
              type: 'variable',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              variableType: this.inferTypeFromValue(valueNode)
            });
          }
        }
        
        // Class declarations: class Foo {}
        else if (node.type === 'class_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            const className = nameNode.text;
            
            // Extract base class if extends clause exists
            const baseClasses: string[] = [];
            const superClassNode = node.childForFieldName('superclass');
            if (superClassNode && superClassNode.type === 'identifier') {
              baseClasses.push(superClassNode.text);
            }
            
            definitions.push({
              name: className,
              type: 'class',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              baseClasses: baseClasses.length > 0 ? baseClasses : undefined
            });
            
            // Extract methods from class body
            const methods = this.extractJSMethodsFromClass(node, className);
            definitions.push(...methods);
          }
        }
      });
      
      console.log(`Tree-sitter parsed ${definitions.length} JavaScript definitions from ${filePath}`);
      return definitions;
    } catch (error) {
      console.error(`Error parsing JavaScript file ${filePath}:`, error);
      console.log(`Falling back to regex parsing for ${filePath}`);
      return this.parseJavaScriptFileRegex(filePath, fileContent);
    }
  }

  private parseJavaScriptFileRegex(_filePath: string, fileContent: string): ParsedDefinition[] {
    const definitions: ParsedDefinition[] = [];
    const lines = fileContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ln = i + 1;
      // function foo(
      const fnDecl = line.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (fnDecl) {
        definitions.push({ name: fnDecl[1], type: 'function', startLine: ln, endLine: ln });
        continue;
      }
      // const foo = (...) => or function expression
      const constFn = line.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(/);
      if (constFn) {
        definitions.push({ name: constFn[1], type: 'function', startLine: ln, endLine: ln });
        continue;
      }
      // class Foo
      const classDecl = line.match(/\bclass\s+([A-Za-z_$][\w$]*)\b/);
      if (classDecl) {
        definitions.push({ name: classDecl[1], type: 'class', startLine: ln, endLine: ln });
      }
    }
    return definitions;
  }

  private extractJSMethodsFromClass(classNode: Parser.SyntaxNode, className: string): ParsedDefinition[] {
    const methods: ParsedDefinition[] = [];
    
    // Find class body
    const classBody = classNode.childForFieldName('body');
    if (!classBody) return methods;
    
    this.traverseNode(classBody, (node: Parser.SyntaxNode) => {
      if (node.type === 'method_definition') {
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

  private parseTypeScriptFile(filePath: string, fileContent: string): ParsedDefinition[] {
    if (!this.parser) {
      console.warn('Parser not initialized. Cannot parse TypeScript file:', filePath);
      return this.parseTypeScriptFileRegex(filePath, fileContent);
    }

    try {
      const tree = this.parser.parse(fileContent);
      this.astCache.set(filePath, tree);
      
      const definitions: ParsedDefinition[] = [];
      const rootNode = tree.rootNode;

      this.traverseNode(rootNode, (node: Parser.SyntaxNode) => {
        // Function declarations: function foo() {}
        if (node.type === 'function_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            definitions.push({
              name: nameNode.text,
              type: 'function',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          }
        }
        
        // Arrow functions and function expressions: const foo = () => {}
        else if (node.type === 'variable_declarator') {
          const nameNode = node.childForFieldName('name');
          const valueNode = node.childForFieldName('value');
          
          if (nameNode && valueNode && 
              (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
            definitions.push({
              name: nameNode.text,
              type: 'function',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          } else if (nameNode && valueNode) {
            // This is a variable assignment
            definitions.push({
              name: nameNode.text,
              type: 'variable',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              variableType: this.inferTypeFromValue(valueNode)
            });
          }
        }
        
        // Class declarations: class Foo {}
        else if (node.type === 'class_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            const className = nameNode.text;
            
            // Extract base class if extends clause exists
            const baseClasses: string[] = [];
            const superClassNode = node.childForFieldName('superclass');
            if (superClassNode && superClassNode.type === 'identifier') {
              baseClasses.push(superClassNode.text);
            }
            
            definitions.push({
              name: className,
              type: 'class',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              baseClasses: baseClasses.length > 0 ? baseClasses : undefined
            });
            
            // Extract methods from class body
            const methods = this.extractTSMethodsFromClass(node, className);
            definitions.push(...methods);
          }
        }
        
        // Interface declarations: interface Foo {}
        else if (node.type === 'interface_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            definitions.push({
              name: nameNode.text,
              type: 'interface', // Use correct interface type
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          }
        }
        
        // Type aliases: type Foo = string
        else if (node.type === 'type_alias_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            definitions.push({
              name: nameNode.text,
              type: 'class', // Keep as class for now (type aliases are complex)
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          }
        }
        
        // Enum declarations: enum Foo {}
        else if (node.type === 'enum_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            definitions.push({
              name: nameNode.text,
              type: 'enum', // Use correct enum type
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          }
        }
      });
      
      console.log(`Tree-sitter parsed ${definitions.length} TypeScript definitions from ${filePath}`);
      return definitions;
    } catch (error) {
      console.error(`Error parsing TypeScript file ${filePath}:`, error);
      console.log(`Falling back to regex parsing for ${filePath}`);
      return this.parseTypeScriptFileRegex(filePath, fileContent);
    }
  }

  private parseTypeScriptFileRegex(_filePath: string, fileContent: string): ParsedDefinition[] {
    // Fallback regex parsing for TypeScript
    const definitions: ParsedDefinition[] = [];
    const lines = fileContent.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ln = i + 1;
      
      // function foo(
      const fnDecl = line.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (fnDecl) {
        definitions.push({ name: fnDecl[1], type: 'function', startLine: ln, endLine: ln });
        continue;
      }
      
      // const foo = (...) => or function expression
      const constFn = line.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(/);
      if (constFn) {
        definitions.push({ name: constFn[1], type: 'function', startLine: ln, endLine: ln });
        continue;
      }
      
      // class Foo
      const classDecl = line.match(/\bclass\s+([A-Za-z_$][\w$]*)\b/);
      if (classDecl) {
        definitions.push({ name: classDecl[1], type: 'class', startLine: ln, endLine: ln });
        continue;
      }
      
      // interface Foo
      const interfaceDecl = line.match(/\binterface\s+([A-Za-z_$][\w$]*)\b/);
      if (interfaceDecl) {
        definitions.push({ name: interfaceDecl[1], type: 'interface', startLine: ln, endLine: ln });
        continue;
      }
      
      // type Foo =
      const typeDecl = line.match(/\btype\s+([A-Za-z_$][\w$]*)\s*=/);
      if (typeDecl) {
        definitions.push({ name: typeDecl[1], type: 'class', startLine: ln, endLine: ln });
        continue;
      }
      
      // enum Foo
      const enumDecl = line.match(/\benum\s+([A-Za-z_$][\w$]*)\b/);
      if (enumDecl) {
        definitions.push({ name: enumDecl[1], type: 'enum', startLine: ln, endLine: ln });
      }
    }
    
    return definitions;
  }

  private extractTSMethodsFromClass(classNode: Parser.SyntaxNode, className: string): ParsedDefinition[] {
    const methods: ParsedDefinition[] = [];
    
    // Find class body
    const classBody = classNode.childForFieldName('body');
    if (!classBody) return methods;
    
    this.traverseNode(classBody, (node: Parser.SyntaxNode) => {
      if (node.type === 'method_definition' || node.type === 'method_signature') {
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

  private parseTsxFile(filePath: string, fileContent: string): ParsedDefinition[] {
    if (!this.parser) {
      console.warn('Parser not initialized. Cannot parse TSX file:', filePath);
      return this.parseTsxFileRegex(fileContent);
    }

    try {
      const tree = this.parser.parse(fileContent);
      this.astCache.set(filePath, tree);
      
      const definitions: ParsedDefinition[] = [];
      const rootNode = tree.rootNode;

      this.traverseNode(rootNode, (node: Parser.SyntaxNode) => {
        // Function declarations: function foo() {}
        if (node.type === 'function_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            definitions.push({
              name: nameNode.text,
              type: 'function',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          }
        }
        
        // Arrow functions and function expressions: const foo = () => {}
        else if (node.type === 'variable_declarator') {
          const nameNode = node.childForFieldName('name');
          const valueNode = node.childForFieldName('value');
          
          if (nameNode && valueNode && 
              (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
            definitions.push({
              name: nameNode.text,
              type: 'function',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          }
        }
        
        // Class declarations: class Foo {}
        else if (node.type === 'class_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            const className = nameNode.text;
            
            // Extract base class if extends clause exists
            const baseClasses: string[] = [];
            const superClassNode = node.childForFieldName('superclass');
            if (superClassNode && superClassNode.type === 'identifier') {
              baseClasses.push(superClassNode.text);
            }
            
            definitions.push({
              name: className,
              type: 'class',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              baseClasses: baseClasses.length > 0 ? baseClasses : undefined
            });
            
            // Extract methods from class body
            const methods = this.extractTSXMethodsFromClass(node, className);
            definitions.push(...methods);
          }
        }
        
        // Interface declarations: interface Foo {}
        else if (node.type === 'interface_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            definitions.push({
              name: nameNode.text,
              type: 'interface', // Use correct interface type
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          }
        }
        
        // Type aliases: type Foo = string
        else if (node.type === 'type_alias_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) {
            definitions.push({
              name: nameNode.text,
              type: 'class',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1
            });
          }
        }
      });
      
      console.log(`Tree-sitter parsed ${definitions.length} TSX definitions from ${filePath}`);
      return definitions;
    } catch (error) {
      console.error(`Error parsing TSX file ${filePath}:`, error);
      console.log(`Falling back to regex parsing for ${filePath}`);
      return this.parseTsxFileRegex(fileContent);
    }
  }

  private parseTsxFileRegex(/* filePath: string, */ fileContent: string): ParsedDefinition[] {
    // Fallback regex parsing for TSX (similar to TypeScript but with React components)
    const definitions: ParsedDefinition[] = [];
    const lines = fileContent.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ln = i + 1;
      
      // function foo(
      const fnDecl = line.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (fnDecl) {
        definitions.push({ name: fnDecl[1], type: 'function', startLine: ln, endLine: ln });
        continue;
      }
      
      // const foo = (...) => or function expression (React components)
      const constFn = line.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(/);
      if (constFn) {
        definitions.push({ name: constFn[1], type: 'function', startLine: ln, endLine: ln });
        continue;
      }
      
      // class Foo
      const classDecl = line.match(/\bclass\s+([A-Za-z_$][\w$]*)\b/);
      if (classDecl) {
        definitions.push({ name: classDecl[1], type: 'class', startLine: ln, endLine: ln });
        continue;
      }
      
      // interface Foo
      const interfaceDecl = line.match(/\binterface\s+([A-Za-z_$][\w$]*)\b/);
      if (interfaceDecl) {
        definitions.push({ name: interfaceDecl[1], type: 'interface', startLine: ln, endLine: ln });
        continue;
      }
      
      // type Foo =
      const typeDecl = line.match(/\btype\s+([A-Za-z_$][\w$]*)\s*=/);
      if (typeDecl) {
        definitions.push({ name: typeDecl[1], type: 'class', startLine: ln, endLine: ln });
      }
    }
    
    return definitions;
  }

  private extractTSXMethodsFromClass(classNode: Parser.SyntaxNode, className: string): ParsedDefinition[] {
    const methods: ParsedDefinition[] = [];
    
    // Find class body
    const classBody = classNode.childForFieldName('body');
    if (!classBody) return methods;
    
    this.traverseNode(classBody, (node: Parser.SyntaxNode) => {
      if (node.type === 'method_definition' || node.type === 'method_signature') {
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

  public getAst(filePath: string): Parser.Tree | undefined {
    return this.astCache.get(filePath);
  }

  public getCachedAsts(): Map<string, Parser.Tree> {
    return new Map(this.astCache);
  }

  public getASTMap(): Map<string, ParsedAST> {
    const astMap = new Map<string, ParsedAST>();
    
    for (const [filePath, tree] of this.astCache) {
      const language = this.detectLanguageFromPath(filePath);
      astMap.set(filePath, {
        tree,
        language
      });
    }
    
    return astMap;
  }

  private detectLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'py':
        return 'python';
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'js':
      case 'jsx':
        return 'javascript';
      default:
        return 'unknown';
    }
  }

  public getFunctionRegistry(): FunctionRegistryTrie {
    return this.functionTrie;
  }

  private createClassMethodRelationships(
    graph: KnowledgeGraph,
    filePath: string,
    definitions: ParsedDefinition[]
  ): void {
    const classDefinitions = definitions.filter(def => def.type === 'class');
    const methodDefinitions = definitions.filter(def => def.type === 'method');

    for (const classDef of classDefinitions) {
      const classNodeId = generateId('class', `${filePath}:${classDef.name}`);
      const classNode = graph.nodes.find(node => node.id === classNodeId);

      if (classNode) {
        // Find all methods that belong to this class
        const classMethods = methodDefinitions.filter(method => 
          method.parentClass === classDef.name
        );

        for (const methodDef of classMethods) {
          const methodNodeId = generateId('method', `${filePath}:${methodDef.name}`);
          const methodNode = graph.nodes.find(node => node.id === methodNodeId);

          if (methodNode) {
            // Check if relationship already exists
            const existingRel = graph.relationships.find(r =>
              r.type === 'CONTAINS' &&
              r.source === classNode.id &&
              r.target === methodNode.id
            );

            if (!existingRel) {
              graph.relationships.push({
                id: generateId('relationship', `${classNode.id}-contains-${methodNode.id}`),
                type: 'CONTAINS',
                source: classNode.id,
                target: methodNode.id,
                properties: {
                  relationshipType: 'class-method'
                }
              });
            }
          }
        }
      }
    }
  }

  private createImplementsRelationships(
    graph: KnowledgeGraph,
    filePath: string,
    definitions: ParsedDefinition[]
  ): void {
    const interfaceDefinitions = definitions.filter(def => def.type === 'interface');
    const classDefinitions = definitions.filter(def => def.type === 'class');

    for (const interfaceDef of interfaceDefinitions) {
      const interfaceNodeId = generateId('interface', `${filePath}:${interfaceDef.name}`);
      const interfaceNode = graph.nodes.find(node => node.id === interfaceNodeId);

      if (interfaceNode) {
        // Find all classes that implement this interface
        const implementingClasses = classDefinitions.filter(classDef => 
          classDef.baseClasses && classDef.baseClasses.includes(interfaceDef.name)
        );

        for (const classDef of implementingClasses) {
          const classNodeId = generateId('class', `${filePath}:${classDef.name}`);
          const classNode = graph.nodes.find(node => node.id === classNodeId);

          if (classNode) {
            // Check if relationship already exists
            const existingRel = graph.relationships.find(r =>
              r.type === 'IMPLEMENTS' &&
              r.source === classNode.id &&
              r.target === interfaceNode.id
            );

            if (!existingRel) {
              graph.relationships.push({
                id: generateId('relationship', `${classNode.id}-implements-${interfaceNode.id}`),
                type: 'IMPLEMENTS',
                source: classNode.id,
                target: interfaceNode.id,
                properties: {
                  relationshipType: 'implements'
                }
              });
            }
          }
        }
      }
    }
  }

  private createDecoratorRelationships(
    graph: KnowledgeGraph,
    filePath: string,
    definitions: ParsedDefinition[]
  ): void {
    const decoratorDefinitions = definitions.filter(def => def.type === 'decorator');
    const functionDefinitions = definitions.filter(def => def.type === 'function');

    for (const decoratorDef of decoratorDefinitions) {
      const decoratorNodeId = generateId('decorator', `${filePath}:${decoratorDef.name}`);
      const decoratorNode = graph.nodes.find(node => node.id === decoratorNodeId);

      if (decoratorNode) {
        // Find all functions that are decorated by this decorator
        const decoratedFunctions = functionDefinitions.filter(func => 
          func.decorators && func.decorators.includes(decoratorDef.name)
        );

        for (const funcDef of decoratedFunctions) {
          const funcNodeId = generateId('function', `${filePath}:${funcDef.name}`);
          const funcNode = graph.nodes.find(node => node.id === funcNodeId);

          if (funcNode) {
            // Check if relationship already exists
            const existingRel = graph.relationships.find(r =>
              r.type === 'DECORATES' &&
              r.source === decoratorNode.id &&
              r.target === funcNode.id
            );

            if (!existingRel) {
              graph.relationships.push({
                id: generateId('relationship', `${decoratorNode.id}-decorates-${funcNode.id}`),
                type: 'DECORATES',
                source: decoratorNode.id,
                target: funcNode.id,
                properties: {
                  decoratorName: decoratorDef.name
                }
              });
            }
          }
        }
      }
    }
  }

  private extractDecoratorsAsNodes(node: Parser.SyntaxNode, name: string): ParsedDefinition[] {
    const decoratorNodes: ParsedDefinition[] = [];
    let currentNode = node.previousSibling;

    while (currentNode && currentNode.type === 'decorator') {
      const decoratorName = this.getDecoratorName(currentNode);
      if (decoratorName) {
        decoratorNodes.push({
          name: decoratorName,
          type: 'decorator',
          startLine: currentNode.startPosition.row + 1,
          endLine: currentNode.endPosition.row + 1,
          decoratedTarget: name
        });
      }
      currentNode = currentNode.previousSibling;
    }

    return decoratorNodes;
  }

  private extractVariableAssignments(_node: Parser.SyntaxNode): ParsedDefinition[] {
    const variables: ParsedDefinition[] = [];

    // Look for assignment nodes that are not part of a function or class definition
    // This is a simplified approach; a more robust solution would involve
    // traversing the tree to find top-level assignments.
    // For now, we'll just look for assignments that are not directly inside
    // a function or class definition.

    // This logic needs to be more sophisticated to correctly identify top-level variables
    // and their types. For now, we'll just return an empty array or a placeholder.
    // A proper implementation would involve parsing the tree for variable declarations
    // that are not part of a function or class definition.

    return variables;
  }
  
  private inferTypeFromValue(valueNode: Parser.SyntaxNode): string {
    // Simple type inference based on the value node
    switch (valueNode.type) {
      case 'string':
      case 'template_string':
        return 'string';
      case 'number':
        return 'number';
      case 'true':
      case 'false':
        return 'boolean';
      case 'array':
        return 'array';
      case 'object':
        return 'object';
      case 'null':
        return 'null';
      case 'undefined':
        return 'undefined';
      case 'call_expression':
        // Try to infer from function call
        return 'unknown';
      default:
        return 'unknown';
    }
  }
} 
