import type { KnowledgeGraph, GraphRelationship } from '../graph/types.ts';
import type { ParsedAST } from './parsing-processor.ts';
import Parser from 'web-tree-sitter';

// Simple path utilities for browser compatibility
const pathUtils = {
  extname: (filePath: string): string => {
    const lastDot = filePath.lastIndexOf('.');
    return lastDot === -1 ? '' : filePath.substring(lastDot);
  },
  dirname: (filePath: string): string => {
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return lastSlash === -1 ? '.' : filePath.substring(0, lastSlash);
  },
  resolve: (basePath: string, relativePath: string): string => {
    // Simple relative path resolution
    if (relativePath.startsWith('./')) {
      return basePath + '/' + relativePath.substring(2);
    } else if (relativePath.startsWith('../')) {
      const parts = basePath.split('/');
      const relativeParts = relativePath.split('/');
      let upCount = 0;
      for (const part of relativeParts) {
        if (part === '..') upCount++;
        else break;
      }
      const resultParts = parts.slice(0, -upCount);
      const remainingParts = relativeParts.slice(upCount);
      return [...resultParts, ...remainingParts].join('/');
    }
    return basePath + '/' + relativePath;
  },
  join: (...parts: string[]): string => {
    return parts.join('/').replace(/\/+/g, '/');
  }
};

interface ImportMap {
  [importingFile: string]: {
    [localName: string]: {
      targetFile: string;
      exportedName: string;
      importType: 'default' | 'named' | 'namespace' | 'dynamic';
    }
  }
}

interface ImportInfo {
  importingFile: string;
  localName: string;
  targetFile: string;
  exportedName: string;
  importType: 'default' | 'named' | 'namespace' | 'dynamic';
}

export class ImportProcessor {
  private importMap: ImportMap = {};
  private projectFiles: Set<string> = new Set();

  /**
   * Process all imports after parsing is complete
   * @param graph The knowledge graph being built
   * @param astMap Map of file paths to their parsed ASTs
   * @param fileContents Map of file contents
   * @returns Updated graph with import relationships
   */
  async process(
    graph: KnowledgeGraph, 
    astMap: Map<string, ParsedAST>,
    fileContents: Map<string, string>
  ): Promise<KnowledgeGraph> {
    console.log('ImportProcessor: Starting import resolution...');
    
    // Build set of all project files for validation
    this.projectFiles = new Set(fileContents.keys());
    
    // Clear previous import map
    this.importMap = {};
    
    let totalImportsFound = 0;
    let totalImportsResolved = 0;
    
    // Process imports for each file
    for (const [filePath, ast] of astMap) {
      const fileImports = await this.processFileImports(filePath, ast, graph);
      totalImportsFound += fileImports.found;
      totalImportsResolved += fileImports.resolved;
    }
    
    console.log('ImportProcessor: Completed import resolution');
    console.log(`ImportProcessor: Found ${totalImportsFound} imports, resolved ${totalImportsResolved} (${((totalImportsResolved/totalImportsFound)*100).toFixed(1)}%)`);
    console.log(`ImportProcessor: Built import map for ${Object.keys(this.importMap).length} files`);
    
    return graph;
  }

  /**
   * Process imports for a single file
   */
  private async processFileImports(
    filePath: string, 
    ast: ParsedAST, 
    graph: KnowledgeGraph
  ): Promise<{ found: number; resolved: number }> {
    if (!ast.tree) {
      return { found: 0, resolved: 0 };
    }


    
    const imports = this.extractImports(ast.tree.rootNode, filePath);
    

    
    if (imports.length === 0) return { found: 0, resolved: 0 };

    // Initialize import map for this file
    this.importMap[filePath] = {};

    let found = 0;
    let resolved = 0;

    for (const importInfo of imports) {
      // Store in import map
      this.importMap[filePath][importInfo.localName] = {
        targetFile: importInfo.targetFile,
        exportedName: importInfo.exportedName,
        importType: importInfo.importType
      };

      // Create IMPORTS relationship in graph
      this.createImportRelationship(graph, importInfo);
      found++;
      if (importInfo.targetFile !== importInfo.exportedName) { // Only count as resolved if it's not a default import
        resolved++;
      }
    }
    return { found, resolved };
  }

  /**
   * Extract import statements from AST
   */
  private extractImports(rootNode: Parser.SyntaxNode, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const language = this.detectLanguage(filePath);

    if (language === 'python') {
      this.extractPythonImports(rootNode, filePath, imports);
    } else if (language === 'javascript' || language === 'typescript') {
      this.extractJSImports(rootNode, filePath, imports);
    }

    return imports;
  }

