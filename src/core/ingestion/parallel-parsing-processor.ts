import { GraphNode, GraphRelationship, NodeLabel } from '../graph/types.js';
import { MemoryManager } from '../../services/memory-manager.js';
import { KnowledgeGraph, GraphProcessor } from '../graph/graph.js';
import {
  OptimizedSet,
  DuplicateDetector
} from '../../lib/shared-utils.js';
import { IGNORE_PATTERNS } from '../../config/language-config.js';
import { WebWorkerPool, WebWorkerPoolUtils } from '../../lib/web-worker-pool.js';
import { FunctionRegistryTrie, FunctionDefinition } from '../graph/trie.js';
import { generateId } from '../../lib/utils.ts';

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
  tree: any;
}

export interface ParallelParsingResult {
  filePath: string;
  definitions: ParsedDefinition[];
  ast: ParsedAST;
  success: boolean;
  error?: string;
}



export class ParallelParsingProcessor implements GraphProcessor<ParsingInput> {
	private memoryManager: MemoryManager;
	private duplicateDetector = new DuplicateDetector<string>((item: string) => item);
	private processedFiles = new OptimizedSet<string>();
  private astMap: Map<string, ParsedAST> = new Map();
  private functionTrie: FunctionRegistryTrie = new FunctionRegistryTrie();
  private workerPool: WebWorkerPool;
  private isInitialized: boolean = false;

	constructor() {
		this.memoryManager = MemoryManager.getInstance();
		this.workerPool = WebWorkerPoolUtils.createCPUPool({
			workerScript: '/workers/tree-sitter-worker.js',
			name: 'ParallelParsingPool',
			timeout: 60000 // 60 seconds for parsing
		});
	}

  public getASTMap(): Map<string, ParsedAST> {
    return this.astMap;
  }

  public getFunctionRegistry(): FunctionRegistryTrie {
    return this.functionTrie;
  }

	/**
	 * Initialize the worker pool
	 */
	private async initializeWorkerPool(): Promise<void> {
		if (this.isInitialized) return;

		try {
			console.log('ParallelParsingProcessor: Initializing worker pool...');
			
			// Check if Web Workers are supported
			if (!WebWorkerPoolUtils.isSupported()) {
				throw new Error('Web Workers are not supported in this environment');
			}

			// Set up worker pool event listeners
			this.workerPool.on('workerCreated', (data: unknown) => {
				const { workerId, totalWorkers } = data as { workerId: number, totalWorkers: number };
				console.log(`ParallelParsingProcessor: Worker ${workerId} created (${totalWorkers} total)`);
			});

			this.workerPool.on('workerError', (data: unknown) => {
				const { workerId, error } = data as { workerId: number, error: string };
				console.warn(`ParallelParsingProcessor: Worker ${workerId} error:`, error);
			});

			this.workerPool.on('shutdown', () => {
				console.log('ParallelParsingProcessor: Worker pool shutdown');
			});

			this.isInitialized = true;
			console.log('ParallelParsingProcessor: Worker pool initialized successfully');
		} catch (error) {
			console.error('ParallelParsingProcessor: Failed to initialize worker pool:', error);
			throw error;
		}
	}

	public async process(graph: KnowledgeGraph, input: ParsingInput): Promise<void> {
		const { filePaths, fileContents, options } = input;

		console.log(`ParallelParsingProcessor: Processing ${filePaths.length} total paths with worker pool`);

		const memoryStats = this.memoryManager.getStats();
		console.log(`Memory status: ${memoryStats.usedMemoryMB}MB used, ${memoryStats.fileCount} files cached`);

		// Initialize worker pool
		await this.initializeWorkerPool();

		const filteredFiles = this.applyFiltering(filePaths, fileContents, options);
		
		console.log(`ParallelParsingProcessor: After filtering: ${filteredFiles.length} files to parse`);

		const sourceFiles = filteredFiles.filter((path: string) => this.isSourceFile(path));
		const configFiles = filteredFiles.filter((path: string) => this.isConfigFile(path));
		const allProcessableFiles = [...sourceFiles, ...configFiles];
		
		console.log(`ParallelParsingProcessor: Found ${sourceFiles.length} source files and ${configFiles.length} config files`);

		try {
			// Process files in parallel using worker pool
			const results = await this.processFilesInParallel(allProcessableFiles, fileContents);
			
			// Process results and build graph
			await this.processResults(results, graph);
			
			console.log(`ParallelParsingProcessor: Successfully processed ${this.processedFiles.size} files`);
		} catch (error) {
			console.error('ParallelParsingProcessor: Error during parallel processing:', error);
			throw error;
		}
	}

