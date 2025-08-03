import axios, { type AxiosInstance, type AxiosResponse } from 'axios';

interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: 'file' | 'dir';
  content?: string;
  encoding?: string;
}

interface GitHubDirectory {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: 'file' | 'dir';
}

interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
}

interface GitHubError {
  message: string;
  documentation_url?: string;
}

export class GitHubService {
  private client: AxiosInstance;
  private baseURL = 'https://api.github.com';
  private rateLimitInfo: RateLimitInfo | null = null;

  constructor(token?: string) {
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        ...(token && { 'Authorization': `Bearer ${token}` })
      },
      timeout: 30000
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        this.updateRateLimitInfo(response);
        return response;
      },
      (error: { response?: AxiosResponse; message: string }) => {
        if (error.response) {
          this.updateRateLimitInfo(error.response);
          
          if (error.response.status === 403 && this.isRateLimited()) {
            const resetTime = new Date(this.rateLimitInfo!.reset * 1000);
            throw new Error(`GitHub API rate limit exceeded. Resets at ${resetTime.toISOString()}`);
          }
          
          if (error.response.status === 401) {
            throw new Error('GitHub API authentication failed. Please check your token.');
          }
          
          if (error.response.status === 404) {
            throw new Error('Repository or resource not found.');
          }
          
          const githubError: GitHubError = error.response.data;
          throw new Error(`GitHub API error: ${githubError.message}`);
        }
        
        throw new Error(`Network error: ${error.message}`);
      }
    );
  }

  private updateRateLimitInfo(response: AxiosResponse): void {
    const headers = response.headers;
    if (headers['x-ratelimit-limit']) {
      this.rateLimitInfo = {
        limit: parseInt(headers['x-ratelimit-limit'], 10),
        remaining: parseInt(headers['x-ratelimit-remaining'], 10),
        reset: parseInt(headers['x-ratelimit-reset'], 10),
        used: parseInt(headers['x-ratelimit-used'], 10)
      };
    }
  }

  private isRateLimited(): boolean {
    return this.rateLimitInfo !== null && this.rateLimitInfo.remaining === 0;
  }

  public getRateLimitInfo(): RateLimitInfo | null {
    return this.rateLimitInfo;
  }

  public async checkRateLimit(): Promise<void> {
    if (this.isRateLimited()) {
      const resetTime = new Date(this.rateLimitInfo!.reset * 1000);
      const now = new Date();
      
      if (now < resetTime) {
        const waitTime = Math.ceil((resetTime.getTime() - now.getTime()) / 1000);
        throw new Error(`Rate limit exceeded. Wait ${waitTime} seconds before making another request.`);
      }
    }
  }

  public async getRepositoryContents(
    owner: string, 
    repo: string, 
    path: string = ''
  ): Promise<(GitHubFile | GitHubDirectory)[]> {
    await this.checkRateLimit();
    
    try {
      const response = await this.client.get(`/repos/${owner}/${repo}/contents/${path}`);
      
      if (!Array.isArray(response.data)) {
        throw new Error('Expected directory contents, but received a single file.');
      }
      
      return response.data as (GitHubFile | GitHubDirectory)[];
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to fetch repository contents');
    }
  }

  public async getFileContent(
    owner: string, 
    repo: string, 
    path: string
  ): Promise<string> {
    await this.checkRateLimit();
    
    try {
      const response = await this.client.get(`/repos/${owner}/${repo}/contents/${path}`);
      const file = response.data as GitHubFile;
      
      if (file.type !== 'file') {
        throw new Error(`Path ${path} is not a file`);
      }
      
      // If content or encoding is missing, try to download directly
      if (!file.content || !file.encoding) {
        if (file.download_url) {
          console.warn(`File ${path} missing content/encoding, downloading directly`);
          return await this.downloadFileRaw(owner, repo, path);
        } else {
          throw new Error('File content, encoding, and download URL are all missing');
        }
      }
      
      if (file.encoding === 'base64') {
        try {
          return atob(file.content.replace(/\s/g, ''));
        } catch {
          throw new Error('Failed to decode base64 content');
        }
      }
      
      return file.content;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to fetch file content');
    }
  }

  public async downloadFileRaw(
    owner: string, 
    repo: string, 
    path: string
  ): Promise<string> {
    await this.checkRateLimit();
    
    try {
      const response = await this.client.get(`/repos/${owner}/${repo}/contents/${path}`);
      const file = response.data as GitHubFile;
      
      if (file.type !== 'file' || !file.download_url) {
        throw new Error(`Cannot download file: ${path}`);
      }
      
      const downloadResponse = await axios.get(file.download_url, {
        timeout: 30000
      });
      
      return downloadResponse.data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to download file');
    }
  }

  public async getAllFilesRecursively(owner: string, repo: string, path: string = ''): Promise<GitHubFile[]> {
    const files: GitHubFile[] = [];
    
    try {
      const contents = await this.getRepositoryContents(owner, repo, path);
      
      for (const item of contents) {
        if (item.type === 'dir') {
          // Skip common directories that shouldn't be processed
          if (this.shouldSkipDirectory(item.path)) {
            console.log(`Skipping directory: ${item.path}`);
            continue;
          }
          
          // Recursively get files from subdirectories
          const subFiles = await this.getAllFilesRecursively(owner, repo, item.path);
          files.push(...subFiles);
        } else if (item.type === 'file') {
          // Only include files that should be processed
          if (this.shouldIncludeFile(item.path)) {
            files.push(item);
          } else {
            console.log(`Skipping file: ${item.path}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error fetching contents for ${path}:`, error);
    }
    
    return files;
  }

  private shouldSkipDirectory(path: string): boolean {
    if (!path) return true; // Skip if path is undefined/null
    
    const skipDirs = [
      // Git version control
      '.git',
      // JavaScript dependencies (common in full-stack projects)
      'node_modules',
      // Python bytecode cache
      '__pycache__',
      // Python virtual environments
      'venv',
      'env', 
      '.venv',
      'envs',
      'virtualenv',
      // Build, distribution, and temporary directories
      'build',
      'dist', 
      'docs',
      'logs',
      'tmp',
      '.tmp',
      // Additional common directories to skip
      'coverage',
      '.coverage',
      'htmlcov',
      'vendor',
      'deps',
      '_build',
      '.gradle',
      'bin',
      'obj',
      '.vs',
      '.vscode',
      '.idea',
      'temp'
    ];
    
    // Check each directory component in the path
    const pathParts = path.split('/');
    for (const part of pathParts) {
      const dirName = part.toLowerCase();
      
      // Check for exact matches
      if (skipDirs.includes(dirName) || dirName.startsWith('.')) {
        return true;
      }
      
      // Check for .egg-info directories
      if (dirName.endsWith('.egg-info')) {
        return true;
      }
    }
    
    // Check for virtual environment patterns anywhere in the path
    const fullPathLower = path.toLowerCase();
    const venvPatterns = [
      '/.venv/',
      '/venv/',
      '/env/',
      '/.env/',
      '/envs/',
      '/virtualenv/',
      '/site-packages/',
      '/lib/python',
      '/lib64/python',
      '/scripts/',
      '/bin/python'
    ];
    
    if (venvPatterns.some(pattern => fullPathLower.includes(pattern))) {
      return true;
    }
    
    return false;
  }

  private shouldIncludeFile(path: string): boolean {
    if (!path) return false; // Skip if path is undefined/null
    
    const fileName = path.split('/').pop() || '';
    
    // Skip hidden files except specific config files
    if (fileName.startsWith('.') && !fileName.endsWith('.env.example')) {
      return false;
    }
    
    // Skip Python-specific file patterns
    const skipPatterns = [
      // Python compiled bytecode
      /\.pyc$/,
      /\.pyo$/,
      // Python extension modules (binary)
      /\.pyd$/,
      /\.so$/,
      // Python packages
      /\.egg$/,
      /\.whl$/,
      // Lock files
      /\.lock$/,
      /poetry\.lock$/,
      /Pipfile\.lock$/,
      // Editor swap files
      /\..*\.swp$/,
      /\..*\.swo$/,
      // OS metadata files
      /^Thumbs\.db$/,
      /^\.DS_Store$/,
      // General binary and archive files
      /\.zip$/,
      /\.tar$/,
      /\.rar$/,
      /\.7z$/,
      /\.gz$/,
      // Media files
      /\.(jpg|jpeg|png|gif|bmp|svg|ico)$/i,
      /\.(mp4|avi|mov|wmv|flv|webm)$/i,
      /\.(mp3|wav|flac|aac|ogg)$/i,
      // Document files
      /\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i,
      // Other binary files
      /\.(exe|dll|dylib)$/i,
      // Minified files and source maps
      /\.min\.(js|css)$/,
      /\.map$/,
      // Log and temporary files
      /\.log$/,
      /\.tmp$/,
      /\.cache$/,
      /\.pid$/,
      /\.seed$/
    ];
    
    if (skipPatterns.some(pattern => pattern.test(fileName))) {
      return false;
    }
    
    // Only include Python files and essential config files
    const extension = '.' + fileName.split('.').pop()?.toLowerCase();
    
    // Python source files
    if (extension === '.py') {
      return true;
    }
    
    // Essential Python config files
    const importantPythonFiles = [
      'pyproject.toml',
      'setup.py',
      'requirements.txt',
      'setup.cfg',
      'tox.ini',
      'pytest.ini',
      'Pipfile',
      'poetry.toml',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
      'MANIFEST.in'
    ];
    
    if (importantPythonFiles.includes(fileName)) {
      return true;
    }
    
    return false;
  }

  public getAuthenticationStatus(): { authenticated: boolean; rateLimitInfo: RateLimitInfo | null } {
    const authHeader = this.client.defaults.headers['Authorization'];
    return {
      authenticated: !!authHeader,
      rateLimitInfo: this.rateLimitInfo
    };
  }
} 
