/**
 * GitNexus Facade Service
 * Simplified API for UI components to interact with the dual-track engine system
 * Abstracts away engine complexity and provides a clean interface
 */

import { EngineManager } from '../../core/orchestration/engine-manager';
import { featureFlagManager } from '../../config/feature-flags';
import type { 
  ProcessingInput,
  ProcessingResult,
  ProcessingCallbacks,
  ProcessingEngineType,
  EnginePerformanceComparison
} from '../../core/engines/engine-interface';
import type { KnowledgeGraph } from '../../core/graph/types';

/**
 * Simplified processing options for UI
 */
export interface GitNexusProcessingOptions {
  directoryFilter?: string;
  fileExtensions?: string;
  engine?: ProcessingEngineType;
  onProgress?: (progress: string) => void;
  onEngineSwitch?: (from: ProcessingEngineType, to: ProcessingEngineType) => void;
}

/**
 * Processing result for UI consumption
 */
export interface GitNexusResult {
  success: boolean;
  graph?: KnowledgeGraph;
  fileContents?: Map<string, string>;
  engineUsed: ProcessingEngineType;
  processingTime: number;
  nodeCount: number;
  relationshipCount: number;
  fileCount: number;
  hadFallback: boolean;
  error?: string;
}

/**
 * Engine status for UI display
 */
export interface EngineInfo {
  type: ProcessingEngineType;
  name: string;
  version: string;
  capabilities: string[];
  available: boolean;
  healthy: boolean;
  lastError?: string;
}

/**
 * GitNexus Facade - Simplified API for UI components
 */
export class GitNexusFacade {
  private engineManager: EngineManager;
  private lastResult?: GitNexusResult;
  
  constructor(githubToken?: string) {
    this.engineManager = new EngineManager({ githubToken });
    console.log('🎯 GitNexus Facade initialized');
  }
  
  /**
   * Process a GitHub repository
   */
  async processGitHubRepository(
    url: string, 
    options: GitNexusProcessingOptions = {}
  ): Promise<GitNexusResult> {
    const input: ProcessingInput = {
      type: 'github',
      url,
      options: {
        directoryFilter: options.directoryFilter,
        fileExtensions: options.fileExtensions,
        onProgress: options.onProgress
      }
    };
    
    return this.processInternal(input, options);
  }
  
  /**
   * Process a ZIP file
   */
  async processZipFile(
    file: File, 
    options: GitNexusProcessingOptions = {}
  ): Promise<GitNexusResult> {
    const input: ProcessingInput = {
      type: 'zip',
      file,
      options: {
        directoryFilter: options.directoryFilter,
        fileExtensions: options.fileExtensions,
        onProgress: options.onProgress
      }
    };
    
    return this.processInternal(input, options);
  }
  
  /**
   * Internal processing logic
   */
  private async processInternal(
    input: ProcessingInput, 
    options: GitNexusProcessingOptions
  ): Promise<GitNexusResult> {
    const startTime = performance.now();
    let hadFallback = false;
    let engineUsed = options.engine || featureFlagManager.getProcessingEngine();
    
    // Switch engine if requested
    if (options.engine && options.engine !== featureFlagManager.getProcessingEngine()) {
      await this.engineManager.switchEngine(options.engine, 'User selection');
      engineUsed = options.engine;
    }
    
    try {
      const callbacks: ProcessingCallbacks = {
        onProgress: options.onProgress,
        onEngineFailure: (failed, fallback, error) => {
          hadFallback = true;
          engineUsed = fallback;
          options.onEngineSwitch?.(failed, fallback);
          console.warn(`🔄 GitNexus Facade: Engine fallback ${failed} → ${fallback}`);
        }
      };
      
      const result = await this.engineManager.process(input, callbacks);
      const endTime = performance.now();
      
      const gitNexusResult: GitNexusResult = {
        success: true,
        graph: result.graph,
        fileContents: result.fileContents,
        engineUsed: result.engine,
        processingTime: endTime - startTime,
        nodeCount: result.metadata.nodeCount,
        relationshipCount: result.metadata.relationshipCount,
        fileCount: result.metadata.fileCount,
        hadFallback
      };
      
      this.lastResult = gitNexusResult;
      console.log(`✅ GitNexus Facade: Processing successful with ${result.engine} engine`);
      
      return gitNexusResult;
      
    } catch (error) {
      const endTime = performance.now();
      const errorMessage = error instanceof Error ? error.message : 'Processing failed';
      
      const gitNexusResult: GitNexusResult = {
        success: false,
        engineUsed,
        processingTime: endTime - startTime,
        nodeCount: 0,
        relationshipCount: 0,
        fileCount: 0,
        hadFallback,
        error: errorMessage
      };
      
      this.lastResult = gitNexusResult;
      console.error('❌ GitNexus Facade: Processing failed:', errorMessage);
      
      return gitNexusResult;
    }
  }
  
