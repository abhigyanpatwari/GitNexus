import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

export const STORAGE_PATH_ENV = 'GITNEXUS_STORAGE_PATH';

interface RegistryStorageEntry {
  path?: unknown;
  storagePath?: unknown;
}

export class InvalidStoragePathError extends Error {
  readonly kind = 'InvalidStoragePathError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidStoragePathError';
  }
}

const registryPath = (): string =>
  path.join(process.env.GITNEXUS_HOME || path.join(os.homedir(), '.gitnexus'), 'registry.json');

const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

export const defaultStoragePath = (repoPath: string): string =>
  path.join(path.resolve(repoPath), '.gitnexus');

export const validateConfiguredStoragePath = (value: string): string => {
  if (value.length === 0) {
    throw new InvalidStoragePathError(
      `${STORAGE_PATH_ENV} must be an absolute, non-empty directory path when set.`,
    );
  }
  if (value.includes('\0')) {
    throw new InvalidStoragePathError(`${STORAGE_PATH_ENV} must not contain a NUL character.`);
  }
  if (!path.isAbsolute(value)) {
    throw new InvalidStoragePathError(`${STORAGE_PATH_ENV} must be an absolute directory path.`);
  }
  return path.resolve(value);
};

const configuredStoragePath = (): string | undefined => {
  const value = process.env[STORAGE_PATH_ENV];
  return value === undefined ? undefined : validateConfiguredStoragePath(value);
};

const registeredStoragePath = (repoPath: string): string | undefined => {
  let entries: unknown[];
  try {
    const data = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    if (!Array.isArray(data)) return undefined;
    entries = data;
  } catch {
    return undefined;
  }

  const resolvedRepoPath = path.resolve(repoPath);
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const registryEntry = entry as RegistryStorageEntry;
    if (typeof registryEntry.path !== 'string' || typeof registryEntry.storagePath !== 'string') {
      continue;
    }
    if (!samePath(path.resolve(registryEntry.path), resolvedRepoPath)) continue;
    try {
      return validateConfiguredStoragePath(registryEntry.storagePath);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * Resolve one repository's complete index directory. The resolver is synchronous
 * because it is used by path-only helpers throughout storage, branch placement,
 * and CLI command setup. Registry reads are deliberately best-effort; a missing
 * or legacy entry falls back to the established repository-local layout.
 */
export const resolveStoragePath = (repoPath: string): string =>
  configuredStoragePath() ?? registeredStoragePath(repoPath) ?? defaultStoragePath(repoPath);

/** Ensure a selected index directory is usable before an analysis takes its lock. */
export const ensureStoragePathWritable = async (storagePath: string): Promise<void> => {
  const resolved = validateConfiguredStoragePath(storagePath);
  await fsp.mkdir(resolved, { recursive: true });
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) {
    throw new InvalidStoragePathError(`Index storage path is not a directory: ${resolved}`);
  }
  await fsp.access(resolved, fs.constants.R_OK | fs.constants.W_OK);
};
