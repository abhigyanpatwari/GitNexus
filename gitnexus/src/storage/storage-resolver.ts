import { createHash } from 'node:crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { stripWindowsLongPathPrefix } from '../lib/utils.js';
import {
  GITNEXUS_DIR,
  INDEX_METADATA_FILE,
  LEGACY_METADATA_FILE,
  LBUG_DIRECTORY,
} from './storage-constants.js';

export const STORAGE_PATH_ENV = 'GITNEXUS_STORAGE_PATH';
export const STORAGE_ROOT_ENV = 'GITNEXUS_STORAGE_ROOT';

const STORAGE_SLOT_HASH_LENGTH = 12;

export type StorageState =
  | 'invalid_param'
  | 'missing'
  | 'invalid_storage'
  | 'empty'
  | 'unowned'
  | 'owned'
  | 'foreign';

type MetadataFilename = typeof INDEX_METADATA_FILE | typeof LEGACY_METADATA_FILE;

export interface StorageInspection {
  repoPath: string;
  storagePath: string;
  state: StorageState;
  hasCodeIndexDB: boolean;
  reason?: string;
}

export interface StorageRequirements {
  allowedStates: readonly StorageState[];
  requireCodeIndexDB?: boolean;
}

export const ANALYZE_STORAGE_REQUIREMENTS = {
  allowedStates: ['missing', 'empty', 'owned'],
} as const satisfies StorageRequirements;

export const INDEX_STORAGE_REQUIREMENTS = {
  allowedStates: ['owned'],
  requireCodeIndexDB: true,
} as const satisfies StorageRequirements;

export const INDEX_FORCE_STORAGE_REQUIREMENTS = {
  allowedStates: ['owned', 'unowned'],
  requireCodeIndexDB: true,
} as const satisfies StorageRequirements;

export const STATUS_STORAGE_REQUIREMENTS: StorageRequirements = {
  allowedStates: ['owned'],
  requireCodeIndexDB: true,
};

export const LIST_STORAGE_REQUIREMENTS = STATUS_STORAGE_REQUIREMENTS;

export const getIndexStorageRequirements = (force: boolean): StorageRequirements =>
  force ? INDEX_FORCE_STORAGE_REQUIREMENTS : INDEX_STORAGE_REQUIREMENTS;

interface RegistryStorageEntry {
  path?: unknown;
  storagePath?: unknown;
}

interface OwnershipMetadata {
  repoPath: string;
  storagePath?: string;
}

type MetadataReadResult =
  | { state: 'absent' }
  | { state: 'invalid'; reason: string }
  | { state: 'valid'; value: OwnershipMetadata };

const TRANSIENT_FILESYSTEM_CODES = new Set([
  'EACCES',
  'EAGAIN',
  'EBUSY',
  'EIO',
  'EMFILE',
  'ENFILE',
  'EPERM',
  'EROFS',
]);

export class InvalidStoragePathError extends Error {
  readonly kind = 'InvalidStoragePathError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidStoragePathError';
  }
}

export class StorageRequirementError extends Error {
  readonly kind = 'StorageRequirementError' as const;

  constructor(
    public readonly inspection: StorageInspection,
    public readonly requirements: StorageRequirements,
  ) {
    const storagePath = inspection.storagePath || '<unresolved>';
    const stateAllowed = requirements.allowedStates.includes(inspection.state);
    const detail = stateAllowed
      ? `Storage path does not contain a LadybugDB code index: ${storagePath}.`
      : `Storage path is in state "${inspection.state}" but requires one of: ${requirements.allowedStates.join(', ')}.`;
    super(inspection.reason ? `${detail} ${inspection.reason}` : detail);
    this.name = 'StorageRequirementError';
  }
}

/** Raised when a destructive command cannot prove that a storage path is safe to remove. */
export class StorageDeletionError extends Error {
  readonly kind = 'StorageDeletionError' as const;

