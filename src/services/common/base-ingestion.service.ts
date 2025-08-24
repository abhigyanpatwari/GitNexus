/**
 * Base Ingestion Service
 * 
 * Abstract base class that extracts shared logic between Legacy and Next-Gen ingestion services.
 * Contains common functionality for:
 * - GitHub URL parsing and validation
 * - Repository structure discovery
 * - ZIP path normalization  
 * - Progress reporting patterns
 * - Error handling strategies
 */

import { GitHubService, type CompleteRepositoryStructure } from '../github';
import { ZipService, type CompleteZipStructure } from '../zip';

export interface BaseIngestionOptions {
  directoryFilter?: string;
  fileExtensions?: string;
  onProgress?: (message: string) => void;
}

export interface BaseIngestionResult {
  graph: any; // Will be properly typed by concrete implementations
  fileContents: Map<string, string>;
}

/**
 * Abstract base class for all ingestion services
 */
export abstract class BaseIngestionService {
  protected githubService: GitHubService;
  protected zipService: ZipService;

  constructor(githubToken?: string) {
    this.githubService = new GitHubService(githubToken);
    this.zipService = new ZipService();
  }

  /**
   * Process a GitHub repository
   * Template method that defines the common workflow
   */
  async processGitHubRepo(
    githubUrl: string, 
    options: BaseIngestionOptions = {}
  ): Promise<BaseIngestionResult> {
    const { onProgress } = options;

    // Step 1: Parse and validate GitHub URL (shared logic)
    this.validateGitHubUrl(githubUrl);
    
    onProgress?.('Discovering complete repository structure...');
    
    // Step 2: Get complete repository structure (shared logic)
    const structure: CompleteRepositoryStructure = await this.getGitHubStructure(githubUrl);
    
    onProgress?.(`Discovered ${structure.allPaths.length} paths, ${structure.fileContents.size} files. Processing...`);
    
    // Step 3: Prepare data for pipeline (shared logic)
    const projectName = this.extractProjectName(githubUrl);
    const projectRoot = structure.repositoryRoot || '';
    const filePaths = structure.allPaths;
    const fileContents = structure.fileContents;

    onProgress?.('Generating knowledge graph...');

    // Step 4: Process with engine-specific pipeline (abstract method)
    return this.processPipeline({
      projectName,
      projectRoot,
      filePaths,
      fileContents,
      onProgress
    });
  }

  /**
   * Process a ZIP file
   * Template method that defines the common workflow
   */
  async processZipFile(
    file: File,
    options: BaseIngestionOptions = {}
  ): Promise<BaseIngestionResult> {
    const { onProgress } = options;

    onProgress?.('Discovering complete ZIP structure...');

    // Step 1: Get complete ZIP structure (shared logic)
    const structure: CompleteZipStructure = await this.getZipStructure(file);
    
    // Step 2: Normalize ZIP paths (shared logic)
    const normalizedStructure = this.normalizeZipPaths(structure);
    
    onProgress?.(`Discovered ${normalizedStructure.allPaths.length} paths, ${normalizedStructure.fileContents.size} files. Processing...`);

    // Step 3: Prepare data for pipeline (shared logic)
    const projectName = file.name.replace('.zip', '');
    const projectRoot = '';
    const filePaths = normalizedStructure.allPaths;
    const fileContents = normalizedStructure.fileContents;

    onProgress?.('Generating knowledge graph...');

    // Step 4: Process with engine-specific pipeline (abstract method)
    return this.processPipeline({
      projectName,
      projectRoot,
      filePaths,
      fileContents,
      onProgress
    });
  }

  /**
   * Abstract method for engine-specific pipeline processing
   * Must be implemented by concrete classes
   */
  protected abstract processPipeline(data: {
    projectName: string;
    projectRoot: string;
    filePaths: string[];
    fileContents: Map<string, string>;
    onProgress?: (message: string) => void;
  }): Promise<BaseIngestionResult>;

  /**
   * Shared GitHub URL validation logic
   */
  protected validateGitHubUrl(githubUrl: string): void {
    const match = githubUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/);
    if (!match) {
      throw new Error('Invalid GitHub repository URL');
    }
  }

  /**
   * Shared GitHub structure discovery logic
   */
  protected async getGitHubStructure(githubUrl: string): Promise<CompleteRepositoryStructure> {
    // Extract owner/repo from URL
    const match = githubUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/);
    if (!match) {
      throw new Error('Invalid GitHub repository URL');
    }
    
    const [, owner, repo] = match;
    return await this.githubService.getCompleteRepositoryStructure(owner, repo);
  }

  /**
   * Shared ZIP structure discovery logic
   */
  protected async getZipStructure(file: File): Promise<CompleteZipStructure> {
    return await this.zipService.extractCompleteStructure(file);
  }

  /**
   * Shared project name extraction logic
   */
  protected extractProjectName(githubUrl: string): string {
    const match = githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) return 'unknown-project';
    
    const [, owner, repo] = match;
    return `${owner}/${repo}`;
  }

  /**
   * Shared ZIP path normalization logic
   * Removes common top-level folders from ZIP structures
   */
  protected normalizeZipPaths(structure: CompleteZipStructure): CompleteZipStructure {
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
    const pathsWithPrefix = paths.filter(path => path.startsWith(potentialPrefix));
    
    // If most paths (>80%) have the common prefix, normalize all paths
    if (pathsWithPrefix.length > paths.length * 0.8) {
      console.log(`Normalizing ZIP paths: removing common prefix "${potentialPrefix}" from ${pathsWithPrefix.length}/${paths.length} paths`);

      // Remove the common prefix from all paths
      const normalizedPaths = paths.map(path => {
        if (path.startsWith(potentialPrefix)) {
          const withoutPrefix = path.substring(potentialPrefix.length);
          return withoutPrefix || path; // Keep original if normalization would result in empty string
        }
        // For paths without prefix, keep as-is but filter out the bare container name
        return path === pathParts[0] ? '' : path;
      }).filter(path => path.length > 0); // Remove empty paths

      // Normalize file contents map
      const normalizedContents = new Map<string, string>();
      for (const [originalPath, content] of structure.fileContents) {
        let normalizedPath = originalPath;
        if (originalPath.startsWith(potentialPrefix)) {
          normalizedPath = originalPath.substring(potentialPrefix.length);
        } else if (originalPath === pathParts[0]) {
          // Skip the bare container directory
          continue;
        }
        
        if (normalizedPath && normalizedPath.length > 0) {
          normalizedContents.set(normalizedPath, content);
        }
      }

      return {
        allPaths: normalizedPaths,
        fileContents: normalizedContents
      };
    }

    return structure; // No normalization if prefix isn't common enough
  }
}