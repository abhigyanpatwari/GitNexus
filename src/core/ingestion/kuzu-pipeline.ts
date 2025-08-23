import { KuzuKnowledgeGraph } from '../graph/kuzu-knowledge-graph';
import type { KuzuKnowledgeGraphInterface } from '../graph/types';
import { StructureProcessor } from './structure-processor';
import { ParallelParsingProcessor } from './parallel-parsing-processor';
import { ImportProcessor } from './import-processor';
import { CallProcessor } from './call-processor';


export interface KuzuPipelineInput {
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

export interface KuzuPipelineProgress {
  phase: 'initialization' | 'structure' | 'parsing' | 'imports' | 'calls';
  message: string;
  progress: number;
  timestamp: number;
}

/**
 * KuzuDB Pipeline - Direct Database Integration
 * 
 * Processes code and directly inserts nodes and relationships into KuzuDB,
 * eliminating the need for JSON storage and conversion steps.
 */
export class KuzuGraphPipeline {
  private structureProcessor: StructureProcessor;
  private parsingProcessor: ParallelParsingProcessor;
  private importProcessor: ImportProcessor;
  private callProcessor!: CallProcessor;
  private progressCallback?: (progress: KuzuPipelineProgress) => void;

  constructor() {
    this.structureProcessor = new StructureProcessor();
    this.parsingProcessor = new ParallelParsingProcessor();
    this.importProcessor = new ImportProcessor();
  }

  /**
   * Set progress callback
   */
  public setProgressCallback(callback: (progress: KuzuPipelineProgress) => void): void {
    this.progressCallback = callback;
  }

  /**
   * Update progress
   */
  private updateProgress(phase: KuzuPipelineProgress['phase'], message: string, progress: number): void {
    if (this.progressCallback) {
      this.progressCallback({
        phase,
        message,
        progress: Math.min(progress, 100),
        timestamp: Date.now()
      });
    }
  }

