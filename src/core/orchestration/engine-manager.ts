/**
 * Engine Manager
 * Handles switching between legacy and next-gen engines with fallback support
 */

import { featureFlagManager } from '../../config/feature-flags';
import { LegacyProcessingEngine } from '../engines/legacy/legacy-engine';
import { NextGenProcessingEngine } from '../engines/nextgen/nextgen-engine';
import type { 
  ProcessingEngine, 
  ProcessingInput, 
  ProcessingResult, 
  ProcessingCallbacks,
  ProcessingEngineType,
  EnginePerformanceComparison,
  ProcessingMetadata
} from '../engines/engine-interface';

/**
 * Engine Manager Configuration
 */
interface EngineManagerConfig {
  autoFallback: boolean;
  timeoutMs: number;
  maxRetries: number;
  performanceComparison: boolean;
  githubToken?: string;
}

/**
 * Engine Manager - Orchestrates processing engine selection and fallback
 */
export class EngineManager {
  private legacyEngine: LegacyProcessingEngine;
  private nextGenEngine: NextGenProcessingEngine;
  private config: EngineManagerConfig;
  private performanceHistory: Array<{ engine: ProcessingEngineType; metadata: ProcessingMetadata }> = [];
  
  constructor(config: Partial<EngineManagerConfig> = {}) {
    this.config = {
      autoFallback: featureFlagManager.getFlag('autoFallbackOnError'),
      timeoutMs: 5 * 60 * 1000, // 5 minutes default timeout
      maxRetries: 2,
      performanceComparison: featureFlagManager.getFlag('enablePerformanceComparison'),
      ...config
    };
    
    // Initialize engines
    this.legacyEngine = new LegacyProcessingEngine(this.config.githubToken);
    this.nextGenEngine = new NextGenProcessingEngine(this.config.githubToken);
    
    console.log('🎯 Engine Manager initialized with config:', {
      autoFallback: this.config.autoFallback,
      performanceComparison: this.config.performanceComparison,
      engines: ['legacy', 'nextgen']
    });
  }
  
