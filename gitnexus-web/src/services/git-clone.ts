import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import LightningFS from '@isomorphic-git/lightning-fs';
import { canUseHostedGitProxy } from '../../api/proxy-utils';
import { shouldIgnorePath } from '../config/ignore-service';
import { FileEntry } from './zip';

// Initialize virtual filesystem (persists in IndexedDB)
// Use a unique name each time to avoid stale data issues
let fs: LightningFS;
let pfs: any;

const initFS = () => {
  // Create a fresh filesystem instance
  const fsName = `gitnexus-git-${Date.now()}`;
  fs = new LightningFS(fsName);
  pfs = fs.promises;
  return fsName;
};

// Hosted proxy URL - use this for localhost to avoid local proxy issues
const HOSTED_PROXY_URL = 'https://gitnexus.vercel.app/api/proxy';

export type GitAuthMode = 'auto' | 'github' | 'gitlab' | 'basic';

interface ParsedRepositoryUrl {
  cloneUrl: string;
  repoName: string;
  host: string;
  inferredAuthMode: Exclude<GitAuthMode, 'auto'> | null;
}

const SSH_REPOSITORY_URL_PATTERN = /^(?:ssh:\/\/|git@[^:]+:)/i;
const GITLAB_REPOSITORY_PAGE_SEGMENTS = new Set([
  'tree',
  'blob',
  'commit',
  'commits',
  'compare',
  'merge_requests',
  'issues',
  'wikis',
  'snippets',
  'pipelines',
  'tags',
  'branches',
  'releases',
]);

const inferGitAuthMode = (host: string): Exclude<GitAuthMode, 'auto'> | null => {
  const normalizedHost = host.toLowerCase();

  if (normalizedHost === 'github.com' || normalizedHost.endsWith('.github.com')) {
    return 'github';
  }

  if (
    normalizedHost === 'gitlab.com' ||
    normalizedHost.endsWith('.gitlab.com') ||
    normalizedHost.startsWith('gitlab.')
  ) {
    return 'gitlab';
  }

  return null;
};

export const isSshRepositoryUrl = (url: string): boolean =>
  SSH_REPOSITORY_URL_PATTERN.test(url.trim());

const getRepositoryPathSegments = (parsedUrl: URL): string[] | null => {
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const gitSuffixIndex = segments.findIndex((segment) => segment.toLowerCase().endsWith('.git'));
  if (gitSuffixIndex >= 1) {
    return segments.slice(0, gitSuffixIndex + 1);
  }

  const inferredAuthMode = inferGitAuthMode(parsedUrl.hostname);
  if (inferredAuthMode === 'github') {
    return segments.slice(0, 2);
  }

  const gitLabRouteSeparatorIndex = segments.indexOf('-');
  if (gitLabRouteSeparatorIndex >= 2) {
    return segments.slice(0, gitLabRouteSeparatorIndex);
  }

  if (inferredAuthMode === 'gitlab') {
    const pageSegmentIndex = segments.findIndex(
      (segment, index) =>
        index >= 2 && GITLAB_REPOSITORY_PAGE_SEGMENTS.has(segment.toLowerCase())
    );

    if (pageSegmentIndex >= 2) {
      return segments.slice(0, pageSegmentIndex);
    }
  }

  return segments;
};

const selectProxyBase = (targetUrl: string): string => {
  const isDev = typeof window !== 'undefined' && window.location.hostname === 'localhost';
  if (!isDev) return '/api/proxy';
  return canUseHostedGitProxy(targetUrl) ? HOSTED_PROXY_URL : '/api/proxy';
};

/**
 * Custom HTTP client that uses a query-param based proxy
 * - In development (localhost): uses the hosted Vercel proxy for reliability
 * - In production: uses the local /api/proxy endpoint
 */
const createProxiedHttp = (targetUrl: string): typeof http => {
  const proxyBase = selectProxyBase(targetUrl);

  return {
    request: async (config) => {
      const proxyUrl = `${proxyBase}?url=${encodeURIComponent(config.url)}`;
      
      // Call the original http.request with the proxied URL
      return http.request({
        ...config,
        url: proxyUrl,
      });
    },
  };
};

/**
 * Parse a Git repository URL to extract the clone URL and repo name.
 * Supports: 
 *   - https://github.com/owner/repo
 *   - https://gitlab.com/group/subgroup/repo
 *   - https://gitlab.company.com/group/repo.git
 *   - host/group/repo
 */
export const parseRepositoryUrl = (url: string): ParsedRepositoryUrl | null => {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (isSshRepositoryUrl(trimmed)) return null;

  const candidate = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return null;
  }

  const segments = getRepositoryPathSegments(parsedUrl);
  if (!segments) {
    return null;
  }

  const repoSegment = segments[segments.length - 1];
  const repoName = repoSegment.replace(/\.git$/, '');
  if (!repoName) {
    return null;
  }

  const normalizedPath = `/${segments.join('/')}${repoSegment.endsWith('.git') ? '' : '.git'}`;

  return {
    cloneUrl: `${parsedUrl.origin}${normalizedPath}`,
    repoName,
    host: parsedUrl.hostname.toLowerCase(),
    inferredAuthMode: inferGitAuthMode(parsedUrl.hostname),
  };
};

