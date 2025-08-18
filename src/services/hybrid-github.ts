import { GitHubService, CompleteRepositoryStructure } from './github.js';
import { GitHubOptimizedService, OptimizedProgress } from './github-optimized.js';

export interface HybridProgress {
  method: 'optimized' | 'standard';
  stage: string;
  progress: number;
  message: string;
  filesProcessed?: number;
  totalFiles?: number;
}

export interface HybridOptions {
  preferOptimized?: boolean;
  maxConcurrent?: number;
  batchSize?: number;
  enableCaching?: boolean;
  showProgress?: boolean;
}

export class HybridGitHubService {
  private static instance: HybridGitHubService;
  private githubService: GitHubService;
  private optimizedService: GitHubOptimizedService;

  private constructor() {
    this.githubService = new GitHubService();
    this.optimizedService = GitHubOptimizedService.getInstance();
  }

  public static getInstance(): HybridGitHubService {
    if (!HybridGitHubService.instance) {
      HybridGitHubService.instance = new HybridGitHubService();
    }
    return HybridGitHubService.instance;
  }

  /**
   * Get repository structure using the best available method
   */
  async getRepositoryStructure(
    owner: string,
    repo: string,
    branch: string = 'main',
    options: HybridOptions = {},
    onProgress?: (progress: HybridProgress) => void
  ): Promise<CompleteRepositoryStructure> {
    const {
      preferOptimized = true, // Use optimized by default
      maxConcurrent = 5,
      batchSize = 20,
      enableCaching = true,
      showProgress = true
    } = options;

    try {
      console.log(`Processing repository: ${owner}/${repo}`);

      // Decide which method to use (skip size estimation to avoid rate limits)
      if (preferOptimized) {
        console.log(`Using optimized method for ${owner}/${repo}`);
        return await this.getRepositoryViaOptimized(owner, repo, branch, options, onProgress);
      } else {
        console.log(`Using standard API method for ${owner}/${repo}`);
        return await this.getRepositoryViaStandard(owner, repo, onProgress);
      }

    } catch (error) {
      console.error(`Error with primary method:`, error);

      if (!preferOptimized) {
        console.log(`Falling back to optimized method for ${owner}/${repo}`);
        return await this.getRepositoryViaOptimized(owner, repo, branch, options, onProgress);
      }

      throw error;
    }
  }

  /**
   * Get repository using optimized method
   */
  private async getRepositoryViaOptimized(
    owner: string,
    repo: string,
    branch: string,
    options: HybridOptions,
    onProgress?: (progress: HybridProgress) => void
  ): Promise<CompleteRepositoryStructure> {
    const optimizedProgress = (progress: OptimizedProgress) => {
      onProgress?.({
        method: 'optimized',
        stage: progress.stage,
        progress: progress.progress,
        message: progress.message,
        filesProcessed: progress.filesProcessed,
        totalFiles: progress.totalFiles
      });
    };

    return await this.optimizedService.getRepositoryStructure(
      owner,
      repo,
      branch,
      {
        batchSize: options.batchSize,
        maxConcurrent: options.maxConcurrent,
        enableCaching: options.enableCaching
      },
      optimizedProgress
    );
  }

  /**
   * Get repository using standard API method
   */
  private async getRepositoryViaStandard(
    owner: string,
    repo: string,
    onProgress?: (progress: HybridProgress) => void
  ): Promise<CompleteRepositoryStructure> {
    onProgress?.({
      method: 'standard',
      stage: 'discovering',
      progress: 0,
      message: 'Discovering repository structure...'
    });

    const files = await this.githubService.getAllFilesRecursively(owner, repo);

    onProgress?.({
      method: 'standard',
      stage: 'downloading',
      progress: 0,
      message: `Downloading ${files.length} files...`
    });

    const fileContents = new Map<string, string>();
    const allPaths: string[] = [];

    // Download files in batches
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (file) => {
        try {
          const content = await this.githubService.getFileContent(owner, repo, file.path);
          fileContents.set(file.path, content);
          allPaths.push(file.path);
          return true;
        } catch (error) {
          console.warn(`Failed to download ${file.path}:`, error);
          return false;
        }
      });

      await Promise.all(batchPromises);

      const progress = Math.round(((i + batchSize) / files.length) * 100);
      onProgress?.({
        method: 'standard',
        stage: 'downloading',
        progress: Math.min(progress, 100),
        message: `Downloaded ${Math.min(i + batchSize, files.length)}/${files.length} files`,
        filesProcessed: Math.min(i + batchSize, files.length),
        totalFiles: files.length
      });
    }

    onProgress?.({
      method: 'standard',
      stage: 'complete',
      progress: 100,
      message: `Completed downloading ${allPaths.length} files`,
      filesProcessed: allPaths.length,
      totalFiles: files.length
    });

    return {
      allPaths,
      fileContents
    };
  }

  /**
   * Get available branches for a repository
   */
  async getBranches(owner: string, repo: string): Promise<string[]> {
    return await this.optimizedService.getBranches(owner, repo);
  }

  /**
   * Check if repository is accessible
   */
  async checkRepositoryAccess(owner: string, repo: string): Promise<boolean> {
    return await this.optimizedService.checkRepositoryAccess(owner, repo);
  }

  /**
   * Estimate repository size
   */
  async estimateRepositorySize(owner: string, repo: string): Promise<number> {
    return await this.optimizedService.estimateRepositorySize(owner, repo);
  }

  /**
   * Get performance comparison between methods
   */
  async compareMethods(owner: string, repo: string): Promise<{
    optimized: { estimatedTime: number; estimatedCalls: number };
    standard: { estimatedTime: number; estimatedCalls: number };
    recommended: 'optimized' | 'standard';
  }> {
    return await this.optimizedService.comparePerformance(owner, repo);
  }
}
