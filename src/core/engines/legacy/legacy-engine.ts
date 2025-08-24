/**
 * Legacy Processing Engine
 * Wraps the current sequential + in-memory processing system
 * Uses: IngestionService + GraphPipeline + SimpleKnowledgeGraph
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

export class LegacyProcessingEngine implements ProcessingEngine {
  readonly name = 'Legacy Engine';
  readonly type = 'legacy' as const;
  readonly version = '1.0.0';
  readonly capabilities = [
    'sequential-processing', 
    'in-memory-storage', 
    'basic-queries',
    'stable-performance'
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
    // Check if legacy engine is enabled
    if (!config.engines.legacy.enabled) {
      throw new Error('Legacy engine is disabled in configuration');
    }
    
    // Initialize the service asynchronously
    this.initPromise = this.initializeService(githubToken);
    console.log('🔧 Legacy Processing Engine initializing with service factory');
    console.log('🔧 Legacy Engine Config:', {
      memoryLimit: config.engines.legacy.memoryLimits.maxMemoryMB + 'MB',
      batchSize: config.engines.legacy.processing.batchSize,
      timeout: config.engines.legacy.processing.timeoutMs + 'ms',
      useWorkers: config.engines.legacy.processing.useWorkers
    });
  }
  
  private async initializeService(githubToken?: string): Promise<void> {
    try {
      this.ingestionService = await ServiceFactory.createIngestionService('legacy', githubToken);
      console.log('✅ Legacy Processing Engine initialized successfully');
    } catch (error) {
      console.error('❌ Legacy Processing Engine: Failed to initialize service:', error);
      this.lastError = error instanceof Error ? error.message : 'Failed to initialize service';
      throw error;
    }
  }
  
  private async ensureInitialized(): Promise<BaseIngestionService> {
    await this.initPromise;
    if (!this.ingestionService) {
      throw new Error('Legacy engine failed to initialize');
    }
    return this.ingestionService;
  }
  
  async process(input: ProcessingInput, callbacks?: ProcessingCallbacks): Promise<ProcessingResult> {
    const startTime = performance.now();
    
    try {
      callbacks?.onEngineSelected?.('legacy');
      console.log('🚀 Legacy Engine: Starting sequential processing...');
      
      // Ensure service is initialized
      const ingestionService = await this.ensureInitialized();
      
      let result;
      
      if (input.type === 'github' && input.url) {
        result = await this.processGitHubRepo(input.url, input.options, callbacks, ingestionService);
      } else if (input.type === 'zip' && input.file) {
        result = await this.processZipFile(input.file, input.options, callbacks, ingestionService);
      } else {
        throw new Error('Invalid input for legacy engine: missing URL or file');
      }
      }
      
      const endTime = performance.now();
      const processingTime = endTime - startTime;
      
      // Update performance stats
      this.updatePerformanceStats(processingTime, true);
      
      const metadata: ProcessingMetadata = {
        processingTime,
        nodeCount: result.graph.nodes.length,
        relationshipCount: result.graph.relationships.length,
        engineCapabilities: this.capabilities,
        fileCount: result.fileContents.size,
        version: this.version,
        timestamp: Date.now()
      };
      
      console.log(`✅ Legacy Engine: Processing completed in ${processingTime.toFixed(2)}ms`);
      console.log(`📊 Legacy Engine: Generated ${metadata.nodeCount} nodes, ${metadata.relationshipCount} relationships`);
      
      callbacks?.onPerformanceMetrics?.(metadata);
      
      return {
        engine: 'legacy',
        graph: result.graph,
        fileContents: result.fileContents,
        metadata
      };
      
    } catch (error) {
      const endTime = performance.now();
      const processingTime = endTime - startTime;
      
      this.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.updatePerformanceStats(processingTime, false);
      
      console.error('❌ Legacy Engine: Processing failed:', error);
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
        console.log(`🔄 Legacy Engine: ${progress}`);
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
        console.log(`🔄 Legacy Engine: ${progress}`);
        callbacks?.onProgress?.(progress);
      }
    });
  }
  
  async validate(): Promise<boolean> {
    try {
      // Check if legacy engine is enabled
      if (!config.engines.legacy.enabled) {
        this.lastError = 'Legacy engine is disabled in configuration';
        return false;
      }
      
      // Legacy engine is always available (no special dependencies)
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Validation failed';
      return false;
    }
  }
  
  async cleanup(): Promise<void> {
    try {
      console.log('🧹 Legacy Engine: Cleanup completed');
      // Legacy engine has minimal cleanup needs
    } catch (error) {
      console.error('❌ Legacy Engine: Cleanup failed:', error);
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
}