  /**
   * Extract Python imports
   */
  private extractPythonImports(
    node: Parser.SyntaxNode, 
    filePath: string, 
    imports: ImportInfo[]
  ): void {
    if (node.type === 'import_statement') {
      // Handle: import module
      // Handle: import module as alias
      const moduleNode = node.childForFieldName('name');
      if (moduleNode) {
        const moduleName = moduleNode.text;
        const targetFile = this.resolveModulePath(moduleName, filePath, 'python');
        
        imports.push({
          importingFile: filePath,
          localName: moduleName.split('.').pop() || moduleName,
          targetFile,
          exportedName: moduleName,
          importType: 'namespace'
        });
      }
    } else if (node.type === 'import_from_statement') {
      // Handle: from module import name
      // Handle: from module import name as alias
      const moduleNode = node.childForFieldName('module_name');
      const namesNode = node.childForFieldName('name');
      
      if (moduleNode && namesNode) {
        const moduleName = moduleNode.text;
        const targetFile = this.resolveModulePath(moduleName, filePath, 'python');
        
        // Handle multiple imports: from module import a, b, c
        if (namesNode.type === 'import_list') {
          for (let i = 0; i < namesNode.childCount; i++) {
            const nameNode = namesNode.child(i);
            if (nameNode && nameNode.type === 'import_from_statement') {
              const importName = nameNode.text;
              imports.push({
                importingFile: filePath,
                localName: importName,
                targetFile,
                exportedName: importName,
                importType: 'named'
              });
            }
          }
        } else {
          const importName = namesNode.text;
          imports.push({
            importingFile: filePath,
            localName: importName,
            targetFile,
            exportedName: importName,
            importType: 'named'
          });
        }
      }
    }

    // Recursively process children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.extractPythonImports(child, filePath, imports);
      }
    }
  }

  /**
   * Extract JavaScript/TypeScript imports
   */
  private extractJSImports(
    node: Parser.SyntaxNode, 
    filePath: string, 
    imports: ImportInfo[]
  ): void {

    
    if (node.type === 'import_statement') {

      
      // Try different approaches to find the source
      let sourceNode = node.childForFieldName('source');
      if (!sourceNode) {
        // Try finding string literal directly
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && (child.type === 'string' || child.type === 'string_literal')) {
            sourceNode = child;
            break;
          }
        }
      }
      
      if (!sourceNode) {
        return;
      }

      const sourcePath = sourceNode.text.replace(/['"]/g, '');
      const targetFile = this.resolveModulePath(sourcePath, filePath, 'javascript');
      


      // Handle different import patterns
      let importClauseNode: Parser.SyntaxNode | null = node.childForFieldName('import_clause');
      
      // CRITICAL FIX: If field-based approach fails, search by node type 
      if (!importClauseNode) {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child?.type === 'import_clause') {
            importClauseNode = child;
            break;
          }
        }
      }
      
      if (importClauseNode) {
        this.processJSImportClause(importClauseNode, filePath, targetFile, imports);
      } else {
        
        // Handle simple imports like: import 'module'
        if (node.text.trim().startsWith('import') && !node.text.includes('{') && !node.text.includes('from')) {
          imports.push({
            importingFile: filePath,
            localName: '_side_effect_',
            targetFile,
            exportedName: '*',
            importType: 'namespace'
          });

        } else {
          // Try to extract import manually from text as fallback
          const importText = node.text.trim();
          const match = importText.match(/import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/);;
          if (match) {
            const importPart = match[1].trim();
            
            // Handle simple default import
            if (!importPart.includes('{') && !importPart.includes('*')) {
              imports.push({
                importingFile: filePath,
                localName: importPart,
                targetFile,
                exportedName: 'default',
                importType: 'default'
              });

            }
          }
        }
      }
    } else if (node.type === 'variable_declaration') {
      // Handle CommonJS: const x = require('module')
      this.processRequireStatement(node, filePath, imports);
    }

    // Recursively process children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.extractJSImports(child, filePath, imports);
      }
    }
  }

  /**
   * Process JS import clause (handles named, default, namespace imports)
   */
  private processJSImportClause(
    importClauseNode: Parser.SyntaxNode,
    filePath: string,
    targetFile: string,
    imports: ImportInfo[]
  ): void {
    // Track what we've processed to ensure we don't miss anything
    let processedSomething = false;
    
    for (let i = 0; i < importClauseNode.childCount; i++) {
      const child = importClauseNode.child(i);
      if (!child) continue;
      if (child.type === 'identifier') {
        // Default import - this is the most common case we're missing
        imports.push({
          importingFile: filePath,
          localName: child.text,
          targetFile,
          exportedName: 'default',
          importType: 'default'
        });

        processedSomething = true;
      } else if (child.type === 'named_imports') {
        // Process named imports: { a, b, c }
        this.processNamedImportsNode(child, filePath, targetFile, imports);
        processedSomething = true;
      } else if (child.type === 'namespace_import') {
        // Namespace import: * as name
        const nameNode = child.childForFieldName('name');
        if (nameNode) {
          imports.push({
            importingFile: filePath,
            localName: nameNode.text,
            targetFile,
            exportedName: '*',
            importType: 'namespace'
          });

          processedSomething = true;
        }
      } else if (child.type === 'import_specifier') {
        // Direct import specifier (should be handled by named_imports, but just in case)
        const nameNode = child.childForFieldName('name') || child.child(0);
        const aliasNode = child.childForFieldName('alias');
        
        if (nameNode) {
          const exportedName = nameNode.text;
          const localName = aliasNode ? aliasNode.text : exportedName;
          
          imports.push({
            importingFile: filePath,
            localName,
            targetFile,
            exportedName,
            importType: 'named'
          });

          processedSomething = true;
        }
      }
    }
    
    // Fallback: If structured processing didn't work, try text parsing
    if (!processedSomething) {
      const clauseText = importClauseNode.text.trim();
      
      if (clauseText.startsWith('{') && clauseText.endsWith('}')) {
        // Named imports like { foo, bar }
        const namedImports = clauseText.slice(1, -1)
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        
        namedImports.forEach(importName => {
          imports.push({
            importingFile: filePath,
            localName: importName,
            targetFile,
            exportedName: importName,
            importType: 'named'
          });
        });

      } else if (clauseText.includes(' as ')) {
        // Namespace import like * as foo
        const namespaceMatch = clauseText.match(/\*\s+as\s+(\w+)/);
        if (namespaceMatch) {
          imports.push({
            importingFile: filePath,
            localName: namespaceMatch[1],
            targetFile,
            exportedName: '*',
            importType: 'namespace'
          });

        }
      } else {
        // Simple default import
        const defaultName = clauseText.split(',')[0].trim(); // Handle mixed imports
        if (defaultName && !defaultName.includes('{') && !defaultName.includes('*')) {
          imports.push({
            importingFile: filePath,
            localName: defaultName,
            targetFile,
            exportedName: 'default',
            importType: 'default'
          });

        }
      }
    }
  }

  private processNamedImportsNode(
    namedImportsNode: Parser.SyntaxNode,
    filePath: string,
    targetFile: string,
    imports: ImportInfo[]
  ): void {
    for (let j = 0; j < namedImportsNode.childCount; j++) {
      const namedChild = namedImportsNode.child(j);
      if (namedChild && namedChild.type === 'import_specifier') {
        
        const nameNode = namedChild.childForFieldName('name') || namedChild.child(0);
        const aliasNode = namedChild.childForFieldName('alias');
        
        if (nameNode) {
          const exportedName = nameNode.text;
          const localName = aliasNode ? aliasNode.text : exportedName;
          
          imports.push({
            importingFile: filePath,
            localName,
            targetFile,
            exportedName,
            importType: 'named'
          });

        }
      } else if (namedChild && namedChild.type === 'identifier') {
        imports.push({
          importingFile: filePath,
          localName: namedChild.text,
          targetFile,
          exportedName: namedChild.text,
          importType: 'named'
        });

      }
    }
  }

  /**
   * Process CommonJS require statements
   */
  private processRequireStatement(
    node: Parser.SyntaxNode,
    filePath: string,
    imports: ImportInfo[]
  ): void {
    // Look for: const x = require('module')
    const declaratorNode = node.child(1); // variable_declarator
    if (!declaratorNode) return;

    const nameNode = declaratorNode.childForFieldName('name');
    const valueNode = declaratorNode.childForFieldName('value');

    if (nameNode && valueNode && valueNode.type === 'call_expression') {
      const functionNode = valueNode.childForFieldName('function');
      const argumentsNode = valueNode.childForFieldName('arguments');

      if (functionNode?.text === 'require' && argumentsNode) {
        const firstArg = argumentsNode.child(1); // Skip opening paren
        if (firstArg && firstArg.type === 'string') {
          const modulePath = firstArg.text.replace(/['"]/g, '');
          const targetFile = this.resolveModulePath(modulePath, filePath, 'javascript');

          imports.push({
            importingFile: filePath,
            localName: nameNode.text,
            targetFile,
            exportedName: 'default',
            importType: 'dynamic'
          });
        }
      }
    }
  }

  /**
   * Resolve module path to actual file path
   */
  private resolveModulePath(moduleName: string, importingFile: string, language: 'python' | 'javascript'): string {
    // Handle relative imports
    if (moduleName.startsWith('.')) {
      const importingDir = pathUtils.dirname(importingFile);
      const resolvedPath = pathUtils.resolve(importingDir, moduleName);
      
      // Try different extensions
      const extensions = language === 'python' ? ['.py'] : ['.js', '.ts', '.tsx', '.jsx'];
      
      for (const ext of extensions) {
        const candidate = resolvedPath + ext;
        if (this.projectFiles.has(candidate)) {
          return candidate;
        }
      }
      
      // Try index files
      for (const ext of extensions) {
        const indexCandidate = pathUtils.join(resolvedPath, `index${ext}`);
        if (this.projectFiles.has(indexCandidate)) {
          return indexCandidate;
        }
      }
      
      return resolvedPath; // Return even if not found, for external modules
    }

    // Handle absolute/package imports for Python
    if (language === 'python') {
      // First, try to find files that match the module pattern
      const modulePatterns = [
        // Direct module.py
        moduleName.replace(/\./g, '/') + '.py',
        // Package with __init__.py
        moduleName.replace(/\./g, '/') + '/__init__.py',
        // Try within the project structure
        `src/python/${moduleName.replace(/\./g, '/')}.py`,
        `src/python/${moduleName.replace(/\./g, '/')}/__init__.py`,
      ];
      
      // Also try to match partial paths for complex project structures
      for (const filePath of this.projectFiles) {
        if (filePath.endsWith('.py')) {
          // Check if this file could match the module name
          const moduleSegments = moduleName.split('.');
          const pathSegments = filePath.replace('.py', '').split('/');
          
          // Try to match the last few segments
          if (moduleSegments.length > 0) {
            const lastSegment = moduleSegments[moduleSegments.length - 1];
            const fileName = pathSegments[pathSegments.length - 1];
            
            // If the last segment matches the filename, this could be it
            if (fileName === lastSegment) {
              // Check if the path contains the module structure
              const modulePathInFile = moduleSegments.slice(0, -1).join('/');
              if (!modulePathInFile || filePath.includes(modulePathInFile)) {
                return filePath;
              }
            }
          }
        }
      }
      
      // Try the direct patterns
      for (const pattern of modulePatterns) {
        if (this.projectFiles.has(pattern)) {
          return pattern;
        }
      }
      
      // For complex module paths, try to find any file that ends with the module name
      const lastModuleSegment = moduleName.split('.').pop();
      if (lastModuleSegment) {
        for (const filePath of this.projectFiles) {
          if (filePath.endsWith(`${lastModuleSegment}.py`)) {
            return filePath;
          }
        }
      }
    }

    // For external modules or unresolved, return as-is
    return moduleName;
  }

  /**
   * Create IMPORTS relationship in the graph
   */
  private createImportRelationship(graph: KnowledgeGraph, importInfo: ImportInfo): void {
    // Find source and target nodes
    const sourceNode = graph.nodes.find(n => 
      n.label === 'File' && n.properties.filePath === importInfo.importingFile
    );
    
    const targetNode = graph.nodes.find(n => 
      n.label === 'File' && n.properties.filePath === importInfo.targetFile
    );

    if (sourceNode && targetNode && sourceNode.id !== targetNode.id) {
      // Check if relationship already exists
      const existingRel = graph.relationships.find(r =>
        r.type === 'IMPORTS' &&
        r.source === sourceNode.id &&
        r.target === targetNode.id
      );

      if (!existingRel) {
        const relationship: GraphRelationship = {
          id: `imports_${sourceNode.id}_${targetNode.id}_${Date.now()}`,
          type: 'IMPORTS',
          source: sourceNode.id,
          target: targetNode.id,
          properties: {
            importType: importInfo.importType,
            localName: importInfo.localName,
            exportedName: importInfo.exportedName
          }
        };

        graph.relationships.push(relationship);
      }
    }
  }

  /**
   * Detect programming language from file extension
   */
  private detectLanguage(filePath: string): 'python' | 'javascript' | 'typescript' {
    const ext = pathUtils.extname(filePath).toLowerCase();
    
    if (ext === '.py') return 'python';
    if (ext === '.ts' || ext === '.tsx') return 'typescript';
    return 'javascript'; // .js, .jsx, or default
  }

  /**
   * Get the complete import map for use by CallProcessor
   */
  getImportMap(): ImportMap {
    return this.importMap;
  }

  /**
   * Get import info for a specific file and local name
   */
  getImportInfo(filePath: string, localName: string): ImportMap[string][string] | null {
    return this.importMap[filePath]?.[localName] || null;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.importMap = {};
    this.projectFiles.clear();
  }
}

export type { ImportMap, ImportInfo }; 