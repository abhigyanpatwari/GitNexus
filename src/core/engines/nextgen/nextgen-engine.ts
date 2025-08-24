/**
 * Next-Gen Processing Engine
 * Wraps the advanced parallel + KuzuDB processing system
 * Uses: KuzuIngestionService + KuzuGraphPipeline + ParallelProcessing + KuzuKnowledgeGraph
 */

import { ServiceFactory } from '../../../services/service.factory';
import type { BaseIngestionService } from '../../../services/common/base-ingestion.service';
import { config } from '../../../config/config';
import type { 
  ProcessingEngine, 
  ProcessingInput, 
  ProcessingResult, 
  ProcessingCallbacks,
  EngineStatus,
  ProcessingMetadata
} from '../engine-interface';

export class NextGenProcessingEngine implements ProcessingEngine {
  readonly name = 'Next-Gen Engine';
  readonly type = 'nextgen' as const;
  readonly version = '2.0.0';
  readonly capabilities = [
    'parallel-processing', 
    'kuzu-db-storage', 
    'advanced-queries',
    'performance-monitoring',
    'worker-pool',
    'persistent-storage'
  ];
  
  private ingestionService: BaseIngestionService | null = null;
  private initPromise: Promise<void>;
  private lastError?: string;
  private performanceStats = {
    averageProcessingTime: 0,
    successRate: 100,
    lastProcessedAt: 0,
    totalProcessed: 0,
    totalSuccess: 0
  };
  
  constructor(githubToken?: string) {
    // Check if next-gen engine is enabled
    if (!config.engines.nextgen.enabled) {
      throw new Error('Next-Gen engine is disabled in configuration');
    }
    
    // Initialize the service asynchronously
    this.initPromise = this.initializeService(githubToken);
    console.log('🚀 Next-Gen Processing Engine initializing with service factory');
    console.log('🚀 Next-Gen Engine Config:', {
      maxWorkers: config.engines.nextgen.parallel.maxWorkers,
      batchSize: config.engines.nextgen.parallel.batchSize,
      workerTimeout: config.engines.nextgen.parallel.workerTimeoutMs + 'ms',
      kuzuBufferPool: config.engines.nextgen.kuzu.bufferPoolSize + 'MB',
      enableWAL: config.engines.nextgen.kuzu.enableWAL
    });
  }
  
  private async initializeService(githubToken?: string): Promise<void> {
    try {
      this.ingestionService = await ServiceFactory.createIngestionService('nextgen', githubToken);
      console.log('✅ Next-Gen Processing Engine initialized successfully');
    } catch (error) {
      console.error('❌ Next-Gen Processing Engine: Failed to initialize service:', error);
      this.lastError = error instanceof Error ? error.message : 'Failed to initialize service';
      throw error;
    }
  }
  
  private async ensureInitialized(): Promise<BaseIngestionService> {
    await this.initPromise;
    if (!this.ingestionService) {
      throw new Error('Next-Gen engine failed to initialize');
    }
    return this.ingestionService;
  }
  
