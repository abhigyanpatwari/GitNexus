// @ts-expect-error - npm: imports are resolved at runtime in Deno
import axios, { type AxiosInstance, type AxiosResponse } from 'npm:axios';

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
        'User-Agent': 'GitNexus/1.0',
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
      
      if (!file.content || !file.encoding) {
        throw new Error('File content or encoding information missing');
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
        timeout: 30000,
        headers: {
          'User-Agent': 'GitNexus/1.0'
        }
      });
      
      return downloadResponse.data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to download file');
    }
  }

  public async getAllFilesRecursively(
    owner: string, 
    repo: string, 
    path: string = ''
  ): Promise<GitHubFile[]> {
    const allFiles: GitHubFile[] = [];
    const items = await this.getRepositoryContents(owner, repo, path);
    
    for (const item of items) {
      if (item.type === 'file') {
        allFiles.push(item as GitHubFile);
      } else if (item.type === 'dir') {
        const subFiles = await this.getAllFilesRecursively(owner, repo, item.path);
        allFiles.push(...subFiles);
      }
    }
    
    return allFiles;
  }

  public getAuthenticationStatus(): { authenticated: boolean; rateLimitInfo: RateLimitInfo | null } {
    const authHeader = this.client.defaults.headers['Authorization'];
    return {
      authenticated: !!authHeader,
      rateLimitInfo: this.rateLimitInfo
    };
  }
} 