// Backwards-compatible alias for older callers.
export const parseGitHubUrl = parseRepositoryUrl;

const createAuthCallback = (
  token: string | undefined,
  authMode: GitAuthMode,
  parsedRepoUrl: ParsedRepositoryUrl,
  username?: string
) => {
  if (!token) return undefined;

  const normalizedUsername = username?.trim();

  if (authMode === 'basic') {
    if (!normalizedUsername) {
      throw new Error('Username is required for custom username + token auth.');
    }

    return () => ({ username: normalizedUsername, password: token });
  }

  const resolvedAuthMode =
    authMode === 'auto' ? parsedRepoUrl.inferredAuthMode : authMode;

  if (!resolvedAuthMode) {
    throw new Error('Select GitHub, GitLab, or custom username + token auth for private repositories on custom hosts.');
  }

  if (resolvedAuthMode === 'gitlab') {
    return () => ({ username: normalizedUsername || 'oauth2', password: token });
  }

  if (normalizedUsername) {
    return () => ({ username: normalizedUsername, password: token });
  }

  return () => ({ username: token, password: 'x-oauth-basic' });
};

/**
 * Clone a Git repository using isomorphic-git
 * Returns files in the same format as extractZip for compatibility
 * 
 * @param url - Git repository URL
 * @param onProgress - Progress callback
 * @param token - Optional access token for private repos
 * @param authMode - Auth strategy for token-based clones
 */
export const cloneRepository = async (
  url: string,
  onProgress?: (phase: string, progress: number) => void,
  token?: string,
  authMode: GitAuthMode = 'auto',
  username?: string
): Promise<FileEntry[]> => {
  if (isSshRepositoryUrl(url)) {
    throw new Error('SSH URLs are not supported. Use the HTTPS clone URL.');
  }

  const parsed = parseRepositoryUrl(url);
  if (!parsed) {
    throw new Error('Invalid repository URL. Use an HTTPS GitHub, GitLab, or self-hosted GitLab URL.');
  }

  // Initialize fresh filesystem to avoid stale IndexedDB data
  const fsName = initFS();
  
  const dir = `/${parsed.repoName}`;
  const authCallback = createAuthCallback(token, authMode, parsed, username);

  try {
    onProgress?.('cloning', 0);

    const httpClient = createProxiedHttp(parsed.cloneUrl);
    
    // Clone with shallow depth for speed
    await git.clone({
      fs,
      http: httpClient,
      dir,
      url: parsed.cloneUrl,
      depth: 1,
      onAuth: authCallback,
      onProgress: (event) => {
        if (event.total) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress?.('cloning', percent);
        }
      },
    });

    onProgress?.('reading', 0);

    // Read all files from the cloned repo
    const files = await readAllFiles(dir, dir);

    // Cleanup: remove the cloned repo from virtual FS to save space
    await removeDirectory(dir);
    
    // Also try to clean up the IndexedDB database
    try {
      indexedDB.deleteDatabase(fsName);
    } catch {}

    onProgress?.('complete', 100);

    return files;
  } catch (error) {
    // Cleanup on error
    try {
      await removeDirectory(dir);
      indexedDB.deleteDatabase(fsName);
    } catch {}
    
    throw error;
  }
};

/**
 * Recursively read all files from a directory in the virtual filesystem
 */
const readAllFiles = async (baseDir: string, currentDir: string): Promise<FileEntry[]> => {
  const files: FileEntry[] = [];
  
  let entries: string[];
  try {
    entries = await pfs.readdir(currentDir);
  } catch (err) {
    // Directory might not exist or be inaccessible
    console.warn(`Cannot read directory: ${currentDir}`);
    return files;
  }

  for (const entry of entries) {
    // Skip .git directory
    if (entry === '.git') continue;

    const fullPath = `${currentDir}/${entry}`;
    const relativePath = fullPath.replace(`${baseDir}/`, '');

    // Check ignore rules
    if (shouldIgnorePath(relativePath)) continue;

    // Try to stat the file - skip if it fails (broken symlinks, etc.)
    let stat;
    try {
      stat = await pfs.stat(fullPath);
    } catch {
      // Skip files that can't be stat'd (broken symlinks, permission issues)
      if (import.meta.env.DEV) {
        console.warn(`Skipping unreadable entry: ${relativePath}`);
      }
      continue;
    }

    if (stat.isDirectory()) {
      // Recurse into subdirectory
      const subFiles = await readAllFiles(baseDir, fullPath);
      files.push(...subFiles);
    } else {
      // Read file content
      try {
        const content = await pfs.readFile(fullPath, { encoding: 'utf8' }) as string;
        files.push({
          path: relativePath,
          content,
        });
      } catch {
        // Skip binary files or files that can't be read as text
      }
    }
  }

  return files;
};

/**
 * Recursively remove a directory from the virtual filesystem
 */
const removeDirectory = async (dir: string): Promise<void> => {
  try {
    const entries = await pfs.readdir(dir);
    
    for (const entry of entries) {
      const fullPath = `${dir}/${entry}`;
      const stat = await pfs.stat(fullPath);
      
      if (stat.isDirectory()) {
        await removeDirectory(fullPath);
      } else {
        await pfs.unlink(fullPath);
      }
    }
    
    await pfs.rmdir(dir);
  } catch {
    // Ignore errors during cleanup
  }
};