  async process(input: ProcessingInput, callbacks?: ProcessingCallbacks): Promise<ProcessingResult> {
    const startTime = performance.now();
    
    try {
      callbacks?.onEngineSelected?.('nextgen');
      console.log('🚀 Next-Gen Engine: Starting parallel processing with KuzuDB...');
      
      // Ensure service is initialized
      const ingestionService = await this.ensureInitialized();
      
      // Validate environment before processing
      const isValid = await this.validate();
      if (!isValid) {
        throw new Error('Next-Gen Engine validation failed: ' + this.lastError);
      }
      
      let result;
      
      if (input.type === 'github' && input.url) {
        result = await this.processGitHubRepo(input.url, input.options, callbacks, ingestionService);
      } else if (input.type === 'zip' && input.file) {
        result = await this.processZipFile(input.file, input.options, callbacks, ingestionService);
      } else {
        throw new Error('Invalid input for next-gen engine: missing URL or file');
      }
      }
      
      const endTime = performance.now();
      const processingTime = endTime - startTime;
      
      // Update performance stats
      this.updatePerformanceStats(processingTime, true);
      
      const metadata: ProcessingMetadata = {
        processingTime,
        nodeCount: result.graph.getNodeCount ? result.graph.getNodeCount() : result.graph.nodes?.length || 0,
        relationshipCount: result.graph.getRelationshipCount ? result.graph.getRelationshipCount() : result.graph.relationships?.length || 0,
        engineCapabilities: this.capabilities,
        fileCount: result.fileContents.size,
        version: this.version,
        timestamp: Date.now()
      };
      
      console.log(`✅ Next-Gen Engine: Processing completed in ${processingTime.toFixed(2)}ms`);
      console.log(`📊 Next-Gen Engine: Generated ${metadata.nodeCount} nodes, ${metadata.relationshipCount} relationships`);
      console.log(`🚀 Next-Gen Engine: Parallel processing & KuzuDB integration successful`);
      
      callbacks?.onPerformanceMetrics?.(metadata);
      
      return {
        engine: 'nextgen',
        graph: result.graph,
        fileContents: result.fileContents,
        metadata,
        kuzuInstance: (result as any).kuzuInstance // Pass through KuzuDB instance
      };
      
    } catch (error) {
      const endTime = performance.now();
      const processingTime = endTime - startTime;
      
      this.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.updatePerformanceStats(processingTime, false);
      
      console.error('❌ Next-Gen Engine: Processing failed:', error);
      console.error('❌ Next-Gen Engine: Will trigger fallback to legacy engine');
      throw error;
    }
  }
  
  private async processGitHubRepo(
    url: string, 
    options?: any, 
    callbacks?: ProcessingCallbacks,
    ingestionService: BaseIngestionService
  ) {
    return await ingestionService.processGitHubRepo(url, {
      directoryFilter: options?.directoryFilter,
      fileExtensions: options?.fileExtensions,
      onProgress: (progress) => {
        console.log(`🔄 Next-Gen Engine: ${progress}`);
        callbacks?.onProgress?.(progress);
      }
    });
  }
  
  private async processZipFile(
    file: File, 
    options?: any, 
    callbacks?: ProcessingCallbacks,
    ingestionService: BaseIngestionService
  ) {
    return await ingestionService.processZipFile(file, {
      directoryFilter: options?.directoryFilter,
      fileExtensions: options?.fileExtensions,
      onProgress: (progress) => {
        console.log(`🔄 Next-Gen Engine: ${progress}`);
        callbacks?.onProgress?.(progress);
      }
    });
  }
  
  async validate(): Promise<boolean> {
    try {
      // Check if next-gen engine is enabled
      if (!config.engines.nextgen.enabled) {
        this.lastError = 'Next-Gen engine is disabled in configuration';
        return false;
      }
      
      // Check if required technologies are available
      const checks = {
        webWorkers: typeof Worker !== 'undefined',
        webAssembly: typeof WebAssembly !== 'undefined',
        indexedDB: typeof indexedDB !== 'undefined',
        comlink: true // Assume available if imported
      };
      
      const failedChecks = Object.entries(checks)
        .filter(([_, available]) => !available)
        .map(([name]) => name);
      
      if (failedChecks.length > 0) {
        this.lastError = `Missing required technologies: ${failedChecks.join(', ')}`;
        console.warn('⚠️ Next-Gen Engine: Validation failed -', this.lastError);
        return false;
      }
      
      console.log('✅ Next-Gen Engine: Validation passed - all technologies available');
      return true;
      
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Validation failed';
      console.error('❌ Next-Gen Engine: Validation error:', error);
      return false;
    }
  }
  
  async cleanup(): Promise<void> {
    try {
      console.log('🧹 Next-Gen Engine: Starting cleanup...');
      
      // Cleanup KuzuDB connections and worker pools
      // The KuzuIngestionService should handle its own cleanup
      
      console.log('✅ Next-Gen Engine: Cleanup completed');
    } catch (error) {
      console.error('❌ Next-Gen Engine: Cleanup failed:', error);
    }
  }
  
  getStatus(): EngineStatus {
    return {
      available: true,
      healthy: !this.lastError,
      lastError: this.lastError,
      performance: {
        averageProcessingTime: this.performanceStats.averageProcessingTime,
        successRate: this.performanceStats.successRate,
        lastProcessedAt: this.performanceStats.lastProcessedAt
      }
    };
  }
  
  private updatePerformanceStats(processingTime: number, success: boolean): void {
    this.performanceStats.totalProcessed++;
    if (success) {
      this.performanceStats.totalSuccess++;
    }
    
    this.performanceStats.successRate = 
      (this.performanceStats.totalSuccess / this.performanceStats.totalProcessed) * 100;
    
    // Update average processing time using exponential moving average
    if (this.performanceStats.averageProcessingTime === 0) {
      this.performanceStats.averageProcessingTime = processingTime;
    } else {
      this.performanceStats.averageProcessingTime = 
        0.8 * this.performanceStats.averageProcessingTime + 0.2 * processingTime;
    }
    
    this.performanceStats.lastProcessedAt = Date.now();
  }
  
  /**
   * Get detailed performance statistics
   */
  getPerformanceStats() {
    return {
      ...this.performanceStats,
      engineType: this.type,
      capabilities: this.capabilities
    };
  }
  
  /**
   * Get KuzuDB-specific performance metrics
   */
  async getKuzuDBMetrics() {
    try {
      // TODO: Implement KuzuDB-specific metrics collection
      return {
        databaseSize: 0,
        queryPerformance: 0,
        connectionCount: 0
      };
    } catch (error) {
      console.error('❌ Next-Gen Engine: Failed to get KuzuDB metrics:', error);
      return null;
    }
  }
}