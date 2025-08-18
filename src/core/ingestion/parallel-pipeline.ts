import { SimpleKnowledgeGraph } from '../graph/graph.js';
import type { KnowledgeGraph } from '../graph/types.ts';
import { StructureProcessor } from './structure-processor.ts';
import { ParallelParsingProcessor } from './parallel-parsing-processor.ts';
import { ImportProcessor } from './import-processor.ts';
import { CallProcessor } from './call-processor.ts';
import { WebWorkerPoolUtils } from '../../lib/web-worker-pool.js';

export interface PipelineInput {
  projectRoot: string;
  projectName: string;
  filePaths: string[];
  fileContents: Map<string, string>;
  options?: {
    directoryFilter?: string;
    fileExtensions?: string;
    useParallelProcessing?: boolean;
    maxWorkers?: number;
  };
}

export interface PipelineProgress {
  phase: 'structure' | 'parsing' | 'imports' | 'calls';
  message: string;
  progress: number;
  timestamp: number;
}

export class ParallelGraphPipeline {
  private structureProcessor: StructureProcessor;
  private parsingProcessor: ParallelParsingProcessor;
  private importProcessor: ImportProcessor;
  private callProcessor!: CallProcessor;
  private progressCallback?: (progress: PipelineProgress) => void;

  constructor() {
    this.structureProcessor = new StructureProcessor();
    this.parsingProcessor = new ParallelParsingProcessor();
    this.importProcessor = new ImportProcessor();
  }

  /**
   * Set progress callback
   */
  public setProgressCallback(callback: (progress: PipelineProgress) => void): void {
    this.progressCallback = callback;
  }

  /**
   * Update progress
   */
  private updateProgress(phase: PipelineProgress['phase'], message: string, progress: number): void {
    if (this.progressCallback) {
      this.progressCallback({
        phase,
        message,
        progress: Math.min(progress, 100),
        timestamp: Date.now()
      });
    }
  }

  public async run(input: PipelineInput): Promise<KnowledgeGraph> {
    const { projectRoot, projectName, filePaths, fileContents, options } = input;
    
    const graph = new SimpleKnowledgeGraph();
    const startTime = performance.now();

    console.log(`🚀 Starting parallel 4-pass ingestion for project: ${projectName}`);
    console.log(`📊 Processing ${filePaths.length} files with ${options?.useParallelProcessing ? 'parallel' : 'sequential'} processing`);

    try {
      // Pass 1: Structure Analysis (Sequential - lightweight)
      console.log('📁 Pass 1: Analyzing project structure...');
      this.updateProgress('structure', 'Analyzing project structure...', 0);
      
      await this.structureProcessor.process(graph, {
        projectRoot,
        projectName,
        filePaths
      });
      
      this.updateProgress('structure', 'Project structure analysis complete', 100);
      
      // Pass 2: Code Parsing and Definition Extraction (Parallel - CPU intensive)
      console.log('🔍 Pass 2: Parsing code and extracting definitions (parallel)...');
      this.updateProgress('parsing', 'Initializing parallel parsing...', 0);
      
      await this.parsingProcessor.process(graph, {
        filePaths,
        fileContents,
        options
      });
      
      this.updateProgress('parsing', 'Parallel parsing complete', 100);
      
      // Get AST map and function registry from parsing processor
      const astMap = this.parsingProcessor.getASTMap();
      const functionTrie = this.parsingProcessor.getFunctionRegistry();
      
      this.callProcessor = new CallProcessor(functionTrie);
      
      // Pass 3: Import Resolution (Sequential - depends on parsing results)
      console.log('🔗 Pass 3: Resolving imports and building dependency map...');
      this.updateProgress('imports', 'Resolving imports...', 0);
      
      await this.importProcessor.process(graph, astMap, fileContents);
      
      this.updateProgress('imports', 'Import resolution complete', 100);
      
      // Pass 4: Call Resolution (Sequential - depends on import map)
      console.log('📞 Pass 4: Resolving function calls with 3-stage strategy...');
      this.updateProgress('calls', 'Resolving function calls...', 0);
      
      const importMap = this.importProcessor.getImportMap();
      await this.callProcessor.process(graph, astMap, importMap);
      
      this.updateProgress('calls', 'Call resolution complete', 100);
      
      const endTime = performance.now();
      const totalDuration = endTime - startTime;
      
      console.log(`✅ Parallel ingestion complete in ${totalDuration.toFixed(2)}ms`);
      console.log(`📊 Graph contains ${graph.nodes.length} nodes and ${graph.relationships.length} relationships`);
      
      // Log performance statistics
      this.logPerformanceStats(graph, totalDuration);
      
      // Log worker pool statistics if available
      const workerStats = this.parsingProcessor.getWorkerPoolStats();
      if (workerStats) {
        console.log('🔧 Worker Pool Statistics:', workerStats);
      }
      
      return graph;
      
    } catch (error) {
      console.error('❌ Error in parallel pipeline:', error);
      throw error;
    } finally {
      // Cleanup worker pools
      await this.cleanup();
    }
  }

