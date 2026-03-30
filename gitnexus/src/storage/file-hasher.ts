/**
 * File Hasher — per-file SHA-256 hashing for incremental scanning.
 *
 * Computes hashes for all source files in a repository, then diffs against
 * stored hashes to identify changed, added, and removed files.
 */

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

/**
 * Compute SHA-256 hashes for a list of file paths.
 * @param repoPath - Absolute path to the repository root
 * @param filePaths - Array of repo-relative file paths
 * @returns Map of relative path → SHA-256 hex digest
 */
export async function computeFileHashes(
  repoPath: string,
  filePaths: string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};

  // Process in parallel batches to avoid fd exhaustion
  const BATCH = 100;
  for (let i = 0; i < filePaths.length; i += BATCH) {
    const batch = filePaths.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (relPath) => {
        try {
          const content = await fs.readFile(path.join(repoPath, relPath));
          const hash = createHash('sha256').update(content).digest('hex');
          return { relPath, hash };
        } catch {
          // File disappeared between scan and hash — skip
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) hashes[r.relPath] = r.hash;
    }
  }

  return hashes;
}

export interface HashDiff {
  /** Files that are new or have a different hash */
  changed: string[];
  /** Files that existed before but are gone now */
  removed: string[];
  /** Total files unchanged */
  unchanged: number;
}

/**
 * Diff current file hashes against previously stored hashes.
 */
export function diffFileHashes(
  currentHashes: Record<string, string>,
  previousHashes: Record<string, string> | undefined,
): HashDiff {
  if (!previousHashes) {
    return {
      changed: Object.keys(currentHashes),
      removed: [],
      unchanged: 0,
    };
  }

  const changed: string[] = [];
  let unchanged = 0;

  for (const [file, hash] of Object.entries(currentHashes)) {
    if (previousHashes[file] !== hash) {
      changed.push(file);
    } else {
      unchanged++;
    }
  }

  const currentSet = new Set(Object.keys(currentHashes));
  const removed = Object.keys(previousHashes).filter((f) => !currentSet.has(f));

  return { changed, removed, unchanged };
}
