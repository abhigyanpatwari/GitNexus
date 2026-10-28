import { logger } from '../../logger.js';

/**
 * Directory names that must never be indexed, even when listed. These hold
 * version-control internals, not source.
 */
const REFUSED_DOT_DIRS = new Set(['.git', '.svn', '.hg', '.bzr']);

/** A single path segment: a leading "." followed by letters, digits, ".", "_" or "-". */
const DOT_DIR_NAME = /^\.[A-Za-z0-9._-]+$/;

const warned = new Set<string>();

const warnOnce = (key: string, message: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
};

/**
 * Validate a list of dot-directory names to index. Each entry must be a single
 * path segment that starts with "." (e.g. ".scallywag", ".github"). Version
 * control directories are refused. Invalid entries are dropped with a one-time
 * warning. The result is deduplicated and sorted so it can be recorded in the
 * index coverage policy and compared later.
 */
export const normalizeIncludeDotDirs = (entries: readonly string[]): string[] => {
  const accepted = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim().replace(/\/+$/, '');
    if (entry === '') continue;
    // Plain characters only: the name is spliced into a glob pattern, so path
    // separators and glob syntax (* ? [ { !) must never reach it.
    if (!DOT_DIR_NAME.test(entry) || entry === '..') {
      warnOnce(
        `invalid:${raw}`,
        `  GITNEXUS_INCLUDE_DOT_DIRS entries must be single dot-directory names like ".github", got "${raw}" — ignoring it`,
      );
      continue;
    }
    if (REFUSED_DOT_DIRS.has(entry)) {
      warnOnce(
        `refused:${entry}`,
        `  GITNEXUS_INCLUDE_DOT_DIRS cannot include version-control directory "${entry}" — ignoring it`,
      );
      continue;
    }
    accepted.add(entry);
  }
  return [...accepted].sort();
};

/**
 * Resolve the dot directories the walker should index in addition to the
 * default (non-hidden) file set. Reads `GITNEXUS_INCLUDE_DOT_DIRS`, a
 * comma-separated list of directory names. Unset or empty means none, which
 * keeps the default behaviour unchanged.
 */
export const getIncludeDotDirs = (): string[] => {
  const raw = process.env.GITNEXUS_INCLUDE_DOT_DIRS;
  if (!raw) return [];
  return normalizeIncludeDotDirs(raw.split(','));
};

/**
 * The glob patterns for the indexable file set: every non-hidden file, plus
 * each listed dot directory at any depth. `dot: false` keeps hidden paths
 * out, but glob still matches a dot segment that a pattern names literally;
 * glob deduplicates matches across patterns. Every file discovery that must
 * agree with ingestion builds its patterns here.
 */
export const indexableGlobPatterns = (includeDotDirs: readonly string[]): string[] => [
  '**/*',
  ...includeDotDirs.flatMap((dir) => [`${dir}/**/*`, `**/${dir}/**/*`]),
];

/**
 * The `indexCoverage` fragment recording the active list: `{ includeDotDirs }`
 * when any directory is listed, otherwise `{}`.
 */
export const includeDotDirsCoverage = (): { includeDotDirs?: string[] } => {
  const includeDotDirs = getIncludeDotDirs();
  return includeDotDirs.length > 0 ? { includeDotDirs } : {};
};

/** Test-only: reset the warn-once cache so repeated test runs can re-observe warnings. */
export const _resetIncludeDotDirsWarnings = (): void => {
  warned.clear();
};
