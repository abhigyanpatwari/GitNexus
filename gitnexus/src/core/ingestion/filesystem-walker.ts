import { isVerboseIngestionEnabled } from './utils/verbose.js';
import { DEFAULT_MAX_FILE_SIZE_BYTES, getMaxFileSizeBytes } from './utils/max-file-size.js';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { createIgnoreFilter } from '../../config/ignore-service.js';

export interface FileEntry {
  path: string;
  content: string;
}

/** Lightweight entry — path + size from stat, no content in memory */
export interface ScannedFile {
  path: string;
  size: number;
}

/** Path-only reference (for type signatures) */
export interface FilePath {
  path: string;
}

const READ_CONCURRENCY = 32;

/**
 * Phase 1: Scan repository — stat files to get paths + sizes, no content loaded.
 * Memory: ~10MB for 100K files vs ~1GB+ with content.
 */
export const walkRepositoryPaths = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<ScannedFile[]> => {
  const ignoreFilter = await createIgnoreFilter(repoPath);
  const maxFileSizeBytes = getMaxFileSizeBytes();

  const filtered = await glob('**/*', {
    cwd: repoPath,
    nodir: true,
    dot: false,
    ignore: ignoreFilter,
  });
  const entries: ScannedFile[] = [];
  let processed = 0;
  let skippedLarge = 0;
  const skippedLargePaths: string[] = [];

  for (let start = 0; start < filtered.length; start += READ_CONCURRENCY) {
    const batch = filtered.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const stat = await fs.stat(fullPath);
        if (stat.size > maxFileSizeBytes) {
          skippedLarge++;
          skippedLargePaths.push(relativePath.replace(/\\/g, '/'));
          return null;
        }
        return { path: relativePath.replace(/\\/g, '/'), size: stat.size };
      }),
    );

    for (const result of results) {
      processed++;
      if (result.status === 'fulfilled' && result.value !== null) {
        entries.push(result.value);
        onProgress?.(processed, filtered.length, result.value.path);
      } else {
        onProgress?.(processed, filtered.length, batch[results.indexOf(result)]);
      }
    }
  }

  if (skippedLarge > 0) {
    const isDefault = maxFileSizeBytes === DEFAULT_MAX_FILE_SIZE_BYTES;
    const suffix = isDefault ? ', likely generated/vendored' : '';
    console.warn(`  Skipped ${skippedLarge} large files (>${maxFileSizeBytes / 1024}KB${suffix})`);
    if (isVerboseIngestionEnabled()) {
      for (const p of skippedLargePaths) {
        console.warn(`  - ${p}`);
      }
    }
  }

  return entries;
};

/**
 * Phase 2: Read file contents for a specific set of relative paths.
 * Returns a Map for O(1) lookup. Silently skips files that fail to read.
 */
export const readFileContents = async (
  repoPath: string,
  relativePaths: string[],
): Promise<Map<string, string>> => {
  const contents = new Map<string, string>();

  for (let start = 0; start < relativePaths.length; start += READ_CONCURRENCY) {
    const batch = relativePaths.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return { path: relativePath, content };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        contents.set(result.value.path, result.value.content);
      }
    }
  }

  return contents;
};

/**
 * Legacy API — scans and reads everything into memory.
 * Used by sequential fallback path only.
 */
export const walkRepository = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<FileEntry[]> => {
  const scanned = await walkRepositoryPaths(repoPath, onProgress);
  const contents = await readFileContents(
    repoPath,
    scanned.map((f) => f.path),
  );
  return scanned
    .filter((f) => contents.has(f.path))
    .map((f) => ({ path: f.path, content: contents.get(f.path)! }));
};