  /**
   * Log performance statistics
   */
  private logPerformanceStats(graph: KnowledgeGraph, totalDuration: number): void {
    // Debug: Show graph structure
    const nodesByType = graph.nodes.reduce((acc, node) => {
      acc[node.label] = (acc[node.label] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const relationshipsByType = graph.relationships.reduce((acc, rel) => {
      acc[rel.type] = (acc[rel.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log('📊 Graph Statistics:');
    console.log('Nodes by type:', nodesByType);
    console.log('Relationships by type:', relationshipsByType);
    
    // Debug: Find isolated nodes (nodes with no relationships)
    const connectedNodeIds = new Set<string>();
    graph.relationships.forEach(rel => {
      connectedNodeIds.add(rel.source);
      connectedNodeIds.add(rel.target);
    });
    
    const isolatedNodes = graph.nodes.filter(node => !connectedNodeIds.has(node.id));
    if (isolatedNodes.length > 0) {
      console.warn(`⚠️ Found ${isolatedNodes.length} isolated nodes:`);
      const isolatedByType = isolatedNodes.reduce((acc, node) => {
        acc[node.label] = (acc[node.label] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log('Isolated nodes by type:', isolatedByType);
    }

    // Performance metrics
    const totalNodes = graph.nodes.length;
    const totalRelationships = graph.relationships.length;
    const processingRate = totalDuration > 0 ? (totalNodes + totalRelationships) / (totalDuration / 1000) : 0;
    
    console.log('⚡ Performance Metrics:');
    console.log(`  Total processing time: ${totalDuration.toFixed(2)}ms`);
    console.log(`  Processing rate: ${processingRate.toFixed(2)} entities/second`);
    console.log(`  Average time per node: ${totalNodes > 0 ? (totalDuration / totalNodes).toFixed(2) : 0}ms`);
    console.log(`  Average time per relationship: ${totalRelationships > 0 ? (totalDuration / totalRelationships).toFixed(2) : 0}ms`);
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    try {
      console.log('🧹 Cleaning up parallel pipeline resources...');
      
      // Shutdown parsing processor (which includes worker pool)
      await this.parsingProcessor.shutdown();
      
      console.log('✅ Parallel pipeline cleanup complete');
    } catch (error) {
      console.warn('⚠️ Error during cleanup:', error);
    }
  }

  /**
   * Get worker pool statistics
   */
  public getWorkerPoolStats() {
    return this.parsingProcessor.getWorkerPoolStats();
  }

  /**
   * Check if parallel processing is supported
   */
  public static isParallelProcessingSupported(): boolean {
    return WebWorkerPoolUtils.isSupported();
  }

  /**
   * Get optimal worker count for current system
   */
  public static getOptimalWorkerCount(): number {
    return WebWorkerPoolUtils.getOptimalWorkerCount('cpu');
  }

  /**
   * Get hardware concurrency
   */
  public static getHardwareConcurrency(): number {
    return WebWorkerPoolUtils.getHardwareConcurrency();
  }
}