	/**
	 * Process files in parallel using worker pool
	 */
	private async processFilesInParallel(
		filePaths: string[], 
		fileContents: Map<string, string>
	): Promise<ParallelParsingResult[]> {
		const startTime = performance.now();
		
		// Prepare tasks for worker pool
		const tasks = filePaths.map(filePath => ({
			filePath,
			content: fileContents.get(filePath) || ''
		}));

		console.log(`ParallelParsingProcessor: Starting parallel processing of ${tasks.length} files`);

		try {
			// Process with progress tracking
			const results = await this.workerPool.executeWithProgress<any, ParallelParsingResult>(
				tasks,
				(completed, total) => {
					const progress = ((completed / total) * 100).toFixed(1);
					console.log(`ParallelParsingProcessor: Progress: ${progress}% (${completed}/${total})`);
				}
			);

			const endTime = performance.now();
			const duration = endTime - startTime;
			
			console.log(`ParallelParsingProcessor: Parallel processing completed in ${duration.toFixed(2)}ms`);
			console.log(`ParallelParsingProcessor: Average time per file: ${(duration / tasks.length).toFixed(2)}ms`);

			// Log worker pool statistics
			const stats = this.workerPool.getStats();
			console.log('ParallelParsingProcessor: Worker pool stats:', stats);

			return results;
		} catch (error) {
			console.error('ParallelParsingProcessor: Error in parallel processing:', error);
			throw error;
		}
	}

	/**
	 * Process parsing results and build graph
	 */
	private async processResults(results: ParallelParsingResult[], graph: KnowledgeGraph): Promise<void> {
		console.log(`ParallelParsingProcessor: Processing ${results.length} parsing results`);

		let successfulFiles = 0;
		let failedFiles = 0;
		let totalDefinitions = 0;

		for (const result of results) {
			if (result.success) {
				successfulFiles++;
				
				// Store AST
				if (result.ast) {
					this.astMap.set(result.filePath, result.ast);
				}

				// Process definitions
				if (result.definitions && result.definitions.length > 0) {
					await this.processDefinitions(result.filePath, result.definitions, graph);
					totalDefinitions += result.definitions.length;
				}

				this.processedFiles.add(result.filePath);
			} else {
				failedFiles++;
				console.warn(`ParallelParsingProcessor: Failed to parse ${result.filePath}: ${result.error}`);
			}
		}

		console.log(`ParallelParsingProcessor: Processing complete - ${successfulFiles} successful, ${failedFiles} failed`);
		console.log(`ParallelParsingProcessor: Total definitions extracted: ${totalDefinitions}`);
	}

	/**
	 * Process definitions and add to graph
	 */
	private async processDefinitions(
		filePath: string, 
		definitions: ParsedDefinition[], 
		graph: KnowledgeGraph
	): Promise<void> {
		for (const definition of definitions) {
			try {
				await this.addDefinitionToGraph(filePath, definition, graph);
			} catch (error) {
				console.warn(`ParallelParsingProcessor: Error processing definition ${definition.name}:`, error);
			}
		}
	}

	/**
	 * Add a definition to the graph
	 */
	private async addDefinitionToGraph(
		filePath: string, 
		definition: ParsedDefinition, 
		graph: KnowledgeGraph
	): Promise<void> {
		const nodeId = generateId(definition.type);
		
		if (this.duplicateDetector.isDuplicate(nodeId)) {
			return;
		}

		// Create graph node
		const node: GraphNode = {
			id: nodeId,
			label: this.mapDefinitionTypeToNodeLabel(definition.type),
			properties: {
				name: definition.name,
				filePath,
				startLine: definition.startLine,
				endLine: definition.endLine,
				type: definition.type,
				parameters: definition.parameters,
				returnType: definition.returnType,
				accessibility: definition.accessibility,
				isStatic: definition.isStatic,
				isAsync: definition.isAsync,
				parentClass: definition.parentClass,
				decorators: definition.decorators?.join(', '),
				extends: definition.extends?.join(', '),
				implements: definition.implements?.join(', '),
				importPath: definition.importPath,
				exportType: definition.exportType,
				docstring: definition.docstring
			}
		};

		graph.addNode(node);

		// Add to function registry if applicable
		if (['function', 'method', 'class', 'interface', 'enum'].includes(definition.type)) {
			const functionDef: FunctionDefinition = {
				nodeId: nodeId,
        qualifiedName: `${filePath}:${definition.name}`,
        filePath,
        functionName: definition.name,
        type: definition.type as 'function' | 'method' | 'class' | 'interface' | 'enum',
			};
			this.functionTrie.addDefinition(functionDef);
		}

		// Add CONTAINS relationship from file to definition
		const fileNodeId = generateId('file');
		const containsRel: GraphRelationship = {
			id: generateId('contains'),
			type: 'CONTAINS',
			source: fileNodeId,
			target: nodeId,
			properties: {
				filePath,
				definitionType: definition.type
			}
		};

		graph.addRelationship(containsRel);
	}

	/**
	 * Map definition type to node label
	 */
	private mapDefinitionTypeToNodeLabel(type: string): NodeLabel {
		switch (type) {
			case 'function':
				return 'Function';
			case 'class':
				return 'Class';
			case 'method':
				return 'Method';
			case 'variable':
				return 'Variable';
			case 'import':
				return 'Import';
			case 'interface':
				return 'Interface';
			case 'type':
				return 'Type';
			case 'decorator':
				return 'Decorator';
			default:
				return 'CodeElement';
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

	/**
	 * Shutdown the worker pool
	 */
	public async shutdown(): Promise<void> {
		if (this.workerPool) {
			await this.workerPool.shutdown();
		}
	}

	/**
	 * Get worker pool statistics
	 */
	public getWorkerPoolStats() {
		return this.workerPool ? this.workerPool.getStats() : null;
	}
}