  /**
   * Process input using the configured engine with fallback support
   */
  async process(input: ProcessingInput, callbacks?: ProcessingCallbacks): Promise<ProcessingResult> {
    const selectedEngine = featureFlagManager.getProcessingEngine();
    console.log(`🎯 Engine Manager: Selected engine - ${selectedEngine}`);
    
    try {
      // First, try the selected engine
      const result = await this.processWithEngine(selectedEngine, input, callbacks);
      
      // Record performance data
      this.recordPerformance(selectedEngine, result.metadata);
      
      return result;
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ Engine Manager: ${selectedEngine} engine failed:`, errorMessage);
      
      // Log the failure
      featureFlagManager.logEngineFallback(errorMessage);
      
      // Try fallback if enabled
      if (this.config.autoFallback && selectedEngine === 'nextgen') {
        console.warn(`🔄 Engine Manager: Auto-fallback enabled, switching to legacy engine`);
        
        try {
          callbacks?.onEngineFailure?.('nextgen', 'legacy', errorMessage);
          
          const fallbackResult = await this.processWithEngine('legacy', input, callbacks);
          
          // Record performance data
          this.recordPerformance('legacy', fallbackResult.metadata);
          
          console.log(`✅ Engine Manager: Fallback to legacy engine successful`);
          return fallbackResult;
          
        } catch (fallbackError) {
          const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : 'Unknown fallback error';
          console.error(`❌ Engine Manager: Fallback to legacy also failed:`, fallbackErrorMessage);
          throw new Error(`Both engines failed. Primary: ${errorMessage}, Fallback: ${fallbackErrorMessage}`);
        }
      } else {
        // No fallback available or disabled
        throw error;
      }
    }
  }
  
  /**
   * Process with a specific engine
   */
  private async processWithEngine(
    engineType: ProcessingEngineType,
    input: ProcessingInput,
    callbacks?: ProcessingCallbacks
  ): Promise<ProcessingResult> {
    const engine = this.getEngine(engineType);
    
    // Validate engine before processing
    const isValid = await engine.validate();
    if (!isValid) {
      const status = engine.getStatus();
      throw new Error(`Engine validation failed: ${status.lastError || 'Unknown validation error'}`);
    }
    
    // Set timeout wrapper
    return this.withTimeout(
      engine.process(input, callbacks),
      this.config.timeoutMs,
      `${engineType} engine timeout`
    );
  }
  
  /**
   * Get engine instance by type
   */
  private getEngine(type: ProcessingEngineType): ProcessingEngine {
    switch (type) {
      case 'legacy':
        return this.legacyEngine;
      case 'nextgen':
        return this.nextGenEngine;
      default:
        throw new Error(`Unknown engine type: ${type}`);
    }
  }
  
  /**
   * Wrap promise with timeout
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    
    return Promise.race([promise, timeoutPromise]);
  }
  
  /**
   * Record performance data for comparison
   */
  private recordPerformance(engine: ProcessingEngineType, metadata: ProcessingMetadata): void {
    this.performanceHistory.push({ engine, metadata });
    
    // Keep only last 10 entries per engine
    this.performanceHistory = this.performanceHistory
      .filter(entry => entry.engine === engine)
      .slice(-10)
      .concat(
        this.performanceHistory.filter(entry => entry.engine !== engine)
      );
  }
  
  /**
   * Switch to a specific engine
   */
  async switchEngine(targetEngine: ProcessingEngineType, reason?: string): Promise<void> {
    const currentEngine = featureFlagManager.getProcessingEngine();
    
    if (currentEngine === targetEngine) {
      console.log(`🎯 Engine Manager: Already using ${targetEngine} engine`);
      return;
    }
    
    // Log the switch
    featureFlagManager.logEngineSwitch(currentEngine, targetEngine, reason);
    
    // Update feature flags
    if (targetEngine === 'legacy') {
      featureFlagManager.switchToLegacyEngine();
    } else {
      featureFlagManager.switchToNextGenEngine();
    }
    
    console.log(`🔄 Engine Manager: Switched from ${currentEngine} to ${targetEngine}`);
  }
  
  /**
   * Get current engine status
   */
  getCurrentEngineStatus() {
    const currentEngine = featureFlagManager.getProcessingEngine();
    const engine = this.getEngine(currentEngine);
    return {
      current: currentEngine,
      status: engine.getStatus(),
      capabilities: engine.capabilities
    };
  }
  
  /**
   * Get all engine statuses
   */
  getAllEngineStatuses() {
    return {
      legacy: this.legacyEngine.getStatus(),
      nextgen: this.nextGenEngine.getStatus()
    };
  }
  
  /**
   * Compare performance between engines
   */
  getPerformanceComparison(): EnginePerformanceComparison | null {
    const legacyHistory = this.performanceHistory.filter(entry => entry.engine === 'legacy');
    const nextgenHistory = this.performanceHistory.filter(entry => entry.engine === 'nextgen');
    
    if (legacyHistory.length === 0 || nextgenHistory.length === 0) {
      return null;
    }
    
    const legacyAvg = legacyHistory.reduce((sum, entry) => sum + entry.metadata.processingTime, 0) / legacyHistory.length;
    const nextgenAvg = nextgenHistory.reduce((sum, entry) => sum + entry.metadata.processingTime, 0) / nextgenHistory.length;
    
    const legacyMetadata = legacyHistory[legacyHistory.length - 1].metadata;
    const nextgenMetadata = nextgenHistory[nextgenHistory.length - 1].metadata;
    
    return {
      legacy: legacyMetadata,
      nextgen: nextgenMetadata,
      comparison: {
        speedupFactor: legacyAvg / nextgenAvg,
        memoryDifference: 0, // TODO: Implement memory tracking
        accuracyDifference: 0 // TODO: Implement accuracy comparison
      }
    };
  }
  
  /**
   * Get recommended engine based on performance data
   */
  getRecommendedEngine(): ProcessingEngineType {
    const comparison = this.getPerformanceComparison();
    
    if (!comparison) {
      // If no performance data, recommend based on capabilities needed
      return featureFlagManager.getFlag('enableKuzuDB') ? 'nextgen' : 'legacy';
    }
    
    // Recommend next-gen if it's significantly faster (>20% improvement)
    if (comparison.comparison.speedupFactor > 1.2) {
      return 'nextgen';
    }
    
    // Recommend legacy for stability if performance is similar
    return 'legacy';
  }
  
  /**
   * Update configuration
   */
  updateConfig(updates: Partial<EngineManagerConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log('🎯 Engine Manager: Configuration updated:', updates);
  }
  
  /**
   * Cleanup all engines
   */
  async cleanup(): Promise<void> {
    console.log('🧹 Engine Manager: Starting cleanup...');
    
    try {
      await Promise.all([
        this.legacyEngine.cleanup(),
        this.nextGenEngine.cleanup()
      ]);
      console.log('✅ Engine Manager: Cleanup completed');
    } catch (error) {
      console.error('❌ Engine Manager: Cleanup failed:', error);
    }
  }
  
  /**
   * Validate both engines
   */
  async validateAllEngines(): Promise<{ legacy: boolean; nextgen: boolean }> {
    const [legacyValid, nextgenValid] = await Promise.all([
      this.legacyEngine.validate(),
      this.nextGenEngine.validate()
    ]);
    
    return { legacy: legacyValid, nextgen: nextgenValid };
  }
}