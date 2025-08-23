import { GraphNode, GraphRelationship, NodeLabel, RelationshipType } from '../graph/types.js';
import { MemoryManager } from '../../services/memory-manager.js';
import { KnowledgeGraph, GraphProcessor } from '../graph/graph.js';
import {
  pathUtils,
  OptimizedSet,
  DuplicateDetector,
  BatchProcessor
} from '../../lib/shared-utils.js';
import { IGNORE_PATTERNS } from '../../config/language-config.js';
import Parser from 'web-tree-sitter';
import { TYPESCRIPT_QUERIES, JAVASCRIPT_QUERIES, PYTHON_QUERIES, JAVA_QUERIES } from './tree-sitter-queries';
import { initTreeSitter, loadTypeScriptParser, loadPythonParser, loadJavaScriptParser } from '../tree-sitter/parser-loader.js';
import { FunctionRegistryTrie, FunctionDefinition } from '../graph/trie.js';
import { LRUCacheService } from '../../lib/lru-cache-service.js';
import { generateId } from '../../lib/utils';

export interface ParsingInput {
	filePaths: string[];
	fileContents: Map<string, string>;
	options?: { directoryFilter?: string; fileExtensions?: string };
}

export interface ParsedDefinition {
	name: string;
	type: 'function' | 'class' | 'method' | 'variable' | 'import' | 'interface' | 'type' | 'decorator';
	startLine: number;
	endLine?: number;
	parameters?: string[] | undefined;
	returnType?: string | undefined;
	accessibility?: 'public' | 'private' | 'protected';

	isStatic?: boolean | undefined;
	isAsync?: boolean | undefined;
	parentClass?: string | undefined;
	decorators?: string[] | undefined;
	extends?: string[] | undefined;
	implements?: string[] | undefined;
	importPath?: string | undefined;
	exportType?: 'named' | 'default' | 'namespace';
	docstring?: string | undefined;
}

export interface ParsedAST {
  tree: Parser.Tree;
}



export class ParsingProcessor implements GraphProcessor<ParsingInput> {
	private memoryManager: MemoryManager;
	private duplicateDetector = new DuplicateDetector<string>((item: string) => item);
	private processedFiles = new OptimizedSet<string>();
  private parser: Parser | null = null;
  private languageParsers: Map<string, Parser.Language> = new Map();
  private astMap: Map<string, ParsedAST> = new Map();
  private functionTrie: FunctionRegistryTrie = new FunctionRegistryTrie();
  private lruCache: LRUCacheService;

	constructor() {
		this.memoryManager = MemoryManager.getInstance();
		this.lruCache = LRUCacheService.getInstance();
	}

  public getASTMap(): Map<string, ParsedAST> {
    return this.astMap;
  }

  public getFunctionRegistry(): FunctionRegistryTrie {
    return this.functionTrie;
  }

  public getCacheStats() {
    return this.lruCache.getStats();
  }

  public getCacheHitRate() {
    return this.lruCache.getCacheHitRate();
  }

	public async process(graph: KnowledgeGraph, input: ParsingInput): Promise<void> {
		const { filePaths, fileContents, options } = input;

		console.log(`ParsingProcessor: Processing ${filePaths.length} total paths`);

		const memoryStats = this.memoryManager.getStats();
		console.log(`Memory status: ${memoryStats.usedMemoryMB}MB used, ${memoryStats.fileCount} files cached`);

		const filteredFiles = this.applyFiltering(filePaths, fileContents, options);
		
		console.log(`ParsingProcessor: After filtering: ${filteredFiles.length} files to parse`);

		const BATCH_SIZE = 10;
		const sourceFiles = filteredFiles.filter((path: string) => this.isSourceFile(path));
		const configFiles = filteredFiles.filter((path: string) => this.isConfigFile(path));
		const allProcessableFiles = [...sourceFiles, ...configFiles];
		
		console.log(`ParsingProcessor: Found ${sourceFiles.length} source files and ${configFiles.length} config files, processing in batches of ${BATCH_SIZE}`);

		try {
			await this.initializeParser();
			
			const batchProcessor = new BatchProcessor<string, void>(BATCH_SIZE, async (filePaths: string[]) => {
				for (const filePath of filePaths) {
					if (this.processedFiles.has(filePath)) {
						continue;
					}
					
					const content = fileContents.get(filePath);
					if (!content) {
						console.warn(`No content found for file: ${filePath}`);
						continue;
					}
					
					try {
						await this.parseFile(graph, filePath, content);
						this.processedFiles.add(filePath);
					} catch (error) {
						console.error(`Error parsing file ${filePath}:`, error);
					}
				}
				return [];
			});

			
			await batchProcessor.processAll(allProcessableFiles);
			
			console.log(`ParsingProcessor: Successfully processed ${this.processedFiles.size} files`);
			
			// Log cache statistics
			const cacheStats = this.getCacheStats();
			const hitRate = this.getCacheHitRate();
			console.log('ParsingProcessor: Cache Statistics:', {
				fileCache: {
					size: cacheStats.fileCache.size,
					hitRate: `${(hitRate.fileCache * 100).toFixed(1)}%`
				},
				queryCache: {
					size: cacheStats.queryCache.size,
					hitRate: `${(hitRate.queryCache * 100).toFixed(1)}%`
				},
				parserCache: {
					size: cacheStats.parserCache.size,
					hitRate: `${(hitRate.parserCache * 100).toFixed(1)}%`
				}
			});
		} catch (error) {
			console.error('Error initializing parser:', error);
		}
	}

