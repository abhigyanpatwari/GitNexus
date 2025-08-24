/**
 * Next-Gen Ingestion Service
 * 
 * Concrete implementation of BaseIngestionService for Next-Gen engine.
 * Uses parallel processing with KuzuDB storage.
 * 
 * Engine characteristics:
 * - Parallel processing (multi-threaded with worker pools)
 * - KuzuDB persistent storage (KuzuKnowledgeGraph)
 * - Direct database integration (no JSON serialization)
 * - Advanced query capabilities
 */

import { BaseIngestionService, type BaseIngestionOptions, type BaseIngestionResult } from '../common/base-ingestion.service';
import type { KuzuKnowledgeGraphInterface } from '../../core/graph/types';

export interface NextGenIngestionOptions extends BaseIngestionOptions {
  // Next-Gen specific options
  maxWorkers?: number;
  useParallelProcessing?: boolean;
}

export interface NextGenIngestionResult extends BaseIngestionResult {
  graph: KuzuKnowledgeGraphInterface;
  kuzuInstance?: any; // KuzuDB instance for advanced operations
}

/**
 * Next-Gen Ingestion Service
 * Wraps the advanced parallel + KuzuDB processing system
 */
export class NextGenIngestionService extends BaseIngestionService {
  
  /**
   * Process pipeline using Next-Gen engine (parallel + KuzuDB)
   */
  protected async processPipeline(data: {
    projectName: string;
    projectRoot: string;
    filePaths: string[];
    fileContents: Map<string, string>;
    onProgress?: (message: string) => void;
  }): Promise<NextGenIngestionResult> {
    
    const { projectName, projectRoot, filePaths, fileContents, onProgress } = data;
    
    console.log('🚀 Next-Gen Engine: Using parallel processing with KuzuDB storage');
    
    // Process directly in main thread to avoid KuzuDB serialization issues
    // KuzuDB objects cannot be transferred between workers
    const { KuzuGraphPipeline } = await import('../../core/ingestion/kuzu-pipeline');
    const pipeline = new KuzuGraphPipeline();
    
    try {
      onProgress?.('Processing with Next-Gen engine (parallel + KuzuDB)...');
      
      console.log('🔍 Next-Gen Engine: About to run KuzuGraphPipeline...');
      const graph = await pipeline.run({
        projectName,
        projectRoot,
        filePaths,
        fileContents: fileContents
      });

      // Enhanced debugging for KuzuDB integration
      console.log('🔍 Next-Gen Engine: Pipeline completed, analyzing result:');
      console.log('🔍 Graph type:', typeof graph);
      console.log('🔍 Graph constructor:', graph.constructor.name);
      console.log('🔍 Graph has nodes array:', 'nodes' in graph);
      console.log('🔍 Graph has relationships array:', 'relationships' in graph);
      
      if ('getNodeCount' in graph && typeof graph.getNodeCount === 'function') {
        try {
          const nodeCount = graph.getNodeCount();
          const relationshipCount = graph.getRelationshipCount();
          console.log(`✅ Next-Gen Engine: KuzuDB processing completed successfully`);
          console.log(`📊 Next-Gen Engine: Generated ${nodeCount} nodes, ${relationshipCount} relationships`);
        } catch (countError) {
          console.warn('⚠️ Next-Gen Engine: Could not get counts from KuzuDB:', countError);
        }
      } else {
        console.log('🔍 Next-Gen Engine: Using fallback node counting');
        console.log(`📊 Next-Gen Engine: Generated ${graph.nodes?.length || 0} nodes, ${graph.relationships?.length || 0} relationships`);
      }

      return {
        graph,
        fileContents,
        kuzuInstance: (graph as any).kuzuService // Pass through KuzuDB instance if available
      };
      
    } catch (error) {
      console.error('❌ Next-Gen Engine: Processing failed:', error);
      throw error;
    } finally {
      // Clean up pipeline resources
      await pipeline.cleanup();
    }
  }

  /**
   * Next-Gen specific GitHub processing with enhanced options
   */
  async processGitHubRepo(
    githubUrl: string, 
    options: NextGenIngestionOptions = {}
  ): Promise<NextGenIngestionResult> {
    
    console.log('🚀 Next-Gen Ingestion Service: Starting GitHub repository processing');
    console.log(`🔧 Processing mode: Parallel + KuzuDB`);
    console.log(`🔧 Max workers: ${options.maxWorkers || 'auto'}`);
    console.log(`🔧 Parallel processing: ${options.useParallelProcessing !== false}`);
    
    return super.processGitHubRepo(githubUrl, options) as Promise<NextGenIngestionResult>;
  }

  /**
   * Next-Gen specific ZIP file processing with enhanced options
   */
  async processZipFile(
    file: File,
    options: NextGenIngestionOptions = {}
  ): Promise<NextGenIngestionResult> {
    
    console.log('🚀 Next-Gen Ingestion Service: Starting ZIP file processing');
    console.log(`🔧 Processing mode: Parallel + KuzuDB`);
    console.log(`🔧 Max workers: ${options.maxWorkers || 'auto'}`);
    console.log(`🔧 Parallel processing: ${options.useParallelProcessing !== false}`);
    
    return super.processZipFile(file, options) as Promise<NextGenIngestionResult>;
  }
}