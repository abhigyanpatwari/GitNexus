/**
 * Service Factory
 * 
 * Centralized factory for creating engine-specific services.
 * Enables proper dependency injection and service instantiation
 * based on the processing engine type.
 */

import type { ProcessingEngineType } from '../../core/engines/engine-interface';
import type { BaseIngestionService } from '../common/base-ingestion.service';

/**
 * Service factory interface for consistency
 */
export interface ServiceFactoryInterface {
  createIngestionService(engine: ProcessingEngineType, githubToken?: string): Promise<BaseIngestionService>;
}

/**
 * Main service factory implementation
 */
export class ServiceFactory implements ServiceFactoryInterface {
  
  /**
   * Create an ingestion service based on engine type
   */
  static async createIngestionService(engine: ProcessingEngineType, githubToken?: string): Promise<BaseIngestionService> {
    switch (engine) {
      case 'legacy':
        return await ServiceFactory.createLegacyIngestionService(githubToken);
      
      case 'nextgen':
        return await ServiceFactory.createNextGenIngestionService(githubToken);
      
      default:
        throw new Error(`Unknown processing engine type: ${engine}`);
    }
  }

  /**
   * Create Legacy ingestion service
   */
  private static async createLegacyIngestionService(githubToken?: string): Promise<BaseIngestionService> {
    // Dynamic import to avoid circular dependencies
    // This will load the legacy service only when needed
    const { LegacyIngestionService } = await import('./legacy/legacy-ingestion.service');
    return new LegacyIngestionService(githubToken);
  }

  /**
   * Create Next-Gen ingestion service
   */
  private static async createNextGenIngestionService(githubToken?: string): Promise<BaseIngestionService> {
    // Dynamic import to avoid circular dependencies
    // This will load the next-gen service only when needed
    const { NextGenIngestionService } = await import('./nextgen/nextgen-ingestion.service');
    return new NextGenIngestionService(githubToken);
  }

  /**
   * Validate that an engine type is supported
   */
  static isEngineSupported(engine: string): engine is ProcessingEngineType {
    return engine === 'legacy' || engine === 'nextgen';
  }

  /**
   * Get all supported engine types
   */
  static getSupportedEngines(): ProcessingEngineType[] {
    return ['legacy', 'nextgen'];
  }

  /**
   * Create service with automatic fallback
   * Attempts to create the requested engine, falls back to alternative if it fails
   */
  static async createIngestionServiceWithFallback(
    primaryEngine: ProcessingEngineType,
    fallbackEngine: ProcessingEngineType,
    githubToken?: string
  ): Promise<{ service: BaseIngestionService; usedEngine: ProcessingEngineType }> {
    try {
      const service = await ServiceFactory.createIngestionService(primaryEngine, githubToken);
      return { service, usedEngine: primaryEngine };
    } catch (error) {
      console.warn(`Failed to create ${primaryEngine} service, falling back to ${fallbackEngine}:`, error);
      const service = await ServiceFactory.createIngestionService(fallbackEngine, githubToken);
      return { service, usedEngine: fallbackEngine };
    }
  }
}