	private applyFiltering(
		filePaths: string[], 
		fileContents: Map<string, string>, 
		options?: { directoryFilter?: string; fileExtensions?: string }): string[] {

		let filtered = filePaths;
		let filteringStats = {
			initial: filtered.length,
			afterDirectoryFilter: 0,
			afterExtensionFilter: 0,
			afterIgnorePatterns: 0,
			afterContentFilter: 0,
			final: 0
		};

		// Apply directory filter if specified
		if (options?.directoryFilter) {
			filtered = filtered.filter(path => path.includes(options.directoryFilter ?? ''));
			console.log(`Filtering by directory '${options.directoryFilter}': ${filteringStats.initial} -> ${filtered.length} files`);
		}
		filteringStats.afterDirectoryFilter = filtered.length;

		// Apply extension filter if specified
		if (options?.fileExtensions) {
			const extensions = options.fileExtensions.split(',').map(ext => ext.trim()).filter(ext => ext.length);
			filtered = filtered.filter(path => extensions.some(ext => path.endsWith(ext)));
			console.log(`Filtering by extensions [${extensions.join(', ')}]: ${filteringStats.afterDirectoryFilter} -> ${filtered.length} files`);
		}
		filteringStats.afterExtensionFilter = filtered.length;

		// Apply ignore patterns (be more selective to avoid over-filtering)
		const beforeIgnoreFilter = filtered.length;
		filtered = filtered.filter(path => {
			// More precise ignore pattern matching
			for (const pattern of IGNORE_PATTERNS) {
				if (typeof pattern === 'string') {
					// Only ignore if the pattern is a complete directory component
					if (path.includes(`/${pattern}/`) || 
						path.startsWith(`${pattern}/`) || 
						path.endsWith(`/${pattern}`) ||
						path === pattern) {
						return false;
					}
				}
			}
			
			// Additional filtering for files that shouldn't be in KG
			const fileName = path.split('/').pop()?.toLowerCase() || '';
			
			// Skip documentation and readme files
			if (fileName.includes('readme') || 
				fileName.includes('license') ||
				fileName.includes('changelog') ||
				fileName.includes('contributing') ||
				fileName.includes('authors') ||
				fileName.includes('maintainers')) {
				return false;
			}
			
			// Skip git and version control files
			if (fileName.startsWith('.git') || 
				fileName.includes('.gitignore') ||
				fileName.includes('.gitattributes')) {
				return false;
			}
			
			// Skip common non-source files
			if (fileName.includes('dockerfile') ||
				fileName.includes('docker-compose') ||
				fileName.endsWith('.md') ||
				fileName.endsWith('.txt') ||
				fileName.endsWith('.log') ||
				fileName.endsWith('.lock')) {
				return false;
			}
			
			return true;
		});
		if (beforeIgnoreFilter !== filtered.length) {
			const excludedCount = beforeIgnoreFilter - filtered.length;
			console.log(`Filtering by ignore patterns and file types: ${beforeIgnoreFilter} -> ${filtered.length} files (${excludedCount} excluded)`);
			
			// Log what types of files were excluded for transparency
			if (excludedCount <= 10) {
				const excluded = filePaths.slice(0, beforeIgnoreFilter).filter(path => !filtered.includes(path));
				console.log('📋 Excluded files sample:', excluded.slice(0, 5).map(p => p.split('/').pop()));
			}
		}
		filteringStats.afterIgnorePatterns = filtered.length;

		// Apply content filter (only exclude truly empty files)
		const beforeContentFilter = filtered.length;
		const emptyFiles: string[] = [];
		filtered = filtered.filter(path => {
			const content = fileContents.get(path);
			if (!content || content.trim().length === 0) {
				emptyFiles.push(path);
				return false;
			}
			return true;
		});
		if (emptyFiles.length > 0) {
			console.log(`Filtering empty files: ${beforeContentFilter} -> ${filtered.length} files (${emptyFiles.length} empty)`);
			if (emptyFiles.length <= 5) {
				console.log('Empty files:', emptyFiles);
			}
		}
		filteringStats.afterContentFilter = filtered.length;
		filteringStats.final = filtered.length;

		// Log comprehensive filtering summary
		console.log('📊 File Filtering Summary:', filteringStats);
		
		// Show sample of filtered files by type
		const filesByExtension = filtered.reduce((acc, path) => {
			const ext = pathUtils.extname(path).toLowerCase() || 'no-extension';
			acc[ext] = (acc[ext] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);
		console.log('📋 Files by extension:', filesByExtension);
		
		// Debug: Check for specific TSX/TS files
		const tsxFiles = filtered.filter(path => path.endsWith('.tsx'));
		const tsFiles = filtered.filter(path => path.endsWith('.ts'));
		if (tsxFiles.length > 0) {
			console.log(`🔍 TSX FILES: Found ${tsxFiles.length} TSX files:`, tsxFiles.slice(0, 5).map(p => p.split('/').pop()));
		}
		if (tsFiles.length > 0) {
			console.log(`🔍 TS FILES: Found ${tsFiles.length} TS files:`, tsFiles.slice(0, 5).map(p => p.split('/').pop()));
		}
		
		// Specifically check for ChatInterface.tsx
		const chatInterface = filtered.find(path => path.includes('ChatInterface.tsx'));
		if (chatInterface) {
			console.log(`🎯 FOUND ChatInterface.tsx in filtered files: ${chatInterface}`);
		} else {
			const originalChatInterface = filePaths.find(path => path.includes('ChatInterface.tsx'));
			if (originalChatInterface) {
				console.warn(`⚠️ ChatInterface.tsx was FILTERED OUT: ${originalChatInterface}`);
			}
		}
		
		// Warn about potentially inappropriate files
		const suspiciousFiles = filtered.filter(path => {
			const fileName = path.split('/').pop()?.toLowerCase() || '';
			return fileName.includes('test') || 
				fileName.includes('spec') ||
				fileName.includes('mock') ||
				fileName.includes('fixture') ||
				path.includes('/test/') ||
				path.includes('/tests/') ||
				path.includes('/__tests__/') ||
				path.includes('/spec/');
		});
		
		if (suspiciousFiles.length > 0) {
			console.warn(`⚠️ Found ${suspiciousFiles.length} test/spec files that will be processed:`);
			console.warn('Test files sample:', suspiciousFiles.slice(0, 3).map(p => p.split('/').pop()));
			console.warn('Consider if these should be excluded from the knowledge graph');
		}

		return filtered;
	}

	private isSourceFile(filePath: string): boolean {
		// Only include actual programming language source files
		const sourceExtensions = [
			// JavaScript/TypeScript (core web technologies)
			'.js', '.ts', '.jsx', '.tsx',
			// Python
			'.py',
			// Java
			'.java',
			// C/C++
			'.cpp', '.c', '.cc', '.cxx', '.h', '.hpp', '.hxx',
			// C#
			'.cs',
			// Only include other languages if they're commonly used
			'.php', '.rb', '.go', '.rs'
			// Removed: .mjs, .cjs (might be build artifacts)
			// Removed: .html, .htm, .xml (markup, not source code)
			// Removed: .vue, .svelte (framework-specific)
			// Removed: .kt, .scala, .swift (less common)
		];
		return sourceExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
	}

	private isConfigFile(filePath: string): boolean {
		// Only include config files that might contain meaningful definitions
		const configFiles = [
			'package.json', 'tsconfig.json', 'jsconfig.json',
			'webpack.config.js', 'vite.config.ts', 'vite.config.js',
			'.eslintrc.js', '.eslintrc.json',
			'babel.config.js', 'rollup.config.js'
			// Removed: .prettierrc (formatting, no definitions)
			// Removed: pyproject.toml, setup.py (might be worth including if Python project)
			// Removed: requirements.txt (just dependencies)
			// Removed: Dockerfile, docker-compose.yml (deployment, not source)
			// Removed: .gitignore, .gitattributes (git config, no definitions)
			// Removed: README.md, LICENSE (documentation, no definitions)
		];
		const configExtensions = ['.json']; // Only JSON configs, removed .yaml, .yml, .toml, .ini, .cfg

		return configFiles.some(name => filePath.endsWith(name)) ||
			configExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
	}

	private async initializeParser(): Promise<void> {
    if (this.parser) return;
    
    this.parser = await initTreeSitter();

    const languageLoaders = {
      typescript: loadTypeScriptParser,
      javascript: loadJavaScriptParser,
      python: loadPythonParser,
    };

    for (const [lang, loader] of Object.entries(languageLoaders)) {
      try {
        // Check cache first
        let languageParser = this.lruCache.getParser(lang);
        if (!languageParser) {
          languageParser = await loader();
          this.lruCache.setParser(lang, languageParser);
          console.log(`${lang} parser loaded and cached successfully.`);
        } else {
          console.log(`${lang} parser loaded from cache.`);
        }
        this.languageParsers.set(lang, languageParser);
      } catch (error) {
        console.error(`Failed to load ${lang} parser:`, error);
      }
    }
	}

	private async parseFile(graph: KnowledgeGraph, filePath: string, content: string): Promise<void> {
    const language = this.detectLanguage(filePath);
    const fileName = pathUtils.getFileName(filePath);
    
    // Skip compiled/minified files for JavaScript
    if (language === 'javascript' && this.isCompiledOrMinified(content, filePath)) {
      console.log(`Skipping compiled/minified file: ${fileName}`);
      await this.parseGenericFile(graph, filePath, content);
      return;
    }
    
    const contentHash = this.generateContentHash(content);
    const cacheKey = this.lruCache.generateFileCacheKey(filePath, contentHash);

    // Check cache first - TEMPORARILY DISABLED FOR DEBUGGING
    const cachedResult = null; // this.lruCache.getParsedFile(cacheKey);
    if (cachedResult) {
      console.log(`Cache hit for file: ${fileName}`);
      this.astMap.set(filePath, { tree: cachedResult.ast });
      await this.addDefinitionsToGraph(graph, filePath, cachedResult.definitions);
      return;
    }

    const langParser = this.languageParsers.get(language);

    if (!langParser || !this.parser) {
      console.warn(`⚠️ SKIPPING: ${fileName} - No parser available (language: ${language}, hasLangParser: ${!!langParser}, hasMainParser: ${!!this.parser})`);
      await this.parseGenericFile(graph, filePath, content);
      return;
    }

    try {
      this.parser.setLanguage(langParser);
      const tree = this.parser.parse(content);
      this.astMap.set(filePath, { tree });
      const definitions: ParsedDefinition[] = [];

      const queries = this.getQueriesForLanguage(language);
      if (!queries) {
        console.warn(`No queries available for language: ${language} (${fileName}).`);
        await this.parseGenericFile(graph, filePath, content);
        return;
      }

      let totalMatches = 0;
      // Process queries with caching
      for (const [queryName, queryString] of Object.entries(queries)) {
        const queryCacheKey = this.lruCache.generateQueryCacheKey(language, queryString);
        let queryResults: Parser.QueryMatch[] = [];

        try {
          // Check query cache - TEMPORARILY DISABLED FOR DEBUGGING
          const cachedQuery = null; // this.lruCache.getQueryResult(queryCacheKey);
          if (cachedQuery) {
            queryResults = cachedQuery.results;
          } else {
            const query = langParser.query(queryString as string);
            queryResults = query.matches(tree.rootNode);
            totalMatches += queryResults.length;
            
            // Cache query results
            this.lruCache.setQueryResult(queryCacheKey, {
              query: queryString,
              results: queryResults,
              timestamp: Date.now()
            });
          }

          for (const match of queryResults) {
            for (const capture of match.captures) {
              const node = capture.node;
              const definition = this.extractDefinition(node, queryName, filePath);
              if (definition) {
                definitions.push(definition);
                
                // Debug: Log what specific definitions we're finding for certain files
                if (fileName.endsWith('.py') || fileName.endsWith('.ts') || fileName.endsWith('.js')) {
                  console.log(`🔍 DEBUG: Found ${queryName} -> ${definition.type}: "${definition.name}" in ${fileName}:${definition.startLine}`);
                }
              }
            }
          }
        } catch (queryError) {
          console.warn(`Query error in ${fileName} for ${queryName}:`, queryError);
        }
      }

      // Cache the parsed file results
      this.lruCache.setParsedFile(cacheKey, {
        ast: tree,
        definitions,
        language,
        lastModified: Date.now(),
        fileSize: content.length
      });

      // Enhanced debug logging
      console.log(`🔍 PARSING: ${fileName} (${language}) -> ${definitions.length} definitions from ${totalMatches} matches (content: ${content.length} chars)`);
      
      // Log definition types for debugging
      if (definitions.length > 0) {
        const definitionTypes = definitions.reduce((acc, def) => {
          acc[def.type] = (acc[def.type] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        console.log(`🔍 TYPES: ${fileName} -> ${JSON.stringify(definitionTypes)}`);
      } else if (content.length > 100 && language !== 'generic') {
        console.warn(`🚨 NO DEFINITIONS: ${fileName} (${language}, ${content.length} chars, ${totalMatches} total matches)`);
        // Log first few lines to understand the content
        const firstLines = content.split('\n').slice(0, 3).join('\\n').substring(0, 150);
        console.warn(`🔍 CONTENT PREVIEW: ${firstLines}...`);
      }

      await this.addDefinitionsToGraph(graph, filePath, definitions);
    } catch (parseError) {
      console.error(`Error parsing ${fileName}:`, parseError);
      await this.parseGenericFile(graph, filePath, content);
    }
	}

  private extractDefinition(node: Parser.SyntaxNode, queryName: string, filePath: string): ParsedDefinition | null {
    let nameNode = node.childForFieldName('name');
    let name = nameNode ? nameNode.text : null;
    
    // Handle different naming patterns for different query types
    if (!name) {
      // Try alternative naming strategies based on query type
      switch (queryName) {
        case 'variables':
        case 'constDeclarations':
        case 'global_variables':
          // For variable assignments, look for identifier in left side
          const leftChild = node.namedChildren.find(child => child.type === 'identifier');
          if (leftChild) name = leftChild.text;
          break;
          
        case 'hookCalls':
        case 'hookDestructuring':
          // For React hooks, try to get the variable name
          const hookVar = node.namedChildren.find(child => child.type === 'variable_declarator');
          if (hookVar) {
            const hookName = hookVar.childForFieldName('name');
            if (hookName) {
              // Handle array destructuring for useState pattern
              if (hookName.type === 'array_pattern') {
                const elements = hookName.namedChildren.filter(child => child.type === 'identifier');
                if (elements.length > 0) {
                  name = elements.map(el => el.text).join(', ');
                }
              } else {
                name = hookName.text;
              }
            }
          }
          break;
          
        case 'reactComponents':
        case 'reactConstComponents':
        case 'defaultExportArrows':
          // For React components, get the component name
          const componentVar = node.namedChildren.find(child => child.type === 'variable_declarator');
          if (componentVar) {
            const componentName = componentVar.childForFieldName('name');
            if (componentName) name = componentName.text;
          }
          break;
          
        case 'moduleExports':
          // For module.exports = something, get the property name
          const memberExpr = node.namedChildren.find(child => child.type === 'member_expression');
          if (memberExpr) {
            const property = memberExpr.childForFieldName('property');
            if (property) name = property.text;
          }
          break;
          
        case 'decorators':
          // For decorators, get the decorator name
          const decoratorChild = node.namedChildren.find(child => child.type === 'identifier');
          if (decoratorChild) name = decoratorChild.text;
          break;
          
        default:
          // Try to find any identifier child
          const identifierChild = node.namedChildren.find(child => child.type === 'identifier');
          if (identifierChild) name = identifierChild.text;
      }
    }
    
    // Skip anonymous definitions - they're usually from compiled/minified code
    if (!name || name === 'anonymous' || name.trim().length === 0) {
      return null;
    }
    
    // Skip very short names that are likely noise (but keep single-letter variables like 'i', 'x')
    if (name.length === 1 && queryName !== 'variables' && queryName !== 'constDeclarations') {
      return null;
    }
    
    // Skip common noise patterns
    const noisePatterns = ['_', '__', '___', 'temp', 'tmp'];
    if (noisePatterns.includes(name.toLowerCase())) {
      return null;
    }

    const definition: ParsedDefinition = {
      name,
      type: this.getDefinitionType(queryName),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
    
    // Extract additional metadata based on definition type
    if (definition.type === 'function' || definition.type === 'method') {
      // Try to extract parameters
      const parametersNode = node.childForFieldName('parameters');
      if (parametersNode) {
        const params: string[] = [];
        for (const param of parametersNode.namedChildren) {
          if (param.type === 'identifier' || param.type === 'formal_parameter') {
            params.push(param.text);
          }
        }
        if (params.length > 0) {
          definition.parameters = params;
        }
      }
      
      // Check for async functions - removed async queries as they were causing Tree-sitter errors
      // if (queryName === 'async_functions' || queryName === 'async_methods') {
      //   definition.isAsync = true;
      // }
      
      // Mark React components
      if (queryName === 'reactComponents' || queryName === 'reactConstComponents') {
        definition.isAsync = false; // React components are not async by default
        definition.exportType = 'default'; // Most React components are default exports
      }
    }
    
    if (definition.type === 'class') {
      // Try to extract inheritance information
      const superclassNode = node.childForFieldName('superclass');
      if (superclassNode) {
        definition.extends = [superclassNode.text];
      }
    }
    
    // Handle variable types with additional context
    if (definition.type === 'variable') {
      if (queryName === 'hookCalls' || queryName === 'hookDestructuring') {
        definition.exportType = 'named'; // React hooks are typically named exports
        
        // Try to extract hook type from call expression
        const callExpr = node.descendantsOfType('call_expression')[0];
        if (callExpr) {
          const funcNode = callExpr.childForFieldName('function');
          if (funcNode && funcNode.type === 'identifier') {
            definition.returnType = funcNode.text; // Store hook function name
          }
        }
      }
    }
    
    return definition;
  }

  private getDefinitionType(queryName: string): ParsedDefinition['type'] {
    switch (queryName) {
      case 'classes': 
      case 'exportClasses': return 'class';
      case 'methods': 
      case 'properties':
      case 'staticmethods':
      case 'classmethods': return 'method';
      case 'functions':
      case 'arrowFunctions':
      case 'reactComponents':
      case 'reactConstComponents':
      case 'defaultExportArrows':
      case 'variableAssignments':
      case 'objectMethods':
      case 'exportFunctions':
      case 'defaultExportFunctions':
      case 'functionExpressions': return 'function';
      case 'variables':
      case 'constDeclarations':
      case 'hookCalls':
      case 'hookDestructuring':
      case 'global_variables': return 'variable';
      case 'imports':
      case 'from_imports': return 'import';
      case 'exports':
      case 'defaultExports':
      case 'moduleExports': return 'function'; // Exports usually export functions
      case 'interfaces': return 'interface';
      case 'types': return 'type';
      case 'enums': return 'type';
      case 'decorators': return 'decorator';
      default: 
        console.warn(`Unknown query type: ${queryName}, defaulting to 'function'`);
        return 'function'; // Better default than 'variable'
    }
  }

  private isCompiledOrMinified(content: string, filePath: string): boolean {
    // Check file name patterns for known compiled files
    const fileName = filePath.split('/').pop()?.toLowerCase() || '';
    if (fileName.includes('.min.') || 
        fileName.includes('.bundle.') ||
        fileName.includes('tree-sitter.js') ||
        fileName.includes('kuzu_wasm_worker.js')) {
      return true;
    }
    
    // Check content characteristics for minified code
    const lines = content.split('\n');
    if (lines.length > 0) {
      const firstLine = lines[0];
      
      // Very long first line (typical of minified code)
      if (firstLine.length > 500) {
        return true;
      }
      
      // Contains typical minified patterns
      if (firstLine.includes('var Module=void 0!==Module?Module:{}') ||
          firstLine.includes('__webpack_require__') ||
          firstLine.includes('!function(') ||
          content.includes('/*! ') || // Webpack/build tool comments
          content.match(/^\s*!function\s*\(/)) { // IIFE patterns
        return true;
      }
    }
    
    return false;
  }

	private detectLanguage(filePath: string): string {
		const extension = pathUtils.extname(filePath).toLowerCase();

		switch (extension) {
			case '.ts':
			case '.tsx': 
				console.log(`🔍 LANGUAGE: ${filePath.split('/').pop()} -> typescript (${extension})`);
				return 'typescript';
			case '.js':
			case '.jsx': 
				console.log(`🔍 LANGUAGE: ${filePath.split('/').pop()} -> javascript (${extension})`);
				return 'javascript';
			case '.py': 
				console.log(`🔍 LANGUAGE: ${filePath.split('/').pop()} -> python (${extension})`);
				return 'python';
			case '.java': 
				console.log(`🔍 LANGUAGE: ${filePath.split('/').pop()} -> java (${extension})`);
				return 'java';
			default: 
				console.log(`🔍 LANGUAGE: ${filePath.split('/').pop()} -> generic (${extension})`);
				return 'generic';
		}
	}

  private getQueriesForLanguage(language: string): Record<string, string> | null {
    switch (language) {
      case 'typescript':
        return TYPESCRIPT_QUERIES;
      case 'javascript':
        return JAVASCRIPT_QUERIES; // Use separate JavaScript queries
      case 'python':
        return PYTHON_QUERIES;
      case 'java':
        return JAVA_QUERIES;
      default:
        return null;
    }
  }

	private async parseGenericFile(graph: KnowledgeGraph, filePath: string, _content: string): Promise<void> {
		// Find existing file node created by StructureProcessor
		let fileNode = graph.nodes.find(node => 
			node.label === 'File' && 
			(node.properties.filePath === filePath || node.properties.path === filePath)
		);

		// If no existing file node found, create one (fallback)
		if (!fileNode) {
			fileNode = {
				id: generateId(`file_${filePath}`),
				label: 'File' as NodeLabel,
				properties: {
					name: pathUtils.getFileName(filePath),
					path: filePath,
					filePath: filePath,
					size: _content.length,
					language: this.detectLanguage(filePath)
				}
			};
			graph.addNode(fileNode);
		} else {
			// Update existing file node with additional properties
			fileNode.properties.size = _content.length;
			fileNode.properties.language = this.detectLanguage(filePath);
		}
	}

	private async addDefinitionsToGraph(
		graph: KnowledgeGraph, 
		filePath: string, 
		definitions: ParsedDefinition[]
	): Promise<void> {
		// Find existing file node created by StructureProcessor
		let fileNode = graph.nodes.find(node => 
			node.label === 'File' && 
			(node.properties.filePath === filePath || node.properties.path === filePath)
		);

		// If no existing file node found, create one (fallback)
		if (!fileNode) {
			fileNode = { 
				id: generateId(`file_${filePath}`),
				label: 'File' as NodeLabel,
				properties: {
					name: pathUtils.getFileName(filePath),
					path: filePath,
					filePath: filePath,
					language: this.detectLanguage(filePath)
				}
			};
			graph.addNode(fileNode);
		}

		for (const def of definitions) {
			// Generate unique ID based on file path and definition name
			const nodeId = generateId(`${def.type}_${filePath}_${def.name}_${def.startLine}`);

			if (this.duplicateDetector.checkAndMark(nodeId)) continue;

			const node: GraphNode = {
				id: nodeId,
				label: this.getNodeLabelForType(def.type),
				properties: {
					name: def.name,
					type: def.type,
					startLine: def.startLine,
					endLine: def.endLine,
					parameters: def.parameters,
					returnType: def.returnType,
					accessibility: def.accessibility,
					isStatic: def.isStatic,
					isAsync: def.isAsync,
					parentClass: def.parentClass,
					decorators: def.decorators,
					extends: def.extends,
					implements: def.implements,
					importPath: def.importPath,
					exportType: def.exportType,
					docstring: def.docstring,
					filePath: filePath
				}
			};

			graph.addNode(node);

      if (def.type === 'function' || def.type === 'method' || def.type === 'class' || def.type === 'interface') {
        const functionDef: FunctionDefinition = {
          nodeId: nodeId,
          qualifiedName: `${filePath}:${def.name}`,
          filePath: filePath,
          functionName: def.name,
          type: def.type,
          startLine: def.startLine,
          endLine: def.endLine,
        };
        this.functionTrie.addDefinition(functionDef);
      }

			const definesRelationship: GraphRelationship = {
				id: generateId('defines'),
				type: 'DEFINES' as RelationshipType,
				source: fileNode.id,
				target: node.id,
				properties: { 
					filePath: filePath, 
					line_number: def.startLine 
				}
			};

			graph.addRelationship(definesRelationship);

			if (def.extends && def.extends.length > 0) {
				def.extends.forEach(() => {
					const extendsRelationship: GraphRelationship = { 
						id: generateId('extends'),
						type: 'EXTENDS' as RelationshipType,
						source: node.id,
						target: generateId('class'),
						properties: {}
					};

					graph.addRelationship(extendsRelationship);
				});
			}

			if (def.implements && def.implements.length > 0) {
				def.implements.forEach(() => {
					const implementsRelationship: GraphRelationship = {
						id: generateId('implements'),
						type: 'IMPLEMENTS' as RelationshipType,
						source: node.id,
						target: generateId('interface'),
						properties: {}
					};

					graph.addRelationship(implementsRelationship);
				});
			}

			if (def.importPath) {
				const importRelationship: GraphRelationship = { 
					id: generateId('imports'),
					type: 'IMPORTS' as RelationshipType,
					source: node.id, 
					target: generateId('file'),
					properties: { 
						importPath: def.importPath 
					}
				};
				graph.addRelationship(importRelationship);
			}

			if (def.parentClass) {			  
				const parentRelationship: GraphRelationship = {
					id: generateId('belongs_to'),
					type: 'BELONGS_TO' as RelationshipType,
					source: node.id,
					target: generateId('class'), 
					properties: {}
				};
				graph.addRelationship(parentRelationship);
			}
		}
	}

	private getNodeLabelForType(type: string): NodeLabel {
		switch (type) {			
			case 'class': return 'Class' as NodeLabel;
			case 'function': return 'Function' as NodeLabel;
			case 'method': return 'Method' as NodeLabel;
			case 'variable': return 'Variable' as NodeLabel;
			case 'import': return 'Import' as NodeLabel;
			case 'interface': return 'Interface' as NodeLabel;
			case 'type': return 'Type' as NodeLabel;
			case 'decorator': return 'Decorator' as NodeLabel;
			default: return 'CodeElement' as NodeLabel;
		}
	}

	private generateContentHash(content: string): string {
		let hash = 0;
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash;
		}
		return Math.abs(hash).toString(36);
	}

	public reset(): void {
		this.processedFiles.clear();
		this.duplicateDetector.clear();
		this.memoryManager.clearCache();
		this.lruCache.clearAll();
	}

	/**
	 * Diagnostic method to analyze why files might not have definitions
	 */
	public getDiagnosticInfo(): {
		processedFiles: number;
		skippedFiles: number;
		totalDefinitions: number;
		definitionsByType: Record<string, number>;
		definitionsByFile: Record<string, number>;
		processingErrors: string[];
	} {
		const definitionsByType: Record<string, number> = {};
		const definitionsByFile: Record<string, number> = {};
		let totalDefinitions = 0;

		// Analyze function registry
		const allDefs = this.functionTrie.getAllDefinitions();
		allDefs.forEach(def => {
			totalDefinitions++;
			definitionsByType[def.type] = (definitionsByType[def.type] || 0) + 1;
			definitionsByFile[def.filePath] = (definitionsByFile[def.filePath] || 0) + 1;
		});

		return {
			processedFiles: this.processedFiles.size,
			skippedFiles: 0, // Would need to track this during processing
			totalDefinitions,
			definitionsByType,
			definitionsByFile,
			processingErrors: [] // Would need to track errors during processing
		};
	}

	/**
	 * Method to analyze a specific file and explain why it might not have definitions
	 */
	public async analyzeFile(filePath: string, content: string): Promise<{
		language: string;
		isSourceFile: boolean;
		isConfigFile: boolean;
		isCompiled: boolean;
		contentLength: number;
		queryResults: Record<string, number>;
		extractionIssues: string[];
	}> {
		const language = this.detectLanguage(filePath);
		const isSourceFile = this.isSourceFile(filePath);
		const isConfigFile = this.isConfigFile(filePath);
		const isCompiled = language === 'javascript' && this.isCompiledOrMinified(content, filePath);
		const extractionIssues: string[] = [];
		const queryResults: Record<string, number> = {};

		if (!isSourceFile && !isConfigFile) {
			extractionIssues.push('File is not recognized as a source or config file');
		}

		if (isCompiled) {
			extractionIssues.push('File appears to be compiled/minified and is skipped');
		}

		if (content.trim().length === 0) {
			extractionIssues.push('File is empty');
		}

		const langParser = this.languageParsers.get(language);
		if (!langParser || !this.parser) {
			extractionIssues.push(`No parser available for language: ${language}`);
		} else {
			try {
				this.parser.setLanguage(langParser);
				const tree = this.parser.parse(content);
				
				const queries = this.getQueriesForLanguage(language);
				if (queries) {
					for (const [queryName, queryString] of Object.entries(queries)) {
						try {
							const query = langParser.query(queryString as string);
							const matches = query.matches(tree.rootNode);
							queryResults[queryName] = matches.length;
						} catch (queryError) {
							extractionIssues.push(`Query '${queryName}' failed: ${queryError}`);
						}
					}
				} else {
					extractionIssues.push(`No queries available for language: ${language}`);
				}
			} catch (parseError) {
				extractionIssues.push(`Parse error: ${parseError}`);
			}
		}

		return {
			language,
			isSourceFile,
			isConfigFile,
			isCompiled,
			contentLength: content.length,
			queryResults,
			extractionIssues
		};
	}
}