  /**
   * Switch processing engine
   */
  async switchEngine(engine: ProcessingEngineType, reason?: string): Promise<void> {
    await this.engineManager.switchEngine(engine, reason);
    console.log(`🔄 GitNexus Facade: Switched to ${engine} engine`);
  }
  
  /**
   * Get current engine information
   */
  getCurrentEngine(): EngineInfo {
    const status = this.engineManager.getCurrentEngineStatus();
    return this.formatEngineInfo(status.current, status.status, status.capabilities);
  }
  
  /**
   * Get all available engines
   */
  getAvailableEngines(): EngineInfo[] {
    const statuses = this.engineManager.getAllEngineStatuses();
    
    return [
      this.formatEngineInfo('legacy', statuses.legacy, ['sequential-processing', 'in-memory', 'basic-queries']),
      this.formatEngineInfo('nextgen', statuses.nextgen, ['parallel-processing', 'kuzu-db', 'advanced-queries'])
    ];
  }
  
  /**
   * Format engine information for UI
   */
  private formatEngineInfo(type: ProcessingEngineType, status: any, capabilities: string[]): EngineInfo {
    return {
      type,
      name: type === 'legacy' ? 'Legacy Engine' : 'Next-Gen Engine',
      version: type === 'legacy' ? '1.0.0' : '2.0.0',
      capabilities,
      available: status.available,
      healthy: status.healthy,
      lastError: status.lastError
    };
  }
  
  /**
   * Get engine performance comparison
   */
  getPerformanceComparison(): EnginePerformanceComparison | null {
    return this.engineManager.getPerformanceComparison();
  }
  
  /**
   * Get recommended engine
   */
  getRecommendedEngine(): ProcessingEngineType {
    return this.engineManager.getRecommendedEngine();
  }
  
  /**
   * Get last processing result
   */
  getLastResult(): GitNexusResult | undefined {
    return this.lastResult;
  }
  
  /**
   * Validate all engines
   */
  async validateEngines(): Promise<{ legacy: boolean; nextgen: boolean }> {
    return this.engineManager.validateAllEngines();
  }
  
  /**
   * Get feature flags related to engines
   */
  getEngineFeatureFlags() {
    return {
      processingEngine: featureFlagManager.getProcessingEngine(),
      autoFallback: featureFlagManager.getFlag('autoFallbackOnError'),
      performanceComparison: featureFlagManager.getFlag('enablePerformanceComparison'),
      parallelProcessing: featureFlagManager.getFlag('enableParallelProcessing'),
      kuzuDB: featureFlagManager.getFlag('enableKuzuDB')
    };
  }
  
  /**
   * Update engine feature flags
   */
  updateEngineFeatureFlags(flags: {
    processingEngine?: ProcessingEngineType;
    autoFallback?: boolean;
    performanceComparison?: boolean;
  }) {
    if (flags.processingEngine) {
      if (flags.processingEngine === 'legacy') {
        featureFlagManager.switchToLegacyEngine();
      } else {
        featureFlagManager.switchToNextGenEngine();
      }
    }
    
    if (flags.autoFallback !== undefined) {
      featureFlagManager.setFlag('autoFallbackOnError', flags.autoFallback);
    }
    
    if (flags.performanceComparison !== undefined) {
      featureFlagManager.setFlag('enablePerformanceComparison', flags.performanceComparison);
    }
  }
  
  /**
   * Get processing statistics
   */
  getProcessingStats() {
    const comparison = this.getPerformanceComparison();
    const lastResult = this.getLastResult();
    
    return {
      lastProcessing: lastResult ? {
        engine: lastResult.engineUsed,
        processingTime: lastResult.processingTime,
        nodeCount: lastResult.nodeCount,
        relationshipCount: lastResult.relationshipCount,
        hadFallback: lastResult.hadFallback
      } : null,
      comparison: comparison ? {
        legacyTime: comparison.legacy.processingTime,
        nextgenTime: comparison.nextgen.processingTime,
        speedupFactor: comparison.comparison.speedupFactor
      } : null
    };
  }
  
  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    await this.engineManager.cleanup();
    console.log('🧹 GitNexus Facade: Cleanup completed');
  }
}