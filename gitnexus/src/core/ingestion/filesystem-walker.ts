import { isVerboseIngestionEnabled } from './utils/verbose.js';
import { DEFAULT_MAX_FILE_SIZE_BYTES, getMaxFileSizeBytes } from './utils/max-file-size.js';
import {
  getIncludeDotDirs,
  indexableGlobPatterns,
  normalizeIncludeDotDirs,
  dotDirectoryIgnoreFilter,
  filterDotDirectorySymlinks,
} from './utils/include-dot-dirs.js';
import fs from 'fs/promises';
import { readdir } from 'node:fs';
import path from 'path';
import { glob, globIterate } from 'glob';
import { createIgnoreFilter } from '../../config/ignore-service.js';
import { mapConcurrent } from '../../lib/utils.js';

import { logger } from '../logger.js';

/** Lightweight entry — path + size from stat, no content in memory */
export interface ScannedFile {
  path: string;
  size: number;
}

/** Path-only reference (for type signatures) */
export interface FilePath {
  path: string;
}

export const READ_CONCURRENCY = 32;
const ANALYZE_PROGRESS_ACTIVE_ENV = 'GITNEXUS_ANALYZE_PROGRESS_ACTIVE';

const DECLARATION_COMPANION_SUFFIXES = [
  { declaration: '.d.ts', implementations: ['.ts', '.tsx'] },
  { declaration: '.d.mts', implementations: ['.mts'] },
  { declaration: '.d.cts', implementations: ['.cts'] },
] as const;

const hasImplementationSibling = (
  declarationPath: string,
  scannedPaths: ReadonlySet<string>,
): boolean => {
  const companion = DECLARATION_COMPANION_SUFFIXES.find(({ declaration }) =>
    declarationPath.endsWith(declaration),
  );
  if (!companion) return false;

  // Keep standalone declarations. Only suppress declaration output that sits
  // beside an implementation with the corresponding module suffix.
  const stem = declarationPath.slice(0, -companion.declaration.length);
  return companion.implementations.some((suffix) => scannedPaths.has(`${stem}${suffix}`));
};

const warnLargeFileSkip = (message: string): void => {
  if (process.env[ANALYZE_PROGRESS_ACTIVE_ENV] === '1') {
    // analyze.ts routes console.warn through the progress bar logger while
    // the bar is active. Emitting the operator-facing large-file notice there
    // avoids raw pino NDJSON corrupting the one-line progress display in the
    // heap-respawn child, whose stderr is intentionally piped for crash
    // classification.
    // eslint-disable-next-line no-console -- intentionally routed by analyze progress UI
    console.warn(message);
    return;
  }
  logger.warn(message);
};

export interface WalkRepositoryOptions {
  /** Capture required metadata before stat/size filtering can omit its inputs. */
  onPathsDiscovered?: (paths: readonly string[]) => Promise<void>;
  /**
   * Suppress the operator-facing large-file notice. Set by read-only callers
   * such as `status`, which reuse this scan purely to learn which files the
   * index covers and must not emit analyze's progress commentary.
   */
  quiet?: boolean;
  /**
   * Override the large-file cap. `status` replays the bytes recorded at
   * analyze time so `--max-file-size` / `GITNEXUS_MAX_FILE_SIZE` cannot
   * silently drop a file that the index actually covers.
   */
  maxFileSizeBytes?: number;
  /**
   * Dot directories to index besides the default non-hidden file set, e.g.
   * `['.scallywag']`. Defaults to `GITNEXUS_INCLUDE_DOT_DIRS`. `status` replays
   * the list recorded at analyze time, for the same reason as
   * `maxFileSizeBytes`. Hidden files and other dot directories inside a listed
   * directory stay excluded, and ignore rules still apply.
   */
  includeDotDirs?: readonly string[];
}

/**
 * Phase 1: Scan repository — capture required metadata, then stat paths + sizes.
 * Memory: ~10MB for 100K files vs ~1GB+ with content.
 */
