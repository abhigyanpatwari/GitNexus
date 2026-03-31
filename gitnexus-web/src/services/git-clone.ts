import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import LightningFS from "@isomorphic-git/lightning-fs";
import { shouldIgnorePath } from "../config/ignore-service";
import { FileEntry } from "./zip";

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
const HOSTED_PROXY_URL = "https://gitnexus.vercel.app/api/proxy";

/**
 * Custom HTTP client that uses a query-param based proxy
 * - In development (localhost): uses the hosted Vercel proxy for reliability
 * - In production: uses the local /api/proxy endpoint
 */
const createProxiedHttp = (): typeof http => {
  const isDev =
    typeof window !== "undefined" && window.location.hostname === "localhost";

  return {
    request: async (config) => {
      // Use hosted proxy for localhost, local proxy for production
      const proxyBase = isDev ? HOSTED_PROXY_URL : "/api/proxy";
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
 * Parse GitHub URL to extract owner and repo
 * Supports:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - github.com/owner/repo
 */
export const parseGitHubUrl = (
  url: string,
): { owner: string; repo: string } | null => {
  const cleaned = url.trim().replace(/\.git$/, "");
  const match = cleaned.match(/github\.com\/([^\/]+)\/([^\/]+)/);

  if (!match) return null;

  return {
    owner: match[1],
    repo: match[2],
  };
};

/**
 * Clone a GitHub repository using isomorphic-git
 * Returns files in the same format as extractZip for compatibility
 *
 * @param url - GitHub repository URL
 * @param onProgress - Progress callback
 * @param token - Optional GitHub PAT for private repos (stays client-side only)
 */
export const cloneRepository = async (
  url: string,
  onProgress?: (phase: string, progress: number) => void,
  token?: string,
): Promise<FileEntry[]> => {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    throw new Error(
      "Invalid GitHub URL. Use format: https://github.com/owner/repo",
    );
  }

  // Initialize fresh filesystem to avoid stale IndexedDB data
  const fsName = initFS();

  const dir = `/${parsed.repo}`;
  const repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;

  try {
    onProgress?.("cloning", 0);

    const httpClient = createProxiedHttp();

    // Clone with shallow depth for speed
    await git.clone({
      fs,
      http: httpClient,
      dir,
      url: repoUrl,
      depth: 1,
      // Auth callback for private repos (PAT stays client-side)
      onAuth: token
        ? () => ({ username: token, password: "x-oauth-basic" })
        : undefined,
      onProgress: (event) => {
        if (event.total) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress?.("cloning", percent);
        }
      },
    });

    onProgress?.("reading", 0);

    // Read all files from the cloned repo
    const files = await readAllFiles(dir, dir);

    // Cleanup: remove the cloned repo from virtual FS to save space
    await removeDirectory(dir);

    // Also try to clean up the IndexedDB database
    try {
      indexedDB.deleteDatabase(fsName);
    } catch {}

    onProgress?.("complete", 100);

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
const readAllFiles = async (
  baseDir: string,
  currentDir: string,
): Promise<FileEntry[]> => {
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
    if (entry === ".git") continue;

    const fullPath = `${currentDir}/${entry}`;
    const relativePath = fullPath.replace(`${baseDir}/`, "");

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
        const content = (await pfs.readFile(fullPath, {
          encoding: "utf8",
        })) as string;
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