  /**
   * Run the KuzuDB pipeline with direct database integration
   */
  public async run(input: KuzuPipelineInput): Promise<KuzuKnowledgeGraphInterface> {
    const { projectRoot, projectName, filePaths, fileContents, options } = input;
    
    // Initialize KuzuDB graph
    const graph = new KuzuKnowledgeGraph();
    const startTime = performance.now();

    console.log(`🚀 Starting KuzuDB pipeline for project: ${projectName}`);
    console.log(`📊 Processing ${filePaths.length} files with direct KuzuDB integration`);

    try {
      // Initialize KuzuDB
      console.log('🔧 Initializing KuzuDB...');
      this.updateProgress('initialization', 'Initializing KuzuDB...', 0);
      
      await graph.initialize();
      
      this.updateProgress('initialization', 'KuzuDB initialized successfully', 100);

      // Pass 1: Structure Analysis (Sequential - lightweight)
      console.log('📁 Pass 1: Analyzing project structure (direct to KuzuDB)...');
      this.updateProgress('structure', 'Analyzing project structure...', 0);
      
      await this.structureProcessor.process(graph, {
        projectRoot,
        projectName,
        filePaths
      });
      
      this.updateProgress('structure', 'Project structure analysis complete', 100);
      
      // Pass 2: Code Parsing and Definition Extraction (Parallel - CPU intensive)
      console.log('🔍 Pass 2: Parsing code and extracting definitions (direct to KuzuDB)...');
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
      console.log('🔗 Pass 3: Resolving imports and building dependency map (direct to KuzuDB)...');
      this.updateProgress('imports', 'Resolving imports...', 0);
      
      await this.importProcessor.process(graph, astMap, fileContents);
      
      this.updateProgress('imports', 'Import resolution complete', 100);
      
      // Pass 4: Call Resolution (Sequential - depends on import map)
      console.log('📞 Pass 4: Resolving function calls with 3-stage strategy (direct to KuzuDB)...');
      this.updateProgress('calls', 'Resolving function calls...', 0);
      
      const importMap = this.importProcessor.getImportMap();
      await this.callProcessor.process(graph, astMap, importMap);
      
      this.updateProgress('calls', 'Call resolution complete', 100);

      const endTime = performance.now();
      const totalDuration = endTime - startTime;

      console.log(`✅ KuzuDB pipeline complete in ${totalDuration.toFixed(2)}ms`);
      console.log(`📊 Graph contains ${graph.getNodeCount()} nodes and ${graph.getRelationshipCount()} relationships in KuzuDB`);

      // Log performance statistics
      this.logPerformanceStats(graph, totalDuration);

      // Log worker pool statistics if available
      const workerStats = this.parsingProcessor.getWorkerPoolStats();
      if (workerStats) {
        console.log('🔧 Worker Pool Statistics:', workerStats);
      }

      // Populate cache for KnowledgeGraph interface compatibility
      try {
        if ('populateCache' in graph && typeof graph.populateCache === 'function') {
          await graph.populateCache();
        }
      } catch (error) {
        console.error('❌ Failed to populate cache:', error);
      }

      // 🔍 DEBUG: Inspect KuzuDB schema first
      console.log('🔍 Running schema inspection...');
      try {
        const kuzuGraph = graph as KuzuKnowledgeGraph & KuzuKnowledgeGraphInterface;
        if ('debugRelationshipSchema' in kuzuGraph) {
          await (kuzuGraph as KuzuKnowledgeGraph & { debugRelationshipSchema: () => Promise<void> }).debugRelationshipSchema();
          console.log('🔍 Schema inspection completed');
        }
      } catch (error) {
        console.error('🔍 Schema inspection failed:', error);
      }

      // 🧪 TEST: Run relationship query test
      console.log('🧪 Running relationship query test...');
      try {
        const kuzuGraph = graph as KuzuKnowledgeGraph & KuzuKnowledgeGraphInterface;
        if ('testRelationshipQuery' in kuzuGraph) {
          await (kuzuGraph as KuzuKnowledgeGraph & { testRelationshipQuery: (limit: number) => Promise<void> }).testRelationshipQuery(10);
          console.log('🧪 Relationship query test completed');
        } else {
          console.log('🧪 Test method not available on this graph instance');
        }
      } catch (error) {
        console.error('🧪 Relationship query test failed:', error);
      }

      return graph;
      
    } catch (error) {
      console.error('❌ Error in KuzuDB pipeline:', error);
      throw error;
    } finally {
      // Cleanup worker pools
      await this.cleanup();
    }
  }

  /**
   * Log performance statistics
   */
  private logPerformanceStats(graph: KuzuKnowledgeGraphInterface, totalDuration: number): void {
    const totalNodes = graph.getNodeCount();
    const totalRelationships = graph.getRelationshipCount();
    const processingRate = totalDuration > 0 ? (totalNodes + totalRelationships) / (totalDuration / 1000) : 0;
    
    console.log('⚡ KuzuDB Performance Metrics:');
    console.log(`  Total processing time: ${totalDuration.toFixed(2)}ms`);
    console.log(`  Processing rate: ${processingRate.toFixed(2)} entities/second`);
    console.log(`  Average time per node: ${totalNodes > 0 ? (totalDuration / totalNodes).toFixed(2) : 0}ms`);
    console.log(`  Average time per relationship: ${totalRelationships > 0 ? (totalDuration / totalRelationships).toFixed(2) : 0}ms`);
    console.log(`  Direct KuzuDB integration: No JSON conversion overhead`);
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    try {
      console.log('🧹 Cleaning up KuzuDB pipeline resources...');
      await this.parsingProcessor.cleanup();
      console.log('✅ KuzuDB pipeline cleanup complete');
    } catch (error) {
      console.error('❌ Error during KuzuDB pipeline cleanup:', error);
    }
  }
}