const assertWalkRootIsDirectory = async (repoPath: string): Promise<void> => {
  let st;
  try {
    st = await fs.stat(repoPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`walkRepositoryPaths: path does not exist: ${repoPath}`);
    }
    throw err;
  }
  if (!st.isDirectory()) {
    throw new Error(`walkRepositoryPaths: not a directory: ${repoPath}`);
  }
};

export const walkRepositoryPaths = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
  options: WalkRepositoryOptions = {},
): Promise<ScannedFile[]> => {
  await assertWalkRootIsDirectory(repoPath);
  const ignoreFilter = await createIgnoreFilter(repoPath);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? getMaxFileSizeBytes();
  const includeDotDirs = normalizeIncludeDotDirs(options.includeDotDirs ?? getIncludeDotDirs());
  let enumerationError: NodeJS.ErrnoException | undefined;

  const patterns = indexableGlobPatterns(includeDotDirs);
  // A listed dot directory may be absent from this repo; glob still reads its
  // root-level pattern, and that ENOENT means "no files", not lost metadata.
  const optionalRoots = new Set(includeDotDirs.map((dir) => path.resolve(repoPath, dir)));
  const isAbsentListedRoot = (directory: unknown, error: NodeJS.ErrnoException): boolean =>
    (error.code === 'ENOENT' && optionalRoots.has(path.resolve(repoPath, String(directory)))) ||
    // A dotfile can share a listed directory's name. Glob probes it as a
    // directory; ENOTDIR means no matching subtree, not an unreadable one.
    (error.code === 'ENOTDIR' && includeDotDirs.includes(path.basename(String(directory))));

  const candidates = (
    await glob(patterns, {
      cwd: repoPath,
      nodir: true,
      dot: false,
      ignore: includeDotDirs.length > 0 ? dotDirectoryIgnoreFilter(ignoreFilter) : ignoreFilter,
      // glob treats unreadable directories as empty. Required metadata must
      // not silently lose declarations, so retain the first enumeration error.
      fs:
        options.onPathsDiscovered === undefined
          ? undefined
          : {
              readdir(directory, readOptions, callback) {
                readdir(directory, readOptions, (error, entries) => {
                  if (error && !isAbsentListedRoot(directory, error)) enumerationError ??= error;
                  callback(error, entries);
                });
              },
            },
    })
  ).map((filePath) => filePath.replace(/\\/g, '/'));
  if (enumerationError !== undefined) throw enumerationError;
  const filtered =
    includeDotDirs.length > 0 ? await filterDotDirectorySymlinks(repoPath, candidates) : candidates;
  await options.onPathsDiscovered?.(filtered);
  const entries: ScannedFile[] = [];
  let processed = 0;
  let skippedLarge = 0;
  const skippedLargePaths: string[] = [];
  let skippedNonRegular = 0;
  const skippedNonRegularPreview: string[] = [];

  for (let start = 0; start < filtered.length; start += READ_CONCURRENCY) {
    const batch = filtered.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const stat = await fs.stat(fullPath);
        // glob's nodir still returns symlinks to directories. Follow the same
        // target that hashing reads, retaining file symlinks but no directories
        // or special files that cannot belong to the indexed coverage set.
        if (!stat.isFile()) {
          skippedNonRegular++;
          if (skippedNonRegularPreview.length < 5) skippedNonRegularPreview.push(relativePath);
          return null;
        }
        if (stat.size > maxFileSizeBytes) {
          skippedLarge++;
          skippedLargePaths.push(relativePath);
          return null;
        }
        return { path: relativePath, size: stat.size };
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

  const scannedPaths = new Set(entries.map((entry) => entry.path));
  const deduplicatedEntries = entries.filter(
    (entry) => !hasImplementationSibling(entry.path, scannedPaths),
  );

  // Filesystem/glob traversal order is not stable across filesystems or repeated
  // scans. Canonicalize once at the scan boundary so every downstream phase sees
  // the same repository order.
  deduplicatedEntries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  if (skippedNonRegular > 0 && !options.quiet) {
    warnLargeFileSkip(
      `  Skipped ${skippedNonRegular} non-regular entries (directory symlinks and special files are not indexed): ` +
        skippedNonRegularPreview.sort().join(', ') +
        (skippedNonRegular > 5 ? ', ...' : ''),
    );
  }

  if (skippedLarge > 0 && !options.quiet) {
    const isDefault = maxFileSizeBytes === DEFAULT_MAX_FILE_SIZE_BYTES;
    const isOverrideUnset = !process.env.GITNEXUS_MAX_FILE_SIZE;
    const suffix = isDefault ? ', likely generated/vendored' : '';
    warnLargeFileSkip(
      `  Skipped ${skippedLarge} large files (>${maxFileSizeBytes / 1024}KB${suffix})`,
    );

    // Always show at least the first few paths so users can diagnose why
    // edges are missing from a specific file (issue #1659). The full list is
    // gated behind GITNEXUS_VERBOSE=1 to avoid flooding output on repos with
    // many generated/vendored blobs. Sort before slicing so the preview is
    // stable across runs (fs.stat callbacks race within each batch).
    skippedLargePaths.sort();
    const SKIPPED_PREVIEW_CAP = 5;
    const showAll = isVerboseIngestionEnabled() || skippedLargePaths.length <= SKIPPED_PREVIEW_CAP;
    const preview = showAll ? skippedLargePaths : skippedLargePaths.slice(0, SKIPPED_PREVIEW_CAP);
    for (const p of preview) {
      warnLargeFileSkip(`  - ${p}`);
    }
    if (!showAll) {
      const remaining = skippedLargePaths.length - SKIPPED_PREVIEW_CAP;
      warnLargeFileSkip(`  ...and ${remaining} more (set GITNEXUS_VERBOSE=1 to list them all)`);
    }
    // Only hint about the env var when the user has not set it at all. An
    // explicit GITNEXUS_MAX_FILE_SIZE=512 happens to resolve to the same
    // bytes as the default but the operator clearly already knows the knob.
    if (isDefault && isOverrideUnset) {
      warnLargeFileSkip(
        `  Set GITNEXUS_MAX_FILE_SIZE=<KB> to include files above the default cap.`,
      );
    }
  }

  return deduplicatedEntries;
};

/**
 * Count the paths `walkRepositoryPaths` would scan, with the same patterns and
 * ignore rules, and stop as soon as the count passes `limit`. Nothing is
 * stat-ed, so large files, non-regular entries and declaration siblings are
 * not subtracted: the result is an upper bound on what analyze indexes. Used
 * to refuse an expensive rebuild before it starts (#3524).
 */
export const countScanCandidates = async (
  repoPath: string,
  limit: number,
  options: Pick<WalkRepositoryOptions, 'includeDotDirs'> = {},
): Promise<number> => {
  await assertWalkRootIsDirectory(repoPath);
  const ignoreFilter = await createIgnoreFilter(repoPath);
  const includeDotDirs = normalizeIncludeDotDirs(options.includeDotDirs ?? getIncludeDotDirs());
  let count = 0;
  for await (const _ of globIterate(indexableGlobPatterns(includeDotDirs), {
    cwd: repoPath,
    nodir: true,
    dot: false,
    ignore: includeDotDirs.length > 0 ? dotDirectoryIgnoreFilter(ignoreFilter) : ignoreFilter,
  })) {
    if (++count > limit) break;
  }
  return count;
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

  const results = await mapConcurrent(
    relativePaths,
    async (relativePath) => {
      const fullPath = path.join(repoPath, relativePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return { path: relativePath, content };
    },
    { concurrency: READ_CONCURRENCY },
  );

  // An unreadable file yields `undefined` (mapConcurrent's per-item degrade) and
  // is skipped, exactly as the previous allSettled/`status === 'fulfilled'` shape
  // did — no `onError`, so the skip stays silent per this function's contract.
  for (const result of results) {
    if (result) contents.set(result.path, result.content);
  }

  return contents;
};
