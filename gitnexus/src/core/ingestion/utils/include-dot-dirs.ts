import { logger } from '../../logger.js';
import type { IgnoreLike } from 'glob';
import type { Path } from 'path-scurry';

/**
 * Directory names that must never be indexed, even when listed. These hold
 * version-control internals or credential stores, not source.
 */
const REFUSED_DOT_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.gnupg',
  '.docker',
  '.npm',
  '.pki',
  '.password-store',
  '.vault',
]);

const CREDENTIAL_CONFIG_DIRS = new Set(['gcloud', 'gh', 'hub', 'aws', 'azure', 'sops', 'op']);
const CREDENTIAL_FILES = new Set([
  'credentials',
  'credentials.json',
  'credentials.db',
  'application_default_credentials.json',
  'access_tokens.db',
  'accesstokens.json',
  'auth.json',
  'tokens.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'secrets.toml',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const KEY_FILE = /\.(?:pem|key|crt|cer|p12|pfx)$/i;

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
    // Windows strips trailing dots, which would turn ".git." into ".git".
    if (!DOT_DIR_NAME.test(entry) || entry.endsWith('.')) {
      warnOnce(
        `invalid:${raw}`,
        '  Ignoring invalid GITNEXUS_INCLUDE_DOT_DIRS entry; expected a single dot-directory name like ".github"',
      );
      continue;
    }
    if (REFUSED_DOT_DIRS.has(entry.toLowerCase())) {
      warnOnce(
        `refused:${entry}`,
        `  GITNEXUS_INCLUDE_DOT_DIRS cannot include version-control or credential directory "${entry}" — ignoring it`,
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
 * Opting into source directories must not opt into credentials or symlink
 * targets. Apply this before user ignore negations and metadata discovery.
 * Ordinary non-hidden paths retain the existing ignore/symlink policy.
 */
export const dotDirectoryIgnoreFilter = (base: IgnoreLike): IgnoreLike => {
  const protectedPath = (entry: Path): boolean => {
    const parts = entry.relative().replace(/\\/g, '/').toLowerCase().split('/');
    if (!parts.some((part) => part.startsWith('.'))) return false;
    if (parts.some((part) => REFUSED_DOT_DIRS.has(part))) return true;
    if (parts.some((part, i) => part === '.config' && CREDENTIAL_CONFIG_DIRS.has(parts[i + 1])))
      return true;
    const name = parts[parts.length - 1];
    if (CREDENTIAL_FILES.has(name) || KEY_FILE.test(name)) return true;
    // A literal root in a glob can traverse a symlink even with follow:false.
    // Check ancestors too, so such a match cannot reach the content readers.
    for (let current: Path | undefined = entry; current?.relative(); current = current.parent) {
      if (current.isSymbolicLink()) return true;
    }
    return false;
  };
  return {
    ignored: (entry) => protectedPath(entry) || (base.ignored?.(entry) ?? false),
    childrenIgnored: (entry) => protectedPath(entry) || (base.childrenIgnored?.(entry) ?? false),
  };
};

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