  constructor(
    public readonly expectedStoragePath: string,
    public readonly actualStoragePath: string,
    public readonly inspection?: StorageInspection,
    detail = 'the storage path is not owned by the registered repository',
  ) {
    super(
      `Refusing to remove storage path for safety: ${detail}. ` +
        `Expected "${expectedStoragePath}" or an externally owned index, ` +
        `but the registry entry has "${actualStoragePath}". ` +
        `This usually means the registry entry is corrupted or was hand-edited. ` +
        `Delete the entry manually from ~/.gitnexus/registry.json and re-run analyze.`,
    );
    this.name = 'StorageDeletionError';
  }
}

const registryPath = (): string =>
  path.join(process.env.GITNEXUS_HOME || path.join(os.homedir(), '.gitnexus'), 'registry.json');

const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

const isMissingFilesystemError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const filesystemErrorDetail = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code ? `${code}: ${(error as Error)?.message ?? String(error)}` : String(error);
};

const resolveRepoPath = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidStoragePathError('Repository path must be non-empty.');
  }
  if (value.includes('\0')) {
    throw new InvalidStoragePathError('Repository path must not contain a NUL character.');
  }
  return path.resolve(value);
};

const validateAbsolutePath = (value: string, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidStoragePathError(`${label} must be an absolute, non-empty path.`);
  }
  if (value.includes('\0')) {
    throw new InvalidStoragePathError(`${label} must not contain a NUL character.`);
  }
  if (!path.isAbsolute(value)) {
    throw new InvalidStoragePathError(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
};

// Mirror registry lookup semantics without importing repo-manager and creating a cycle.
const canonicalRegistryPath = (value: string): string => {
  const resolved = path.resolve(value);
  try {
    return stripWindowsLongPathPrefix(fs.realpathSync.native(resolved));
  } catch {
    return stripWindowsLongPathPrefix(resolved);
  }
};

const canonicalRepoPath = (repoPath: string): string =>
  canonicalRegistryPath(resolveRepoPath(repoPath));

const comparablePath = (value: string): string => {
  const canonical = canonicalRegistryPath(value);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};

const sanitizeSlotBasename = (value: string): string => {
  const sanitized = value
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  const candidate = sanitized || 'repository';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(candidate)
    ? `repository-${candidate}`
    : candidate;
};

/**
 * Stable slot name for one checkout inside a configured external storage root.
 * The canonical absolute path prevents symlink aliases from creating duplicate
 * slots, while the hash keeps same-basename repositories isolated.
 */
export const storageSlotName = (repoPath: string): string => {
  const canonical = canonicalRepoPath(repoPath);
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const basename = sanitizeSlotBasename(path.basename(canonical));
  const digest = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, STORAGE_SLOT_HASH_LENGTH);
  return `${basename}-${digest}`;
};

export const defaultStoragePath = (repoPath: string): string =>
  path.join(resolveRepoPath(repoPath), GITNEXUS_DIR);

export const validateConfiguredStoragePath = (value: string): string => {
  return validateAbsolutePath(value, 'Storage path');
};

/** Resolve one repository's isolated slot under an external storage root. */
export const storagePathFromRoot = (rootPath: string, repoPath: string): string => {
  const root = validateAbsolutePath(rootPath, STORAGE_ROOT_ENV);
  const storagePath = path.join(root, storageSlotName(repoPath));
  if (!samePath(path.dirname(storagePath), root)) {
    throw new InvalidStoragePathError(
      `Resolved storage path must remain directly inside ${STORAGE_ROOT_ENV}.`,
    );
  }
  return storagePath;
};

const configuredStoragePath = (): string | undefined => {
  const value = process.env[STORAGE_PATH_ENV];
  return value === undefined ? undefined : validateConfiguredStoragePath(value);
};

