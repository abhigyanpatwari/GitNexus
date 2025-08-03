import { GitHubService } from './github.ts';
import { ZipService } from './zip.ts';
import { getIngestionWorker, type IngestionProgress } from '../lib/workerUtils.ts';
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
    const { directoryFilter, fileExtensions, onProgress } = options;

    // Parse GitHub URL
    const match = githubUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/);
    if (!match) {
      throw new Error('Invalid GitHub repository URL');
    }

    const [, owner, repo] = match;
    
    onProgress?.('Fetching repository structure...');
    
    // Get all files from the repository
    const allFiles = await this.githubService.getAllFilesRecursively(owner, repo);
    
    // Filter files based on options
    const filteredFiles = this.filterFiles(allFiles, directoryFilter, fileExtensions);
    
    onProgress?.(`Found ${filteredFiles.length} files. Downloading content...`);
    
    // Download file contents
    const fileContents = new Map<string, string>();
    let processedFiles = 0;
    
    for (const file of filteredFiles) {
      try {
        const content = await this.githubService.getFileContent(owner, repo, file.path);
        if (content && content.length <= 1000000) { // Skip files larger than 1MB
          fileContents.set(file.path, content);
        }
        processedFiles++;
        
        if (processedFiles % 10 === 0) {
          onProgress?.(`Downloaded ${processedFiles}/${filteredFiles.length} files...`);
        }
      } catch (error) {
        console.warn(`Failed to download ${file.path}:`, error);
      }
    }

    onProgress?.('Processing files with knowledge graph engine...');
    
    // Process with ingestion worker
    const graph = await this.processWithWorker(
      fileContents,
      `${owner}/${repo}`,
      Array.from(fileContents.keys()),
      onProgress
    );

    return { graph, fileContents };
  }

  async processZipFile(
    file: File,
    options: IngestionOptions = {}
  ): Promise<IngestionResult> {
    const { directoryFilter, fileExtensions, onProgress } = options;

    onProgress?.('Extracting ZIP file...');
    
    // Extract ZIP contents
    const allFileContents = await this.zipService.extractTextFiles(file);
    
    // Filter files based on options
    const filteredFileContents = new Map<string, string>();
    const allPaths = Array.from(allFileContents.keys());
    const filteredPaths = this.filterPaths(allPaths, directoryFilter, fileExtensions);
    
    filteredPaths.forEach(path => {
      const content = allFileContents.get(path);
      if (content) {
        filteredFileContents.set(path, content);
      }
    });

    onProgress?.(`Extracted ${filteredFileContents.size} files. Processing...`);
    
    // Process with ingestion worker
    const projectName = file.name.replace(/\.zip$/i, '');
    const graph = await this.processWithWorker(
      filteredFileContents,
      projectName,
      Array.from(filteredFileContents.keys()),
      onProgress
    );

    return { graph, fileContents: filteredFileContents };
  }

  private async processWithWorker(
    fileContents: Map<string, string>,
    projectName: string,
    filePaths: string[],
    onProgress?: (message: string) => void
  ): Promise<KnowledgeGraph> {
    const worker = getIngestionWorker();
    
    try {
      await worker.initialize();
      
      // Set up progress callback
      await worker.setProgressCallback((progress: IngestionProgress) => {
        onProgress?.(progress.message);
      });

      onProgress?.('Building knowledge graph...');
      
      // Process repository
      const result = await worker.processRepository({
        projectRoot: '/',
        projectName,
        filePaths,
        fileContents
      });

      if (!result.success || !result.graph) {
        throw new Error(result.error || 'Failed to process repository');
      }

      return result.graph;
    } catch (error) {
      throw new Error(`Processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private filterFiles(files: any[], directoryFilter?: string, fileExtensions?: string): any[] {
    let filtered = files;

    // Filter by directory
    if (directoryFilter?.trim()) {
      const dirPatterns = directoryFilter.toLowerCase().split(',').map(p => p.trim());
      filtered = filtered.filter(file => 
        dirPatterns.some(pattern => file.path.toLowerCase().includes(pattern))
      );
    }

    // Filter by file extensions
    if (fileExtensions?.trim()) {
      const extensions = fileExtensions.toLowerCase().split(',').map(ext => ext.trim());
      filtered = filtered.filter(file => 
        extensions.some(ext => file.path.toLowerCase().endsWith(ext))
      );
    }

    return filtered;
  }

  private filterPaths(paths: string[], directoryFilter?: string, fileExtensions?: string): string[] {
    let filtered = paths;

    // Filter by directory
    if (directoryFilter?.trim()) {
      const dirPatterns = directoryFilter.toLowerCase().split(',').map(p => p.trim());
      filtered = filtered.filter(path => 
        dirPatterns.some(pattern => path.toLowerCase().includes(pattern))
      );
    }

    // Filter by file extensions
    if (fileExtensions?.trim()) {
      const extensions = fileExtensions.toLowerCase().split(',').map(ext => ext.trim());
      filtered = filtered.filter(path => 
        extensions.some(ext => path.toLowerCase().endsWith(ext))
      );
    }

    return filtered;
  }
} 