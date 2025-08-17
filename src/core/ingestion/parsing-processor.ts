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
import { TYPESCRIPT_QUERIES, PYTHON_QUERIES, JAVA_QUERIES } from './tree-sitter-queries.ts';
import { initTreeSitter, loadTypeScriptParser, loadPythonParser, loadJavaScriptParser } from '../tree-sitter/parser-loader.js';
import { FunctionRegistryTrie, FunctionDefinition } from '../graph/trie.js';

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

function generateId(prefix: string, identifier: string): string {
	let hash = 0;
	for (let i = 0; i < identifier.length; i++) {
		const char = identifier.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return `${prefix}-${Math.abs(hash)}-${identifier.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

export class ParsingProcessor implements GraphProcessor<ParsingInput> {
	private memoryManager: MemoryManager;
	private duplicateDetector = new DuplicateDetector<string>((item: string) => item);
	private processedFiles = new OptimizedSet<string>();
  private parser: Parser | null = null;
  private languageParsers: Map<string, Parser.Language> = new Map();
  private astMap: Map<string, ParsedAST> = new Map();
  private functionTrie: FunctionRegistryTrie = new FunctionRegistryTrie();

	constructor() {
		this.memoryManager = MemoryManager.getInstance();
	}

  public getASTMap(): Map<string, ParsedAST> {
    return this.astMap;
  }

  public getFunctionRegistry(): FunctionRegistryTrie {
    return this.functionTrie;
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
        const languageParser = await loader();
        this.languageParsers.set(lang, languageParser);
        console.log(`${lang} parser loaded successfully.`);
      } catch (error) {
        console.error(`Failed to load ${lang} parser:`, error);
      }
    }
	}

	private async parseFile(graph: KnowledgeGraph, filePath: string, content: string): Promise<void> {
    const language = this.detectLanguage(filePath);
    const langParser = this.languageParsers.get(language);

    if (!langParser || !this.parser) {
      console.warn(`No parser available for language: ${language}. Skipping file: ${filePath}`);
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

    for (const [queryName, queryString] of Object.entries(queries)) {
      const query = langParser.query(queryString as string);
      const matches = query.matches(tree.rootNode);

      for (const match of matches) {
        for (const capture of match.captures) {
          const node = capture.node;
          const definition = this.extractDefinition(node, queryName, filePath);
          if (definition) {
            definitions.push(definition);
          }
        }
      }
    }

    await this.addDefinitionsToGraph(graph, filePath, definitions);
	}

  private extractDefinition(node: Parser.SyntaxNode, queryName: string, filePath: string): ParsedDefinition | null {
    const nameNode = node.childForFieldName('name');
    const name = nameNode ? nameNode.text : 'anonymous';

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
      case 'arrowFunctions': return 'function';
      case 'imports':
      case 'from_imports': return 'import';
      case 'interfaces': return 'interface';
      case 'types': return 'type';
      case 'decorators': return 'decorator';
      default: return 'variable';
    }
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
      case 'javascript':
        return TYPESCRIPT_QUERIES;
      case 'python':
        return PYTHON_QUERIES;
      case 'java':
        return JAVA_QUERIES;
      default:
        return null;
    }
  }

	private async parseGenericFile(graph: KnowledgeGraph, filePath: string, _content: string): Promise<void> {
		const fileNode: GraphNode = {
			id: generateId('file', filePath),
			label: 'File' as NodeLabel,
			properties: {
				name: pathUtils.getFileName(filePath),
				path: filePath,
				size: _content.length,
				language: this.detectLanguage(filePath)
			}
		};

		graph.addNode(fileNode);
	}

	private async addDefinitionsToGraph(
		graph: KnowledgeGraph, 
		filePath: string, 
		definitions: ParsedDefinition[]
	): Promise<void> {
		const fileNode: GraphNode = { 
			id: generateId('file', filePath),
			label: 'File' as NodeLabel,
			properties: {
				name: pathUtils.getFileName(filePath),
				path: filePath,
				language: this.detectLanguage(filePath)
			}
		};

		graph.addNode(fileNode);

		for (const def of definitions) {
			const nodeId = generateId(def.type, `${filePath}:${def.name}`);

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
				id: generateId('defines', `${fileNode.id}:${node.id}`),
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
				for (const extend of def.extends) {
					const extendsRelationship: GraphRelationship = { 
						id: generateId('extends', `${node.id}:${extend}`),
						type: 'EXTENDS' as RelationshipType,
						source: node.id,
						target: generateId('class', extend),
						properties: {}
					};

					graph.addRelationship(extendsRelationship);
				}
			}

			if (def.implements && def.implements.length > 0) {
				for (const interfaceName of def.implements) {
					const implementsRelationship: GraphRelationship = {
						id: generateId('implements', `${node.id}:${interfaceName}`),
						type: 'IMPLEMENTS' as RelationshipType,
						source: node.id,
						target: generateId('interface', interfaceName),
						properties: {}
					};

					graph.addRelationship(implementsRelationship);
				}
			}

			if (def.importPath) {
				const importRelationship: GraphRelationship = { 
					id: generateId('imports', `${node.id}:${def.importPath}`),
					type: 'IMPORTS' as RelationshipType,
					source: node.id, 
					target: generateId('file', def.importPath),
					properties: { 
						importPath: def.importPath 
					}
				};
				graph.addRelationship(importRelationship);
			}

			if (def.parentClass) {			  
				const parentRelationship: GraphRelationship = {
					id: generateId('belongs_to', `${node.id}:${def.parentClass}`),
					type: 'BELONGS_TO' as RelationshipType,
					source: node.id,
					target: generateId('class', `${filePath}:${def.parentClass}`), 
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

	public reset(): void {
		this.processedFiles.clear();
		this.duplicateDetector.clear();
		this.memoryManager.clearCache();
	}
}