const configuredStorageRoot = (repoPath: string): string | undefined => {
  const value = process.env[STORAGE_ROOT_ENV];
  return value === undefined ? undefined : storagePathFromRoot(value, repoPath);
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

  const resolvedRepoPath = canonicalRegistryPath(repoPath);
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const registryEntry = entry as RegistryStorageEntry;
    if (typeof registryEntry.path !== 'string') continue;
    if (!samePath(canonicalRegistryPath(registryEntry.path), resolvedRepoPath)) continue;
    if (typeof registryEntry.storagePath !== 'string') {
      throw new InvalidStoragePathError(
        `Registered storage path for ${repoPath} must be an absolute, non-empty path.`,
      );
    }
    return validateConfiguredStoragePath(registryEntry.storagePath);
  }
  return undefined;
};

/** Resolve one repository's complete index directory. */
export const resolveStoragePath = (repoPath: string): string => {
  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configuredPath = configuredStoragePath();
  if (configuredPath) return configuredPath;

  const configuredRoot = configuredStorageRoot(resolvedRepoPath);
  if (configuredRoot) return configuredRoot;

  const registered = registeredStoragePath(resolvedRepoPath);
  if (registered) return registered;

  return defaultStoragePath(resolvedRepoPath);
};

const readOwnershipMetadata = async (
  storagePath: string,
  filename: MetadataFilename,
): Promise<MetadataReadResult> => {
  const metadataPath = path.join(storagePath, filename);
  try {
    await fsp.access(metadataPath);
  } catch (error) {
    return isMissingFilesystemError(error)
      ? { state: 'absent' }
      : {
          state: 'invalid',
          reason: `${filename} could not be read: ${filesystemErrorDetail(error)}`,
        };
  }

  let raw: string;
  try {
    raw = await fsp.readFile(metadataPath, 'utf-8');
  } catch (error) {
    return isMissingFilesystemError(error)
      ? { state: 'absent' }
      : {
          state: 'invalid',
          reason: `${filename} could not be read: ${filesystemErrorDetail(error)}`,
        };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'invalid', reason: `${filename} is not valid JSON.` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'invalid', reason: `${filename} must contain a JSON object.` };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.repoPath !== 'string') {
    return { state: 'invalid', reason: `${filename} does not contain a valid repoPath.` };
  }

  let repoPath: string;
  let storagePathValue: string | undefined;
  try {
    repoPath = validateAbsolutePath(record.repoPath, `${filename} repoPath`);
    if (record.storagePath !== undefined) {
      if (typeof record.storagePath !== 'string') {
        return { state: 'invalid', reason: `${filename} contains an invalid storagePath.` };
      }
      storagePathValue = validateConfiguredStoragePath(record.storagePath);
    }
  } catch (error) {
    return {
      state: 'invalid',
      reason: error instanceof Error ? error.message : `${filename} contains invalid paths.`,
    };
  }

  return { state: 'valid', value: { repoPath, storagePath: storagePathValue } };
};

/** Check for the LadybugDB path independently from metadata ownership. */
const inspectCodeIndexDB = async (
  storagePath: string,
): Promise<{ present: boolean; transientCode?: string }> => {
  const resolved = validateConfiguredStoragePath(storagePath);
  try {
    await fsp.access(path.join(resolved, LBUG_DIRECTORY));
    return { present: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      present: false,
      ...(code && TRANSIENT_FILESYSTEM_CODES.has(code) ? { transientCode: code } : {}),
    };
  }
};

export const checkHasCodeIndexDB = async (storagePath: string): Promise<boolean> =>
  (await inspectCodeIndexDB(storagePath)).present;

/** Whether an inspection failed because the filesystem could not be read reliably. */
export const isTransientStorageInspection = (inspection: StorageInspection): boolean => {
  const reason = inspection.reason ?? '';
  return [...TRANSIENT_FILESYSTEM_CODES].some((code) => reason.includes(`${code}:`));
};

/**
 * Inspect filesystem and metadata facts without deciding whether a command may
 * read, write, adopt, or delete the slot. Callers apply their scenario policy
 * to the returned state. `gitnexus.json` remains primary; legacy metadata is
 * selected only when the primary file is provably absent.
 */
