/**
 * Feature Flags Configuration
 * Controls experimental features and integrations
 */

export interface FeatureFlags {
  // KuzuDB Integration
  enableKuzuDB: boolean;
  enableKuzuDBPersistence: boolean;
  enableKuzuDBPerformanceMonitoring: boolean;
  
  // AI Features
  enableAdvancedRAG: boolean;
  enableReActReasoning: boolean;
  enableMultiLLM: boolean;
  
  // Performance Features
  enableWebWorkers: boolean;
  enableBatchProcessing: boolean;
  enableCaching: boolean;
  enableWorkerPool: boolean;
  enableParallelParsing: boolean;
  enableParallelProcessing: boolean;
  
  // Debug Features
  enableDebugMode: boolean;
  enablePerformanceLogging: boolean;
  enableQueryLogging: boolean;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  // KuzuDB Integration - Now enabled with npm package
  enableKuzuDB: true,
  enableKuzuDBPersistence: true,
  enableKuzuDBPerformanceMonitoring: true,
  
  // AI Features
  enableAdvancedRAG: true,
  enableReActReasoning: true,
  enableMultiLLM: true,
  
  // Performance Features
  enableWebWorkers: true,
  enableBatchProcessing: true,
  enableCaching: true,
  enableWorkerPool: true,
  enableParallelParsing: true,
  enableParallelProcessing: true,
  
  // Debug Features
  enableDebugMode: false,
  enablePerformanceLogging: false,
  enableQueryLogging: false
};

class FeatureFlagManager {
  private flags: FeatureFlags;
  private listeners: Set<(flags: FeatureFlags) => void> = new Set();

  constructor() {
    this.flags = this.loadFlags();
  }

  /**
   * Load feature flags from localStorage or use defaults
   */
  private loadFlags(): FeatureFlags {
    try {
      const stored = localStorage.getItem('gitnexus_feature_flags');
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...DEFAULT_FEATURE_FLAGS, ...parsed };
      }
    } catch (error) {
      console.warn('Failed to load feature flags from localStorage:', error);
    }
    
    return { ...DEFAULT_FEATURE_FLAGS };
  }

  /**
   * Save feature flags to localStorage
   */
  private saveFlags(): void {
    try {
      localStorage.setItem('gitnexus_feature_flags', JSON.stringify(this.flags));
    } catch (error) {
      console.warn('Failed to save feature flags to localStorage:', error);
    }
  }

  /**
   * Get all feature flags
   */
  getFlags(): FeatureFlags {
    return { ...this.flags };
  }

  /**
   * Get a specific feature flag
   */
  getFlag<K extends keyof FeatureFlags>(key: K): FeatureFlags[K] {
    return this.flags[key];
  }

  /**
   * Set a feature flag
   */
  setFlag<K extends keyof FeatureFlags>(key: K, value: FeatureFlags[K]): void {
    this.flags[key] = value;
    this.saveFlags();
    this.notifyListeners();
  }

  /**
   * Set multiple feature flags
   */
  setFlags(updates: Partial<FeatureFlags>): void {
    this.flags = { ...this.flags, ...updates };
    this.saveFlags();
    this.notifyListeners();
  }

  /**
   * Reset all feature flags to defaults
   */
  resetFlags(): void {
    this.flags = { ...DEFAULT_FEATURE_FLAGS };
    this.saveFlags();
    this.notifyListeners();
  }

  /**
   * Enable KuzuDB integration
   */
  enableKuzuDB(): void {
    this.setFlags({
      enableKuzuDB: true,
      enableKuzuDBPersistence: true,
      enableKuzuDBPerformanceMonitoring: true
    });
  }

  /**
   * Disable KuzuDB integration
   */
  disableKuzuDB(): void {
    this.setFlags({
      enableKuzuDB: false,
      enableKuzuDBPersistence: false,
      enableKuzuDBPerformanceMonitoring: false
    });
  }

  /**
   * Enable worker pool and parallel processing
   */
  enableWorkerPool(): void {
    this.setFlags({
      enableWorkerPool: true,
      enableParallelParsing: true,
      enableParallelProcessing: true
    });
  }

  /**
   * Disable worker pool and parallel processing
   */
  disableWorkerPool(): void {
    this.setFlags({
      enableWorkerPool: false,
      enableParallelParsing: false,
      enableParallelProcessing: false
    });
  }

  /**
   * Enable debug mode
   */
  enableDebugMode(): void {
    this.setFlags({
      enableDebugMode: true,
      enablePerformanceLogging: true,
      enableQueryLogging: true
    });
  }

  /**
   * Disable debug mode
   */
  disableDebugMode(): void {
    this.setFlags({
      enableDebugMode: false,
      enablePerformanceLogging: false,
      enableQueryLogging: false
    });
  }

  /**
   * Add a listener for flag changes
   */
  addListener(listener: (flags: FeatureFlags) => void): void {
    this.listeners.add(listener);
  }

  /**
   * Remove a listener
   */
  removeListener(listener: (flags: FeatureFlags) => void): void {
    this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of flag changes
   */
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.getFlags());
      } catch (error) {
        console.error('Feature flag listener error:', error);
      }
    }
  }

  /**
   * Check if KuzuDB is fully enabled
   */
  isKuzuDBEnabled(): boolean {
    return this.flags.enableKuzuDB && this.flags.enableKuzuDBPersistence;
  }

  /**
   * Check if debug mode is enabled
   */
  isDebugModeEnabled(): boolean {
    return this.flags.enableDebugMode;
  }

  /**
   * Check if performance monitoring is enabled
   */
  isPerformanceMonitoringEnabled(): boolean {
    return this.flags.enableKuzuDBPerformanceMonitoring || this.flags.enablePerformanceLogging;
  }
}

// Export singleton instance
export const featureFlags = new FeatureFlagManager();

// Export convenience functions
export const getFeatureFlag = <K extends keyof FeatureFlags>(key: K): FeatureFlags[K] => 
  featureFlags.getFlag(key);

export const setFeatureFlag = <K extends keyof FeatureFlags>(key: K, value: FeatureFlags[K]): void => 
  featureFlags.setFlag(key, value);

export const isKuzuDBEnabled = (): boolean => featureFlags.isKuzuDBEnabled();
export const isDebugModeEnabled = (): boolean => featureFlags.isDebugModeEnabled();
export const isPerformanceMonitoringEnabled = (): boolean => featureFlags.isPerformanceMonitoringEnabled();
export const isWorkerPoolEnabled = (): boolean => featureFlags.getFlag('enableWorkerPool');
export const isParallelParsingEnabled = (): boolean => featureFlags.getFlag('enableParallelParsing');
export const isParallelProcessingEnabled = (): boolean => featureFlags.getFlag('enableParallelProcessing');
