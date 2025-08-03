// @ts-expect-error -  imports are resolved at runtime in Deno
import * as Comlink from 'comlink';
import type { IngestionWorker, IngestionProgress, IngestionResult } from '../workers/ingestion.worker.ts';
import type { PipelineInput } from '../core/ingestion/pipeline.ts';

export interface WorkerProxy {
  processRepository(input: PipelineInput): Promise<IngestionResult>;
  processFiles(projectName: string, files: { path: string; content: string }[]): Promise<IngestionResult>;
  validateRepository(input: PipelineInput): Promise<{ valid: boolean; errors: string[] }>;
  getWorkerInfo(): Promise<{ version: string; capabilities: string[] }>;
  setProgressCallback(callback: (progress: IngestionProgress) => void): Promise<void>;
  terminate(): Promise<void>;
}

export class IngestionWorkerManager {
  private worker: Worker | null = null;
  private workerProxy: WorkerProxy | null = null;
  private isInitialized = false;

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Create the worker
      this.worker = new Worker(
        new URL('../workers/ingestion.worker.ts', import.meta.url).href,
        {
          type: 'module',
          name: 'ingestion-worker'
        }
      );

      // Wrap with Comlink
      this.workerProxy = Comlink.wrap<IngestionWorker>(this.worker) as WorkerProxy;
      
      this.isInitialized = true;
      console.log('Ingestion worker initialized successfully');
      
    } catch (error) {
      throw new Error(`Failed to initialize ingestion worker: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async processRepository(input: PipelineInput): Promise<IngestionResult> {
    await this.ensureInitialized();
    
    try {
      return await this.workerProxy!.processRepository(input);
    } catch (error) {
      throw new Error(`Worker processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async processFiles(
    projectName: string, 
    files: { path: string; content: string }[]
  ): Promise<IngestionResult> {
    await this.ensureInitialized();
    
    try {
      return await this.workerProxy!.processFiles(projectName, files);
    } catch (error) {
      throw new Error(`Worker file processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async validateRepository(input: PipelineInput): Promise<{ valid: boolean; errors: string[] }> {
    await this.ensureInitialized();
    
    try {
      return await this.workerProxy!.validateRepository(input);
    } catch (error) {
      return {
        valid: false,
        errors: [`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }

  public async setProgressCallback(callback: (progress: IngestionProgress) => void): Promise<void> {
    await this.ensureInitialized();
    
    try {
      // Wrap callback with Comlink.proxy to allow it to be called from worker
      const proxiedCallback = Comlink.proxy(callback);
      await this.workerProxy!.setProgressCallback(proxiedCallback);
    } catch (error) {
      console.warn('Failed to set progress callback:', error);
    }
  }

  public async getWorkerInfo(): Promise<{ version: string; capabilities: string[] }> {
    await this.ensureInitialized();
    
    try {
      return await this.workerProxy!.getWorkerInfo();
    } catch (error) {
      throw new Error(`Failed to get worker info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async terminate(): Promise<void> {
    if (!this.isInitialized || !this.worker) {
      return;
    }

    try {
      // Notify worker to cleanup
      if (this.workerProxy) {
        await this.workerProxy.terminate();
      }
      
      // Terminate the worker
      this.worker.terminate();
      
      // Cleanup references
      this.worker = null;
      this.workerProxy = null;
      this.isInitialized = false;
      
      console.log('Ingestion worker terminated');
      
    } catch (error) {
      console.warn('Error during worker termination:', error);
      
      // Force terminate if cleanup fails
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
        this.workerProxy = null;
        this.isInitialized = false;
      }
    }
  }

  public isWorkerReady(): boolean {
    return this.isInitialized && this.worker !== null && this.workerProxy !== null;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }
}

// Singleton instance for easy access
let workerManager: IngestionWorkerManager | null = null;

export function getIngestionWorker(): IngestionWorkerManager {
  if (!workerManager) {
    workerManager = new IngestionWorkerManager();
  }
  return workerManager;
}

export async function createIngestionWorker(): Promise<IngestionWorkerManager> {
  const manager = new IngestionWorkerManager();
  await manager.initialize();
  return manager;
}

// Utility function for processing with automatic cleanup
export async function processWithWorker<T>(
  processor: (worker: IngestionWorkerManager) => Promise<T>
): Promise<T> {
  const worker = await createIngestionWorker();
  
  try {
    return await processor(worker);
  } finally {
    await worker.terminate();
  }
}

// Error handling utilities
export class WorkerError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'WorkerError';
  }
}

export function isWorkerSupported(): boolean {
  try {
    return typeof Worker !== 'undefined';
  } catch {
    return false;
  }
} 
