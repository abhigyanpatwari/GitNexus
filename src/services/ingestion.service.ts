import { GitHubService, type CompleteRepositoryStructure } from './github.ts';
import { ZipService, type CompleteZipStructure } from './zip.ts';
import { getIngestionWorker } from '../lib/workerUtils.ts';
import type { KnowledgeGraph } from '../core/graph/types.ts';

export interface IngestionOptions {
  directoryFilter?: string;
  fileExtensions?: string;
  onProgress?: (message: string) => void;
}

export interface IngestionResult {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
}

export class IngestionService {
  private githubService: GitHubService;
  private zipService: ZipService;

  constructor(githubToken?: string) {
    this.githubService = new GitHubService(githubToken);
    this.zipService = new ZipService();
  }

  async processGitHubRepo(
    githubUrl: string, 
    options: IngestionOptions = {}
  ): Promise<IngestionResult> {
    const { onProgress } = options;

    // Parse GitHub URL
    const match = githubUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/);
    if (!match) {
      throw new Error('Invalid GitHub repository URL');
    }

    const [, owner, repo] = match;
    
    onProgress?.('Discovering complete repository structure...');
    
    // Get complete repository structure (all paths + file contents)
    const structure: CompleteRepositoryStructure = await this.githubService.getCompleteRepositoryStructure(owner, repo);
    
    onProgress?.(`Discovered ${structure.allPaths.length} paths, ${structure.fileContents.size} files. Processing...`);
    
    // Prepare data for pipeline
    const projectName = `${owner}/${repo}`;
    const projectRoot = '';
    
    // The pipeline now receives ALL paths (files + directories)
    // Filtering will happen during parsing, not here
    const filePaths = structure.allPaths;
    const fileContents = structure.fileContents;

    onProgress?.('Generating knowledge graph...');

    // Create worker and process
    const worker = await getIngestionWorker();
    
    try {
      const result = await worker.processRepository({
        projectName,
        projectRoot,
        filePaths,
        fileContents: fileContents
      });

      if (!result.success) {
        throw new Error(result.error || 'Processing failed');
      }

      return {
        graph: result.graph!,
        fileContents
      };
    } finally {
      // Clean up worker
      if ('terminate' in worker) {
        (worker as { terminate: () => void }).terminate();
      }
    }
  }

  async processZipFile(
    file: File,
    options: IngestionOptions = {}
  ): Promise<IngestionResult> {
    const { onProgress } = options;

    onProgress?.('Discovering complete ZIP structure...');

    // Get complete ZIP structure (all paths + file contents)
    const structure: CompleteZipStructure = await this.zipService.extractCompleteStructure(file);
    
    // Normalize ZIP paths to remove common top-level folder
    const normalizedStructure = this.normalizeZipPaths(structure);
    
    onProgress?.(`Discovered ${normalizedStructure.allPaths.length} paths, ${normalizedStructure.fileContents.size} files. Processing...`);

    // Prepare data for pipeline
    const projectName = file.name.replace('.zip', '');
    const projectRoot = '';
    
    // The pipeline now receives ALL paths (files + directories)
    // Filtering will happen during parsing, not here
    const filePaths = normalizedStructure.allPaths;
    const fileContents = normalizedStructure.fileContents;

    onProgress?.('Generating knowledge graph...');

    // Create worker and process
    const worker = await getIngestionWorker();
    
    try {
      const result = await worker.processRepository({
        projectName,
        projectRoot,
        filePaths,
        fileContents: fileContents
      });

      if (!result.success) {
        throw new Error(result.error || 'Processing failed');
      }

      return {
        graph: result.graph!,
        fileContents
      };
    } finally {
      // Clean up worker
      if ('terminate' in worker) {
        (worker as { terminate: () => void }).terminate();
      }
    }
  }

  private normalizeZipPaths(structure: CompleteZipStructure): CompleteZipStructure {
    const paths = structure.allPaths;
    
    if (paths.length === 0) {
      return structure;
    }

    // Find common prefix to remove (usually the top-level folder)
    const firstPath = paths[0];
    const pathParts = firstPath.split('/');
    
    if (pathParts.length <= 1) {
      return structure; // No normalization needed
    }

    // Check if all paths start with the same top-level folder
    const potentialPrefix = pathParts[0] + '/';
    const allHaveSamePrefix = paths.every(path => path.startsWith(potentialPrefix));
    
    if (!allHaveSamePrefix) {
      return structure; // No common prefix to remove
    }

    console.log(`Normalizing ZIP paths: removing common prefix "${potentialPrefix}"`);

    // Remove the common prefix from all paths
    const normalizedPaths = paths.map(path => {
      const withoutPrefix = path.substring(potentialPrefix.length);
      return withoutPrefix || path; // Keep original if normalization would result in empty string
    }).filter(path => path.length > 0); // Remove empty paths

    // Normalize file contents map
    const normalizedContents = new Map<string, string>();
    for (const [originalPath, content] of structure.fileContents) {
      const normalizedPath = originalPath.startsWith(potentialPrefix) 
        ? originalPath.substring(potentialPrefix.length)
        : originalPath;
      
      if (normalizedPath) {
        normalizedContents.set(normalizedPath, content);
      }
    }

    return {
      allPaths: normalizedPaths,
      fileContents: normalizedContents
    };
  }
} 