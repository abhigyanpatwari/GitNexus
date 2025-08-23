import { GitHubService, type CompleteRepositoryStructure } from './github';
import { ZipService, type CompleteZipStructure } from './zip';
import type { KuzuKnowledgeGraphInterface } from '../core/graph/types';

export interface KuzuIngestionOptions {
  directoryFilter?: string;
  fileExtensions?: string;
  onProgress?: (message: string) => void;
}

export interface KuzuIngestionResult {
  graph: KuzuKnowledgeGraphInterface;
  fileContents: Map<string, string>;
}

/**
 * KuzuDB Ingestion Service - Direct Database Integration
 * 
 * Processes repositories and directly inserts data into KuzuDB,
 * eliminating the need for JSON storage and conversion steps.
 */
export class KuzuIngestionService {
  private githubService: GitHubService;
  private zipService: ZipService;

  constructor(githubToken?: string) {
    this.githubService = new GitHubService(githubToken);
    this.zipService = new ZipService();
  }

  async processGitHubRepo(
    githubUrl: string, 
    options: KuzuIngestionOptions = {}
  ): Promise<KuzuIngestionResult> {
    
    const { onProgress } = options;

    onProgress?.('Discovering complete repository structure...');

    // Get complete repository structure (all paths + file contents)
    const structure: CompleteRepositoryStructure = await this.githubService.getCompleteRepositoryStructure(githubUrl);
    
    onProgress?.(`Discovered ${structure.allPaths.length} paths, ${structure.fileContents.size} files. Processing with KuzuDB...`);

    // Prepare data for KuzuDB pipeline
    const projectName = this.extractProjectName(githubUrl);
    const projectRoot = structure.repositoryRoot || '';
    
    // The pipeline now receives ALL paths (files + directories)
    // Filtering will happen during parsing, not here
    const filePaths = structure.allPaths;
    const fileContents = structure.fileContents;

    onProgress?.('Generating knowledge graph with direct KuzuDB integration...');

    // Process directly in the main thread instead of using a worker
    // This avoids serialization issues with KuzuDB objects
    const { KuzuGraphPipeline } = await import('../core/ingestion/kuzu-pipeline');
    const pipeline = new KuzuGraphPipeline();
    
    try {
      console.log('🔍🔍🔍 INGESTION DEBUG: About to run pipeline...');
      const graph = await pipeline.run({
        projectName,
        projectRoot,
        filePaths,
        fileContents: fileContents
      });

      // EXTENSIVE DEBUG: Log what pipeline returned
      console.log('🔍🔍🔍 INGESTION DEBUG: Pipeline completed, analyzing result:');
      console.log('🔍 INGESTION DEBUG: Graph type:', typeof graph);
      console.log('🔍 INGESTION DEBUG: Graph has nodes:', 'nodes' in graph);
      console.log('🔍 INGESTION DEBUG: Graph has relationships:', 'relationships' in graph);
      console.log('🔍 INGESTION DEBUG: Graph nodes count:', graph.nodes?.length || 'undefined');
      console.log('🔍 INGESTION DEBUG: Graph relationships count:', graph.relationships?.length || 'undefined');

      // Check if it's a KuzuKnowledgeGraph vs SimpleKnowledgeGraph
      console.log('🔍 INGESTION DEBUG: Has getNodeCount method:', 'getNodeCount' in graph);
      console.log('🔍 INGESTION DEBUG: Has getRelationshipCount method:', 'getRelationshipCount' in graph);

      if ('getNodeCount' in graph && typeof graph.getNodeCount === 'function') {
              // console.log('🔍 INGESTION DEBUG: KuzuKnowledgeGraph node count:', graph.getNodeCount());
      // console.log('🔍 INGESTION DEBUG: KuzuKnowledgeGraph relationship count:', graph.getRelationshipCount());
      }

      return {
        graph,
        fileContents
      };
    } finally {
      // Clean up pipeline
      await pipeline.cleanup();
    }
  }

  async processZipFile(
    file: File,
    options: KuzuIngestionOptions = {}
  ): Promise<KuzuIngestionResult> {
    const { onProgress } = options;

    onProgress?.('Discovering complete ZIP structure...');

    // Get complete ZIP structure (all paths + file contents)
    const structure: CompleteZipStructure = await this.zipService.extractCompleteStructure(file);
    
    // Normalize ZIP paths to remove common top-level folder
    const normalizedStructure = this.normalizeZipPaths(structure);
    
    onProgress?.(`Discovered ${normalizedStructure.allPaths.length} paths, ${normalizedStructure.fileContents.size} files. Processing with KuzuDB...`);

    // Prepare data for KuzuDB pipeline
    const projectName = file.name.replace('.zip', '');
    const projectRoot = '';
    
    // The pipeline now receives ALL paths (files + directories)
    // Filtering will happen during parsing, not here
    const filePaths = normalizedStructure.allPaths;
    const fileContents = normalizedStructure.fileContents;

    onProgress?.('Generating knowledge graph with direct KuzuDB integration...');

    // Process directly in the main thread instead of using a worker
    // This avoids serialization issues with KuzuDB objects
    const { KuzuGraphPipeline } = await import('../core/ingestion/kuzu-pipeline');
    const pipeline = new KuzuGraphPipeline();
    
    try {
      const graph = await pipeline.run({
        projectName,
        projectRoot,
        filePaths,
        fileContents: fileContents
      });

      return {
        graph,
        fileContents
      };
    } finally {
      // Clean up pipeline
      await pipeline.cleanup();
    }
  }

  private normalizeZipPaths(structure: CompleteZipStructure): CompleteZipStructure {
    // Find common top-level folder
    const allPaths = structure.allPaths;
    if (allPaths.length === 0) return structure;

    // Get all top-level entries
    const topLevelEntries = allPaths
      .filter(path => !path.includes('/') || path.endsWith('/'))
      .map(path => path.replace(/\/$/, ''));

    // If there's only one top-level folder and it contains most files, remove it
    if (topLevelEntries.length === 1) {
      const topFolder = topLevelEntries[0];
      const filesInTopFolder = allPaths.filter(path => path.startsWith(topFolder + '/'));
      
      // If most files are in the top folder, normalize by removing it
      if (filesInTopFolder.length > allPaths.length * 0.8) {
        const normalizedPaths = allPaths.map(path => {
          if (path.startsWith(topFolder + '/')) {
            return path.substring(topFolder.length + 1);
          }
          return path === topFolder ? '' : path;
        }).filter(path => path.length > 0);

        const normalizedContents = new Map<string, string>();
        for (const [originalPath, content] of structure.fileContents.entries()) {
          if (originalPath.startsWith(topFolder + '/')) {
            const normalizedPath = originalPath.substring(topFolder.length + 1);
            normalizedContents.set(normalizedPath, content);
          } else if (originalPath !== topFolder) {
            normalizedContents.set(originalPath, content);
          }
        }

        return {
          allPaths: normalizedPaths,
          fileContents: normalizedContents
        };
      }
    }

    return structure;
  }

  private extractProjectName(githubUrl: string): string {
    // Extract project name from GitHub URL
    const match = githubUrl.match(/github\.com\/[^\/]+\/([^\/]+)/);
    return match ? match[1] : 'unknown-project';
  }


}
