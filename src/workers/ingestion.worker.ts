// @ts-expect-error - npm: imports are resolved at runtime in Deno
import * as Comlink from 'npm:comlink';
import { GraphPipeline, type PipelineInput } from '../core/ingestion/pipeline.ts';
import type { KnowledgeGraph } from '../core/graph/types.ts';

export interface IngestionProgress {
  phase: 'structure' | 'parsing' | 'calls' | 'complete';
  message: string;
  progress: number;
  timestamp: number;
}

export interface IngestionResult {
  success: boolean;
  graph?: KnowledgeGraph;
  error?: string;
  stats?: {
    nodeStats: Record<string, number>;
    relationshipStats: Record<string, number>;
    callStats: { totalCalls: number; callTypes: Record<string, number> };
  };
  duration: number;
}

export class IngestionWorker {
  private pipeline: GraphPipeline;
  private progressCallback?: (progress: IngestionProgress) => void;

  constructor() {
    this.pipeline = new GraphPipeline();
  }

  public setProgressCallback(callback: (progress: IngestionProgress) => void): void {
    this.progressCallback = callback;
  }

  public async processRepository(input: PipelineInput): Promise<IngestionResult> {
    const startTime = performance.now();
    
    try {
      this.reportProgress('structure', 'Starting repository ingestion...', 0);
      
      // Validate input
      this.validateInput(input);
      
      this.reportProgress('structure', 'Processing project structure...', 10);
      
      // Run the pipeline
      const graph = await this.pipeline.run(input);
      
      this.reportProgress('complete', 'Ingestion completed successfully', 100);
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      // Gather statistics
      const stats = this.pipeline.getStats(graph);
      const callStats = this.pipeline.getCallStats();
      
      return {
        success: true,
        graph,
        stats: {
          nodeStats: stats.nodeStats,
          relationshipStats: stats.relationshipStats,
          callStats
        },
        duration
      };
      
    } catch (error) {
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      
      this.reportProgress('complete', `Ingestion failed: ${errorMessage}`, 0);
      
      return {
        success: false,
        error: errorMessage,
        duration
      };
    }
  }

  public async processFiles(
    projectName: string,
    files: { path: string; content: string }[]
  ): Promise<IngestionResult> {
    const fileContents = new Map<string, string>();
    const filePaths: string[] = [];
    
    for (const file of files) {
      filePaths.push(file.path);
      fileContents.set(file.path, file.content);
    }
    
    const input: PipelineInput = {
      projectRoot: '/',
      projectName,
      filePaths,
      fileContents
    };
    
    return this.processRepository(input);
  }

  public async validateRepository(input: PipelineInput): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    
    try {
      this.validateInput(input);
      
      // Additional validation checks
      if (input.filePaths.length === 0) {
        errors.push('No files provided for processing');
      }
      
      if (input.fileContents.size === 0) {
        errors.push('No file contents provided');
      }
      
      // Check for Python files
      const pythonFiles = input.filePaths.filter(path => path.endsWith('.py'));
      if (pythonFiles.length === 0) {
        errors.push('No Python files found in the repository');
      }
      
      // Validate file contents exist
      for (const filePath of input.filePaths) {
        if (!input.fileContents.has(filePath)) {
          errors.push(`Missing content for file: ${filePath}`);
        }
      }
      
      return {
        valid: errors.length === 0,
        errors
      };
      
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Validation failed');
      return {
        valid: false,
        errors
      };
    }
  }

  public getWorkerInfo(): { version: string; capabilities: string[] } {
    return {
      version: '1.0.0',
      capabilities: [
        'python-parsing',
        'structure-analysis',
        'call-resolution',
        'ast-caching',
        'progress-reporting'
      ]
    };
  }

  private validateInput(input: PipelineInput): void {
    if (!input.projectName || input.projectName.trim().length === 0) {
      throw new Error('Project name is required');
    }
    
    if (!input.projectRoot || input.projectRoot.trim().length === 0) {
      throw new Error('Project root is required');
    }
    
    if (!Array.isArray(input.filePaths)) {
      throw new Error('File paths must be an array');
    }
    
    if (!(input.fileContents instanceof Map)) {
      throw new Error('File contents must be a Map');
    }
  }

  private reportProgress(phase: IngestionProgress['phase'], message: string, progress: number): void {
    if (this.progressCallback) {
      this.progressCallback({
        phase,
        message,
        progress,
        timestamp: Date.now()
      });
    }
  }

  public terminate(): void {
    // Cleanup resources if needed
    console.log('Ingestion worker terminated');
  }
}

// Expose the worker class via Comlink
const worker = new IngestionWorker();
Comlink.expose(worker); 