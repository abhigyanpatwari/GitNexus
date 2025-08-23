import JSZip from 'jszip';
import { GitHubProxyService } from './github-proxy.js';

export interface ArchiveRepositoryStructure {
  allPaths: string[];
  fileContents: Map<string, string>;
  totalFiles: number;
  totalSize: number;
  processingTime: number;
}

export interface ArchiveProgress {
  stage: 'downloading' | 'extracting' | 'processing' | 'complete';
  progress: number; // 0-100
  message: string;
  filesProcessed?: number;
  totalFiles?: number;
}

export class GitHubArchiveService {
  private static instance: GitHubArchiveService;
  private proxyService: GitHubProxyService;

  public static getInstance(): GitHubArchiveService {
    if (!GitHubArchiveService.instance) {
      GitHubArchiveService.instance = new GitHubArchiveService();
    }
    return GitHubArchiveService.instance;
  }

  private constructor() {
    this.proxyService = GitHubProxyService.getInstance();
  }

  /**
   * Download and process repository using GitHub's archive feature
   * This is much faster than individual API calls
   */
  async getRepositoryArchive(
    owner: string, 
    repo: string, 
    branch: string = 'main',
    onProgress?: (progress: ArchiveProgress) => void
  ): Promise<ArchiveRepositoryStructure> {
    const startTime = performance.now();
    
    try {
      // Stage 1: Download ZIP archive
      onProgress?.({
        stage: 'downloading',
        progress: 0,
        message: `Downloading ${owner}/${repo} archive...`
      });

      // Use proxy to bypass CORS restrictions
      const archiveUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
      const response = await this.proxyService.downloadWithProxy(archiveUrl, {
        useProxy: true,
        timeout: 60000 // 60 second timeout for archive downloads
      });
      
      if (!response.ok) {
        throw new Error(`Failed to download archive: ${response.status} ${response.statusText}`);
      }
      
      const zipBlob = await response.blob();
      const archiveSizeMB = (zipBlob.size / 1024 / 1024).toFixed(2);
      
      onProgress?.({
        stage: 'downloading',
        progress: 100,
        message: `Downloaded ${archiveSizeMB}MB archive`
      });

      // Stage 2: Extract ZIP
      onProgress?.({
        stage: 'extracting',
        progress: 0,
        message: 'Extracting archive...'
      });

      const zip = new JSZip();
      await zip.loadAsync(zipBlob);
      
      onProgress?.({
        stage: 'extracting',
        progress: 100,
        message: 'Archive extracted successfully'
      });

      // Stage 3: Process files
      onProgress?.({
        stage: 'processing',
        progress: 0,
        message: 'Processing files...'
      });

      const fileContents = new Map<string, string>();
      const allPaths: string[] = [];
      let totalSize = 0;
      
      // Get all files to process
      const filesToProcess = Object.entries(zip.files).filter(([path, file]) => 
        !file.dir && this.shouldIncludeFile(path)
      );
      
      const totalFiles = filesToProcess.length;
      
      // Process files in batches to avoid memory issues
      const batchSize = 50;
      for (let i = 0; i < filesToProcess.length; i += batchSize) {
        const batch = filesToProcess.slice(i, i + batchSize);
        
        // Process batch in parallel
        const batchPromises = batch.map(([path, file]) => 
          this.processFile(file, path, fileContents, allPaths)
        );
        
        const batchResults = await Promise.all(batchPromises);
        totalSize += batchResults.reduce((sum, size) => sum + size, 0);
        
        // Update progress
        const processed = Math.min(i + batchSize, totalFiles);
        const progress = Math.round((processed / totalFiles) * 100);
        
        onProgress?.({
          stage: 'processing',
          progress,
          message: `Processed ${processed}/${totalFiles} files`,
          filesProcessed: processed,
          totalFiles
        });
      }
      
      const endTime = performance.now();
      const processingTime = endTime - startTime;
      
      onProgress?.({
        stage: 'complete',
        progress: 100,
        message: `Completed in ${(processingTime / 1000).toFixed(2)}s`,
        filesProcessed: totalFiles,
        totalFiles
      });
      
      console.log(`Archive processing completed: ${totalFiles} files in ${(processingTime / 1000).toFixed(2)}s`);
      
      return {
        allPaths,
        fileContents,
        totalFiles,
        totalSize,
        processingTime
      };
      
    } catch (error) {
      console.error('Error downloading repository archive:', error);
      throw error;
    }
  }

