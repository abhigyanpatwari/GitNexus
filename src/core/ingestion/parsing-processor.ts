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

		if (options?.directoryFilter) {
			filtered = filtered.filter(path => path.includes(options.directoryFilter ?? ''));
		}

		if (options?.fileExtensions) {
			const extensions = options.fileExtensions.split(',').map(ext => ext.trim()).filter(ext => ext.length);
			filtered = filtered.filter(path => extensions.some(ext => path.endsWith(ext)));
		}

		filtered = filtered.filter(path => 
		  ![...IGNORE_PATTERNS].some(pattern => {
		    if (typeof pattern === 'string') {
		      return path.includes(pattern);
		    }
		    return false;
		  })
		);

		filtered = filtered.filter(path => {
		  const content = fileContents.get(path);
		  return content && content.trim().length > 0;
		});

		return filtered;
	}

	private isSourceFile(filePath: string): boolean {
		const sourceExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp', '.cs', '.php', '.rb', '.go', '.rs'];
		return sourceExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
	}

	private isConfigFile(filePath: string): boolean {
		const configFiles = ['package.json', 'tsconfig.json', 'webpack.config.js', 'vite.config.ts', '.eslintrc.js', '.prettierrc'];
		const configExtensions = ['.json', '.yaml', '.yml', '.toml'];

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
    
    // Skip compiled/minified files for JavaScript
    if (language === 'javascript' && this.isCompiledOrMinified(content, filePath)) {
      console.log(`Skipping compiled/minified file: ${filePath}`);
      await this.parseGenericFile(graph, filePath, content);
      return;
    }
    
    const contentHash = this.generateContentHash(content);
    const cacheKey = this.lruCache.generateFileCacheKey(filePath, contentHash);

    // Check cache first - TEMPORARILY DISABLED FOR DEBUGGING
    const cachedResult = null; // this.lruCache.getParsedFile(cacheKey);
    if (cachedResult) {
      console.log(`Cache hit for file: ${filePath}`);
      this.astMap.set(filePath, { tree: cachedResult.ast });
      await this.addDefinitionsToGraph(graph, filePath, cachedResult.definitions);
      return;
    }

    const langParser = this.languageParsers.get(language);

    if (!langParser || !this.parser) {
      // Skip file with reduced logging to avoid console spam
      await this.parseGenericFile(graph, filePath, content);
      return;
    }

    this.parser.setLanguage(langParser);
    const tree = this.parser.parse(content);
    this.astMap.set(filePath, { tree });
    const definitions: ParsedDefinition[] = [];

    const queries = this.getQueriesForLanguage(language);
    if (!queries) {
      console.warn(`No queries available for language: ${language}.`);
      return;
    }

    // Process queries with caching
    for (const [queryName, queryString] of Object.entries(queries)) {
      const queryCacheKey = this.lruCache.generateQueryCacheKey(language, queryString);
      let queryResults: Parser.QueryMatch[] = [];

      // Check query cache - TEMPORARILY DISABLED FOR DEBUGGING
      const cachedQuery = null; // this.lruCache.getQueryResult(queryCacheKey);
      if (cachedQuery) {
        queryResults = cachedQuery.results;
      } else {
        const query = langParser.query(queryString as string);
        queryResults = query.matches(tree.rootNode);
        
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
            
            // Debug: Log what specific definitions we're finding
            if (language === 'python' && filePath.endsWith('.py')) {
              console.log(`🔍 DEBUG: Found ${queryName} -> ${definition.type}: "${definition.name}" in ${filePath.split('/').pop()}`);
            }
          }
        }
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

    // Debug: Log definition extraction results for Python files
    if (language === 'python' && filePath.endsWith('.py')) {
      console.log(`🔍 DEBUG: ${filePath.split('/').pop()} -> ${definitions.length} definitions extracted (content: ${content.length} chars, hash: ${contentHash.substring(0, 8)})`);
      
      // Log definition types for debugging
      const definitionTypes = definitions.reduce((acc, def) => {
        acc[def.type] = (acc[def.type] || 0) + 1;
        return acc;
      }, {});
      
      if (definitions.length > 0) {
        console.log(`🔍 DEBUG: Definition types: ${JSON.stringify(definitionTypes)}`);
      }
      
      if (definitions.length === 0 && content.length > 100) {
        console.log(`🚨 DEBUG: Large Python file with no definitions: ${filePath} (${content.length} chars)`);
        // Log first few lines to understand the content
        const firstLines = content.split('\n').slice(0, 3).join('\\n');
        console.log(`🔍 DEBUG: File starts with: ${firstLines}`);
      }
    }

    await this.addDefinitionsToGraph(graph, filePath, definitions);
	}

  private extractDefinition(node: Parser.SyntaxNode, queryName: string, filePath: string): ParsedDefinition | null {
    const nameNode = node.childForFieldName('name');
    const name = nameNode ? nameNode.text : null;
    
    // Skip anonymous definitions - they're usually from compiled/minified code
    if (!name || name === 'anonymous' || name.trim().length === 0) {
      return null;
    }

    return {
      name,
      type: this.getDefinitionType(queryName),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      filePath,
    } as ParsedDefinition;
  }

  private getDefinitionType(queryName: string): ParsedDefinition['type'] {
    switch (queryName) {
      case 'classes': return 'class';
      case 'methods': return 'method';
      case 'functions':
      case 'arrowFunctions':
      case 'variableAssignments':
      case 'objectMethods': return 'function';
      case 'imports':
      case 'from_imports': return 'import';
      case 'exports':
      case 'defaultExports': return 'function'; // Exports usually export functions
      case 'interfaces': return 'interface';
      case 'types': return 'type';
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
			case '.tsx': return 'typescript';
			case '.js':
			case '.jsx': return 'javascript';
			case '.py': return 'python';
			case '.java': return 'java';
			default: return 'generic';
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
}