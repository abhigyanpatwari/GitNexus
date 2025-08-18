/**
 * GitHub Proxy Service
 * 
 * This service provides proxy functionality to bypass CORS restrictions
 * when downloading GitHub repository archives in browser environments.
 * 
 * Note: This requires a server-side proxy endpoint to work properly.
 */

export interface ProxyOptions {
  useProxy?: boolean;
  proxyUrl?: string;
  timeout?: number;
}

export class GitHubProxyService {
  private static instance: GitHubProxyService;
  private defaultProxyUrl: string = 'https://api.allorigins.win/raw?url=';

  public static getInstance(): GitHubProxyService {
    if (!GitHubProxyService.instance) {
      GitHubProxyService.instance = new GitHubProxyService();
    }
    return GitHubProxyService.instance;
  }

  /**
   * Download a file through a CORS proxy
   */
  async downloadWithProxy(
    url: string,
    options: ProxyOptions = {}
  ): Promise<Response> {
    const {
      useProxy = true,
      proxyUrl = this.defaultProxyUrl,
      timeout = 30000
    } = options;

    if (!useProxy) {
      // Try direct download (will likely fail due to CORS)
      return await fetch(url);
    }

    const proxyFullUrl = `${proxyUrl}${encodeURIComponent(url)}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(proxyFullUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'GitNexus/1.0'
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Proxy request failed: ${response.status} ${response.statusText}`);
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Check if archive download is available
   */
  async checkArchiveAvailability(owner: string, repo: string, branch: string = 'main'): Promise<boolean> {
    const archiveUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
    
    try {
      const response = await this.downloadWithProxy(archiveUrl, {
        useProxy: true,
        timeout: 5000 // Short timeout for availability check
      });
      
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get available proxy services
   */
  getAvailableProxies(): Array<{ name: string; url: string; description: string }> {
    return [
      {
        name: 'AllOrigins',
        url: 'https://api.allorigins.win/raw?url=',
        description: 'Free CORS proxy service'
      },
      {
        name: 'CORS Anywhere',
        url: 'https://cors-anywhere.herokuapp.com/',
        description: 'Popular CORS proxy (requires activation)'
      },
      {
        name: 'CORS Proxy',
        url: 'https://corsproxy.io/?',
        description: 'Simple CORS proxy'
      }
    ];
  }

  /**
   * Test proxy connectivity
   */
  async testProxy(proxyUrl?: string): Promise<boolean> {
    const testUrl = 'https://httpbin.org/status/200';
    
    try {
      const response = await this.downloadWithProxy(testUrl, {
        useProxy: true,
        proxyUrl,
        timeout: 10000
      });
      
      return response.ok;
    } catch {
      return false;
    }
  }
}
