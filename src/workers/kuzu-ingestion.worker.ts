import * as Comlink from 'comlink';
import { KuzuGraphPipeline, type KuzuPipelineInput } from '../core/ingestion/kuzu-pipeline';
import type { KuzuKnowledgeGraphInterface } from '../core/graph/types';

export interface KuzuIngestionProgress {
  phase: 'initialization' | 'structure' | 'parsing' | 'imports' | 'calls' | 'complete';
  message: string;
  progress: number;
  timestamp: number;
}

export interface KuzuIngestionResult {
  success: boolean;
  graph?: KuzuKnowledgeGraphInterface | null;
  error?: string;
  stats?: {
    nodeCount: number;
    relationshipCount: number;
    processingRate: number;
  };
  duration: number;
}

/**
 * KuzuDB Ingestion Worker - Direct Database Integration
 * 
 * Processes code and directly inserts nodes and relationships into KuzuDB,
 * eliminating the need for JSON storage and conversion steps.
 */
export class KuzuIngestionWorker {
  private pipeline: KuzuGraphPipeline;
  private progressCallback?: (progress: KuzuIngestionProgress) => void;

  constructor() {
    this.pipeline = new KuzuGraphPipeline();
  }

  public setProgressCallback(callback: (progress: KuzuIngestionProgress) => void): void {
    this.progressCallback = callback;
    
    // Set up pipeline progress callback
    this.pipeline.setProgressCallback((progress) => {
      if (this.progressCallback) {
        this.progressCallback({
          phase: progress.phase,
          message: progress.message,
          progress: progress.progress,
          timestamp: progress.timestamp
        });
      }
    });
  }

  public async processRepository(input: KuzuPipelineInput): Promise<KuzuIngestionResult> {
    const startTime = Date.now();
    
    try {
      console.log('KuzuIngestionWorker: Starting KuzuDB processing with', input.filePaths.length, 'files');
      
      // Memory optimization: Create a copy of file contents and clear originals gradually
      const fileContentsMap = new Map(input.fileContents);
      
      // Initialize pipeline
      if (!this.pipeline) {
        this.pipeline = new KuzuGraphPipeline();
      }
      
      // Run the KuzuDB pipeline with direct database integration
      const graph = await this.pipeline.run({
        ...input,
        fileContents: fileContentsMap
      });
      
      // Clear file contents to free memory after processing
      fileContentsMap.clear();
      
      const duration = Date.now() - startTime;
      
      console.log('KuzuIngestionWorker: KuzuDB processing completed successfully');
      console.log(`Graph contains ${graph.getNodeCount()} nodes and ${graph.getRelationshipCount()} relationships in KuzuDB`);
      
      // Calculate statistics
      const nodeCount = graph.getNodeCount();
      const relationshipCount = graph.getRelationshipCount();
      const processingRate = duration > 0 ? (nodeCount + relationshipCount) / (duration / 1000) : 0;

      // Final progress update
      if (this.progressCallback) {
        this.progressCallback({
          phase: 'complete',
          message: `KuzuDB processing complete: ${nodeCount} nodes, ${relationshipCount} relationships`,
          progress: 100,
          timestamp: Date.now()
        });
      }

      return {
        success: true,
        graph: null, // Don't return the graph object as it's not serializable
        stats: {
          nodeCount,
          relationshipCount,
          processingRate
        },
        duration
      };
    } catch (error) {
      console.error('KuzuIngestionWorker: KuzuDB processing failed:', error);
      
      const duration = Date.now() - startTime;
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred during KuzuDB processing',
        duration
      };
    }
  }

  public async processFiles(
    projectName: string,
    files: { path: string; content: string }[]
  ): Promise<KuzuIngestionResult> {
    const fileContents = new Map<string, string>();
    const filePaths: string[] = [];
    
    for (const file of files) {
      filePaths.push(file.path);
      fileContents.set(file.path, file.content);
    }
    
    const input: KuzuPipelineInput = {
      projectRoot: '/',
      projectName,
      filePaths,
      fileContents
    };
    
    return this.processRepository(input);
  }

  public async validateRepository(input: KuzuPipelineInput): Promise<{ valid: boolean; errors: string[] }> {
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
      
      // Check for source files (Python, JavaScript, TypeScript)
      const sourceFiles = input.filePaths.filter(path => 
        path.endsWith('.py') || 
        path.endsWith('.js') || 
        path.endsWith('.jsx') || 
        path.endsWith('.ts') || 
        path.endsWith('.tsx')
      );
      if (sourceFiles.length === 0) {
        errors.push('No source files found in the repository (Python, JavaScript, or TypeScript)');
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
      version: '2.0.0-kuzu',
      capabilities: [
        'kuzu-db-integration',
        'direct-database-insertion',
        'python-parsing',
        'javascript-parsing',
        'typescript-parsing',
        'tsx-parsing',
        'structure-analysis',
        'call-resolution',
        'ast-caching',
        'progress-reporting',
        'config-file-parsing',
        'import-resolution',
        'memory-optimization',
        'performance-monitoring'
      ]
    };
  }

  private validateInput(input: KuzuPipelineInput): void {
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

  public terminate(): void {
    // Cleanup resources if needed
    console.log('KuzuDB ingestion worker terminated');
  }
}

// Expose the worker class via Comlink
const worker = new KuzuIngestionWorker();
Comlink.expose(worker);
