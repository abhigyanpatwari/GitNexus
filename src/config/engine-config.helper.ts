/**
 * Engine Configuration Helper
 * 
 * Provides easy access to engine-specific configuration for UI components
 * and other parts of the application that need engine settings.
 */

import { config } from './config';
import type { ProcessingEngineType } from '../core/engines/engine-interface';

/**
 * Engine configuration helper class
 */
export class EngineConfigHelper {
  
  /**
   * Get the default engine from configuration
   */
  static getDefaultEngine(): ProcessingEngineType {
    return config.engines.runtime.defaultEngine;
  }
  
  /**
   * Check if fallback is enabled
   */
  static isFallbackEnabled(): boolean {
    return config.engines.runtime.allowFallback;
  }
  
  /**
   * Check if performance monitoring is enabled
   */
  static isPerformanceMonitoringEnabled(): boolean {
    return config.engines.runtime.performanceMonitoring;
  }
  
  /**
   * Check if an engine is enabled
   */
  static isEngineEnabled(engine: ProcessingEngineType): boolean {
    switch (engine) {
      case 'legacy':
        return config.engines.legacy.enabled;
      case 'nextgen':
        return config.engines.nextgen.enabled;
      default:
        return false;
    }
  }
  
  /**
   * Get available engines (only enabled ones)
   */
  static getAvailableEngines(): ProcessingEngineType[] {
    const engines: ProcessingEngineType[] = [];
    
    if (config.engines.legacy.enabled) {
      engines.push('legacy');
    }
    
    if (config.engines.nextgen.enabled) {
      engines.push('nextgen');
    }
    
    return engines;
  }
  
  /**
   * Get engine-specific configuration
   */
  static getEngineConfig(engine: ProcessingEngineType) {
    switch (engine) {
      case 'legacy':
        return config.engines.legacy;
      case 'nextgen':
        return config.engines.nextgen;
      default:
        return null;
    }
  }
  
  /**
   * Get the fallback engine for a given primary engine
   */
  static getFallbackEngine(primaryEngine: ProcessingEngineType): ProcessingEngineType | null {
    if (!config.engines.runtime.allowFallback) {
      return null;
    }
    
    const availableEngines = EngineConfigHelper.getAvailableEngines();
    
    // Return the other available engine as fallback
    return availableEngines.find(engine => engine !== primaryEngine) || null;
  }
  
  /**
   * Get engine display information
   */
  static getEngineDisplayInfo(engine: ProcessingEngineType) {
    switch (engine) {
      case 'legacy':
        return {
          name: 'Legacy Engine',
          description: 'Sequential processing with in-memory storage',
          features: ['Single-threaded', 'JSON storage', 'Worker isolation', 'Stable performance'],
          enabled: config.engines.legacy.enabled
        };
      case 'nextgen':
        return {
          name: 'Next-Gen Engine',
          description: 'Parallel processing with KuzuDB storage',
          features: ['Multi-threaded', 'Database storage', 'Advanced queries', 'High performance'],
          enabled: config.engines.nextgen.enabled
        };
      default:
        return null;
    }
  }
  
  /**
   * Check if auto engine selection is enabled
   */
  static isAutoSelectionEnabled(): boolean {
    return config.engines.runtime.autoEngineSelection;
  }
  
  /**
   * Get the fallback threshold (time before switching engines)
   */
  static getFallbackThresholdMs(): number {
    return config.engines.runtime.fallbackThresholdMs;
  }
  
  /**
   * Get engine-specific processing options
   */
  static getProcessingOptions(engine: ProcessingEngineType) {
    switch (engine) {
      case 'legacy':
        return {
          batchSize: config.engines.legacy.processing.batchSize,
          timeoutMs: config.engines.legacy.processing.timeoutMs,
          useWorkers: config.engines.legacy.processing.useWorkers,
          maxMemoryMB: config.engines.legacy.memoryLimits.maxMemoryMB
        };
      case 'nextgen':
        return {
          maxWorkers: config.engines.nextgen.parallel.maxWorkers,
          batchSize: config.engines.nextgen.parallel.batchSize,
          workerTimeoutMs: config.engines.nextgen.parallel.workerTimeoutMs,
          enableParallelParsing: config.engines.nextgen.parallel.enableParallelParsing,
          kuzuBufferPoolSize: config.engines.nextgen.kuzu.bufferPoolSize
        };
      default:
        return {};
    }
  }
  
  /**
   * Validate engine configuration
   */
  static validateEngineConfig(): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // Check if at least one engine is enabled
    if (!config.engines.legacy.enabled && !config.engines.nextgen.enabled) {
      errors.push('At least one processing engine must be enabled');
    }
    
    // Check if default engine is enabled
    if (!EngineConfigHelper.isEngineEnabled(config.engines.runtime.defaultEngine)) {
      errors.push(`Default engine '${config.engines.runtime.defaultEngine}' is not enabled`);
    }
    
    // Check worker configuration for next-gen engine
    if (config.engines.nextgen.enabled) {
      const maxWorkers = config.engines.nextgen.parallel.maxWorkers;
      if (maxWorkers <= 0) {
        errors.push('Next-Gen engine maxWorkers must be greater than 0');
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
}