  /**
   * Process individual file from ZIP
   */
  private async processFile(
    file: JSZip.JSZipObject,
    path: string,
    fileContents: Map<string, string>,
    allPaths: string[]
  ): Promise<number> {
    try {
      // Remove the repository name prefix from path
      const cleanPath = this.cleanArchivePath(path);
      
      // Skip binary files and large files
      if (this.isBinaryFile(cleanPath) || file._data.uncompressedSize > 1024 * 1024) {
        return 0;
      }
      
      const content = await file.async('string');
      fileContents.set(cleanPath, content);
      allPaths.push(cleanPath);
      
      return content.length;
      
    } catch (error) {
      console.warn(`Failed to process file ${path}:`, error);
      return 0;
    }
  }

  /**
   * Clean archive path by removing repository name prefix
   */
  private cleanArchivePath(path: string): string {
    // Archive paths look like: repo-name-main/src/file.ts
    // We want: src/file.ts
    const parts = path.split('/');
    if (parts.length > 1) {
      return parts.slice(1).join('/');
    }
    return path;
  }

  /**
   * Check if file should be included in processing
   */
  private shouldIncludeFile(path: string): boolean {
    const cleanPath = this.cleanArchivePath(path);
    
    // Skip common directories
    const skipDirs = [
      '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt',
      'coverage', '.nyc_output', '.cache', '.parcel-cache', '.vscode',
      '.idea', '.github', 'docs', 'examples', 'tests', '__tests__',
      'test', 'specs', 'spec', 'e2e', 'cypress', 'playwright'
    ];
    
    if (skipDirs.some(dir => cleanPath.includes(dir))) {
      return false;
    }
    
    // Only include source files
    const sourceExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', 
      '.h', '.hpp', '.cs', '.php', '.rb', '.go', '.rs', '.json',
      '.yaml', '.yml', '.toml', '.md', '.txt', '.xml', '.html',
      '.css', '.scss', '.sass', '.less', '.vue', '.svelte'
    ];
    
    return sourceExtensions.some(ext => cleanPath.toLowerCase().endsWith(ext));
  }

  /**
   * Check if file is binary
   */
  private isBinaryFile(path: string): boolean {
    const binaryExtensions = [
      // Images
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.bmp', '.tiff', '.webp',
      // Fonts
      '.woff', '.woff2', '.ttf', '.eot', '.otf',
      // Documents
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      // Archives
      '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.lzma',
      // Executables & Libraries
      '.exe', '.dll', '.so', '.dylib', '.class', '.pyc', '.o', '.a', '.lib', '.wasm',
      // Package formats
      '.jar', '.war', '.ear', '.deb', '.rpm', '.dmg', '.msi', '.pkg', '.apk', '.ipa',
      // Media
      '.mp4', '.mp3', '.wav', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v',
      '.aac', '.ogg', '.flac', '.m4a', '.wma'
    ];
    
    return binaryExtensions.some(ext => path.toLowerCase().endsWith(ext));
  }

  /**
   * Get available branches for a repository
   */
  async getBranches(owner: string, repo: string): Promise<string[]> {
    try {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch branches: ${response.status}`);
      }
      
      const branches = await response.json();
      return branches.map((branch: any) => branch.name);
      
    } catch (error) {
      console.error('Error fetching branches:', error);
      // Fallback to common branch names
      return ['main', 'master', 'develop'];
    }
  }

  /**
   * Check if repository exists and is accessible
   */
  async checkRepositoryAccess(owner: string, repo: string): Promise<boolean> {
    try {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Estimate repository size before downloading
   */
  async estimateRepositorySize(owner: string, repo: string): Promise<number> {
    try {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
      
      if (!response.ok) {
        return 0;
      }
      
      const repoData = await response.json();
      return repoData.size || 0; // Size in KB
      
    } catch {
      return 0;
    }
  }
}