export const inspectStoragePath = async (
  storagePath: string,
  repoPath: string,
): Promise<StorageInspection> => {
  let context: Pick<StorageInspection, 'repoPath' | 'storagePath'>;
  try {
    const resolvedRepoPath = resolveRepoPath(repoPath);
    const resolvedStoragePath = validateConfiguredStoragePath(storagePath);
    context = {
      repoPath: resolvedRepoPath,
      storagePath: resolvedStoragePath,
    };
  } catch (error) {
    return {
      repoPath,
      storagePath,
      state: 'invalid_param',
      hasCodeIndexDB: false,
      reason: error instanceof Error ? error.message : 'Invalid storage parameters.',
    };
  }

  const repositoryLocal = samePath(
    comparablePath(defaultStoragePath(context.repoPath)),
    comparablePath(context.storagePath),
  );
  let directoryEntries: string[];
  try {
    const linkStat = await fsp.lstat(context.storagePath);
    const targetStat = linkStat.isSymbolicLink() ? await fsp.stat(context.storagePath) : linkStat;
    if (!targetStat.isDirectory()) {
      return {
        ...context,
        state: 'invalid_storage',
        hasCodeIndexDB: false,
        reason: 'Storage path exists but is not a directory.',
      };
    }
    directoryEntries = await fsp.readdir(context.storagePath);
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      return { ...context, state: 'missing', hasCodeIndexDB: false };
    }
    return {
      ...context,
      state: 'invalid_storage',
      hasCodeIndexDB: false,
      reason: `Storage directory could not be inspected: ${filesystemErrorDetail(error)}`,
    };
  }

  const codeIndex = await inspectCodeIndexDB(context.storagePath);
  const hasCodeIndexDB = codeIndex.present;
  const transientDBReason = codeIndex.transientCode
    ? `${codeIndex.transientCode}: LadybugDB directory could not be inspected.`
    : undefined;
  const primary = await readOwnershipMetadata(context.storagePath, INDEX_METADATA_FILE);
  if (primary.state === 'invalid') {
    return {
      ...context,
      state: 'invalid_storage',
      hasCodeIndexDB,
      reason: primary.reason,
    };
  }

  let metadata: OwnershipMetadata;
  if (primary.state === 'valid') {
    metadata = primary.value;
  } else {
    const legacy = await readOwnershipMetadata(context.storagePath, LEGACY_METADATA_FILE);
    if (legacy.state === 'invalid') {
      return {
        ...context,
        state: 'invalid_storage',
        hasCodeIndexDB,
        reason: legacy.reason,
      };
    }
    if (legacy.state === 'absent') {
      return {
        ...context,
        state: directoryEntries.length === 0 ? 'empty' : 'unowned',
        hasCodeIndexDB,
        reason:
          transientDBReason ??
          (directoryEntries.length === 0
            ? undefined
            : 'Storage directory contains data but no valid ownership metadata.'),
      };
    }
    metadata = legacy.value;
  }

  const repoMatches = samePath(comparablePath(metadata.repoPath), comparablePath(context.repoPath));
  const storageMatches =
    metadata.storagePath !== undefined &&
    samePath(comparablePath(metadata.storagePath), comparablePath(context.storagePath));

  let state: StorageState;
  let reason: string | undefined;
  if (!repoMatches || (metadata.storagePath !== undefined && !storageMatches)) {
    state = 'foreign';
    reason = 'Storage metadata identifies a different repository or storage directory.';
  } else if (!repositoryLocal && metadata.storagePath === undefined) {
    state = 'unowned';
    reason = 'External storage metadata does not bind the index to this storage directory.';
  } else {
    state = 'owned';
  }

  return {
    ...context,
    state,
    hasCodeIndexDB,
    reason: reason ?? transientDBReason,
  };
};

/** Resolve and inspect a repo-initiated storage lookup in one operation. */
export const inspectResolvedStorage = async (repoPath: string): Promise<StorageInspection> => {
  let storagePath: string;
  try {
    storagePath = resolveStoragePath(repoPath);
  } catch (error) {
    return {
      repoPath,
      storagePath: '',
      state: 'invalid_param',
      hasCodeIndexDB: false,
      reason: error instanceof Error ? error.message : 'Storage path could not be resolved.',
    };
  }
  return inspectStoragePath(storagePath, repoPath);
};

