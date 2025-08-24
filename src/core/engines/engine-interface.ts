/**
 * Common interface for all processing engines
 * Provides abstraction layer for switching between legacy and next-gen engines
 */

import type { KnowledgeGraph } from '../graph/types';

export type ProcessingEngineType = 'legacy' | 'nextgen';

/**
 * Input configuration for processing
 */
export interface ProcessingInput {
  type: 'github' | 'zip';
  url?: string;
  file?: File;
  options?: ProcessingOptions;
}

/**
 * Processing options
 */
export interface ProcessingOptions {
  directoryFilter?: string;
  fileExtensions?: string;
  useParallelProcessing?: boolean;
  maxWorkers?: number;
  onProgress?: (progress: string) => void;
}

/**
 * Result returned by processing engines
 */
export interface ProcessingResult {
  engine: ProcessingEngineType;
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
  metadata: ProcessingMetadata;
  // Engine-specific data
  kuzuInstance?: any; // For next-gen engine
}

/**
 * Metadata about processing results
 */
export interface ProcessingMetadata {
  processingTime: number;
  nodeCount: number;
  relationshipCount: number;
  engineCapabilities: string[];
  fileCount: number;
  version: string;
  timestamp: number;
}

/**
 * Callbacks for processing events
 */
export interface ProcessingCallbacks {
  onEngineSelected?: (engine: ProcessingEngineType) => void;
  onProgress?: (progress: string) => void;
  onEngineFailure?: (failed: ProcessingEngineType, fallback: ProcessingEngineType, error: string) => void;
  onPerformanceMetrics?: (metrics: ProcessingMetadata) => void;
}

/**
 * Common interface that all processing engines must implement
 */
export interface ProcessingEngine {
  readonly name: string;
  readonly type: ProcessingEngineType;
  readonly version: string;
  readonly capabilities: string[];
  
  /**
   * Process a repository or ZIP file
   */
  process(input: ProcessingInput, callbacks?: ProcessingCallbacks): Promise<ProcessingResult>;
  
  /**
   * Validate that the engine can run in current environment
   */
  validate(): Promise<boolean>;
  
  /**
   * Cleanup any resources used by the engine
   */
  cleanup(): Promise<void>;
  
  /**
   * Get current engine status
   */
  getStatus(): EngineStatus;
}

/**
 * Engine status information
 */
export interface EngineStatus {
  available: boolean;
  healthy: boolean;
  lastError?: string;
  performance?: {
    averageProcessingTime: number;
    successRate: number;
    lastProcessedAt?: number;
  };
}

/**
 * Engine configuration
 */
export interface EngineConfig {
  enableFallback: boolean;
  fallbackEngine?: ProcessingEngineType;
  timeoutMs: number;
  maxRetries: number;
  performanceMonitoring: boolean;
}

/**
 * Performance comparison data between engines
 */
export interface EnginePerformanceComparison {
  legacy: ProcessingMetadata;
  nextgen: ProcessingMetadata;
  comparison: {
    speedupFactor: number;
    memoryDifference: number;
    accuracyDifference: number;
  };
}