/**
 * Inspect a registry-selected slot without allowing an environment override to
 * redirect the entry to another repository's storage.
 */
export const inspectRegisteredStorage = async (entry: {
  path: string;
  storagePath: string;
}): Promise<StorageInspection> => inspectStoragePath(entry.storagePath, entry.path);

const requireInspectedStoragePath = (
  inspection: StorageInspection,
  requirements: StorageRequirements,
): string => {
  if (!requirements.allowedStates.includes(inspection.state)) {
    throw new StorageRequirementError(inspection, requirements);
  }
  if (requirements.requireCodeIndexDB && !inspection.hasCodeIndexDB) {
    throw new StorageRequirementError(inspection, requirements);
  }
  return inspection.storagePath;
};

/** Resolve and validate storage selected from a repository path. */
export const requireStoragePath = async (
  repoPath: string,
  requirements: StorageRequirements,
): Promise<string> =>
  requireInspectedStoragePath(await inspectResolvedStorage(repoPath), requirements);

/** Validate the exact storage path persisted in a registry entry. */
export const requireRegisteredStoragePath = async (
  entry: { path: string; storagePath: string },
  requirements: StorageRequirements,
): Promise<string> =>
  requireInspectedStoragePath(await inspectRegisteredStorage(entry), requirements);

const isPathAncestor = (ancestor: string, child: string): boolean => {
  const relative = path.relative(ancestor, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/**
 * Resolve a registry entry for a destructive operation.
 *
 * Repository-local `.gitnexus` is a path-owned namespace, so it remains
 * removable when it is missing, empty, or contains data without metadata.
 * External storage has no such physical ownership proof and therefore must
 * contain metadata binding both the repository and the exact storage path.
 * In either case, foreign or malformed metadata is never removable.
 */
export const requireDeletableStoragePath = async (entry: {
  path: string;
  storagePath: string;
}): Promise<string> => {
  let repoPath: string;
  let actualStoragePath: string;
  try {
    repoPath = resolveRepoPath(entry.path);
    actualStoragePath = validateConfiguredStoragePath(entry.storagePath);
  } catch (error) {
    const rawStoragePath =
      typeof entry.storagePath === 'string'
        ? path.resolve(entry.storagePath)
        : String(entry.storagePath);
    const fallbackRepoPath =
      typeof entry.path === 'string' && entry.path.length > 0 && !entry.path.includes('\0')
        ? entry.path
        : process.cwd();
    throw new StorageDeletionError(
      defaultStoragePath(fallbackRepoPath),
      rawStoragePath,
      undefined,
      error instanceof Error ? error.message : 'the registry storage path is invalid',
    );
  }

  const expectedStoragePath = defaultStoragePath(repoPath);
  const storageIsLocal = samePath(
    comparablePath(expectedStoragePath),
    comparablePath(actualStoragePath),
  );
  const filesystemRoot = path.parse(actualStoragePath).root;
  if (
    samePath(actualStoragePath, filesystemRoot) ||
    samePath(actualStoragePath, repoPath) ||
    isPathAncestor(actualStoragePath, repoPath)
  ) {
    throw new StorageDeletionError(
      expectedStoragePath,
      actualStoragePath,
      undefined,
      'the target is the repository, one of its parents, or a filesystem root',
    );
  }

  const inspection = await inspectRegisteredStorage({
    path: repoPath,
    storagePath: actualStoragePath,
  });
  const allowedStates: readonly StorageState[] = storageIsLocal
    ? ['missing', 'empty', 'unowned', 'owned']
    : ['owned'];
  if (!allowedStates.includes(inspection.state)) {
    throw new StorageDeletionError(
      expectedStoragePath,
      actualStoragePath,
      inspection,
      `the storage inspection state is "${inspection.state}"`,
    );
  }
  return actualStoragePath;
};

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
