import fs from 'fs';
import fsp, { type FileHandle } from 'fs/promises';
import path from 'path';
import { contentRetentionFromMeta } from '../core/content-retention.js';
import { stripWindowsLongPathPrefix } from '../lib/utils.js';
import { getGlobalDir } from './global-dir.js';
import type { ContentRetention, RepoMeta } from './repo-meta.js';
import {
  GITNEXUS_DIR,
  INDEX_METADATA_FILE,
  LEGACY_METADATA_FILE,
  LBUG_DIRECTORY,
} from './storage-constants.js';
import {
  readSharedStorePointer,
  resolveGraphPath,
  resolveSharedStore,
  SHARED_STORE_POINTER,
} from './shared-store.js';
import { slotNameForCanonicalPath, STORAGE_PATH_ENV, STORAGE_ROOT_ENV } from './storage-slot.js';

export { STORAGE_PATH_ENV, STORAGE_ROOT_ENV };

/** File-backend lock sidecars (`index-lock.ts`). Not ownership data. */
const INDEX_LOCK_ARTIFACTS = new Set([
  'analyze.lock',
  'analyze.lock.guard',
  // A shared-store checkout's pointer (#3352) and the ignore file beside it
  // are not index data either.
  SHARED_STORE_POINTER,
  '.gitignore',
  'run.cjs',
]);

export type StorageState =
  | 'invalid_param'
  | 'missing'
  | 'invalid_storage'
  | 'empty'
  | 'unowned'
  | 'owned'
  | 'foreign';

type MetadataFilename = typeof INDEX_METADATA_FILE | typeof LEGACY_METADATA_FILE;

export interface DiscoveryStorage {
  graphPath: string;
  contentRetention: ContentRetention;
}

export interface StorageInspection {
  repoPath: string;
  storagePath: string;
  state: StorageState;
  hasCodeIndexDB: boolean;
  reason?: string;
  /** Present only for an owned, usable slot inspected during discovery. */
  discovery?: DiscoveryStorage;
}

export interface StorageRequirements {
  allowedStates: readonly StorageState[];
  requireCodeIndexDB?: boolean;
}

export const ANALYZE_STORAGE_REQUIREMENTS = {
  allowedStates: ['missing', 'empty', 'owned'],
} as const satisfies StorageRequirements;

export const ANALYZE_FORCE_STORAGE_REQUIREMENTS = {
  allowedStates: ['missing', 'empty', 'owned', 'unowned', 'foreign'],
} as const satisfies StorageRequirements;

export const INDEX_STORAGE_REQUIREMENTS = {
  allowedStates: ['owned'],
  requireCodeIndexDB: true,
} as const satisfies StorageRequirements;

export const INDEX_FORCE_STORAGE_REQUIREMENTS = {
  allowedStates: ['owned', 'unowned', 'foreign'],
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
  graphPath?: string;
  contentRetention: ContentRetention;
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

const registryPath = (): string => path.join(getGlobalDir(), 'registry.json');

/** CLI "no usable index" — missing/empty, or owned metadata without LadybugDB. */
export const isUnusableIndexInspection = (
  inspection: Pick<StorageInspection, 'state' | 'hasCodeIndexDB'>,
): boolean =>
  inspection.state === 'missing' ||
  inspection.state === 'empty' ||
  (inspection.state === 'owned' && !inspection.hasCodeIndexDB);

const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

const isRepositoryLocalStoragePath = (repoPath: string, storagePath: string): boolean =>
  samePath(comparablePath(defaultStoragePath(repoPath)), comparablePath(storagePath));

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

/**
 * Stable slot name for one checkout inside a configured external storage root.
 * The canonical absolute path prevents symlink aliases from creating duplicate
 * slots, while the hash keeps same-basename repositories isolated.
 */
export const storageSlotName = (repoPath: string): string =>
  slotNameForCanonicalPath(canonicalRepoPath(repoPath));

export const defaultStoragePath = (repoPath: string): string =>
  path.join(resolveRepoPath(repoPath), GITNEXUS_DIR);

export const validateConfiguredStoragePath = (value: string): string => {
  const resolved = validateAbsolutePath(value, 'Storage path');
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  if (base.length === 0) {
    throw new InvalidStoragePathError('Storage path must not be a filesystem root.');
  }
  // Rebuild through parent + basename and apply the path.relative idiom
  // CodeQL's js/path-injection sanitizer recognizes. The reconstructed path
  // is what callers pass to filesystem APIs.
  const inspected = path.resolve(parent, base);
  const rel = path.relative(parent, inspected);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new InvalidStoragePathError('Storage path escaped its parent directory.');
  }
  return inspected;
};

/** Resolve one repository's isolated slot under an external storage root. */
export const storagePathFromRoot = (rootPath: string, repoPath: string): string => {
  const root = validateAbsolutePath(rootPath, STORAGE_ROOT_ENV);
  const storagePath = path.resolve(root, storageSlotName(repoPath));
  const rel = path.relative(root, storagePath);
  if (
    rel === '' ||
    rel.startsWith('..') ||
    path.isAbsolute(rel) ||
    !samePath(path.dirname(storagePath), root)
  ) {
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
    if (registryEntry.storagePath === undefined) {
      // Pre-external-storage rows have no storagePath. Match readRegistry():
      // fall through to the repository-local default instead of failing closed.
      return undefined;
    }
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

  // Shared sibling store (#3352): an unregistered checkout whose slot already
  // exists (for example after the registry was reset). Checkouts only move INTO
  // the store at analyze time; a read never switches to an empty slot.
  const shared = resolveSharedStore(resolvedRepoPath);
  if (shared && fs.existsSync(shared.checkoutSlot)) return shared.checkoutSlot;
  const pointed = readSharedStorePointer(resolvedRepoPath);
  if (pointed && fs.existsSync(pointed)) return pointed;

  return defaultStoragePath(resolvedRepoPath);
};

const parseOwnershipMetadata = (raw: string, filename: string): MetadataReadResult => {
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

  return {
    state: 'valid',
    value: {
      repoPath,
      storagePath: storagePathValue,
      graphPath: typeof record.graphPath === 'string' ? record.graphPath : undefined,
      contentRetention: contentRetentionFromMeta(record as Pick<RepoMeta, 'contentRetention'>),
    },
  };
};

/** Reuse only the compact fields read from this exact metadata file version. */
export class DiscoveryMetadataCache {
  private readonly files = new Map<
    string,
    { identity: string; read: Promise<MetadataReadResult> }
  >();

  retainSlots(entries: readonly { storagePath: string }[]): void {
    const liveSlots = new Set(
      entries.flatMap(({ storagePath }) =>
        typeof storagePath === 'string' ? [path.resolve(storagePath)] : [],
      ),
    );
    for (const filename of this.files.keys()) {
      if (!liveSlots.has(path.dirname(filename))) this.files.delete(filename);
    }
  }

  async read(
    file: FileHandle,
    metadataPath: string,
    identity: string,
  ): Promise<MetadataReadResult> {
    let cached = this.files.get(metadataPath);
    if (cached?.identity !== identity) {
      const read = fsp
        .readFile(file, 'utf-8')
        .then((raw) => parseOwnershipMetadata(raw, path.basename(metadataPath)));
      cached = { identity, read };
      this.files.set(metadataPath, cached);
    }
    let result: MetadataReadResult;
    try {
      result = await cached.read;
      return result;
    } finally {
      if (result?.state !== 'valid' && this.files.get(metadataPath) === cached) {
        this.files.delete(metadataPath);
      }
    }
  }
}

const readOwnershipMetadata = async (
  storagePath: string,
  filename: MetadataFilename,
  discovery?: DiscoveryMetadataCache,
): Promise<MetadataReadResult> => {
  const storageRoot = path.resolve(storagePath);
  const metadataPath = path.resolve(storageRoot, filename);
  const metadataRel = path.relative(storageRoot, metadataPath);
  if (metadataRel.startsWith('..') || path.isAbsolute(metadataRel)) {
    return { state: 'invalid', reason: `${filename} is not contained in the storage directory.` };
  }
  try {
    if (!discovery)
      return parseOwnershipMetadata(await fsp.readFile(metadataPath, 'utf-8'), filename);
    // Ownership metadata historically follows symlinks, while graph routing never
    // trusts a pointer from one. Make the open itself select the safe path.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let linked = false;
    let file: FileHandle;
    try {
      file = await fsp.open(metadataPath, flags | noFollow);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!noFollow || (code !== 'ELOOP' && code !== 'EMLINK' && code !== 'EFTYPE')) throw error;
      linked = true;
      file = await fsp.open(metadataPath, flags);
    }
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile())
        return { state: 'invalid', reason: `${filename} must be a regular file.` };
      if (!noFollow) {
        const entry = await fsp.lstat(metadataPath, { bigint: true });
        linked = entry.isSymbolicLink();
        const current = linked ? await fsp.stat(metadataPath, { bigint: true }) : entry;
        if (
          !current.isFile() ||
          stat.ino === 0n ||
          current.ino !== stat.ino ||
          current.dev !== stat.dev
        ) {
          return { state: 'invalid', reason: `EAGAIN: ${filename} changed during open.` };
        }
      }
      const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      const result = await discovery.read(file, metadataPath, identity);
      if (linked && result.state === 'valid') {
        return { state: 'valid', value: { ...result.value, graphPath: undefined } };
      }
      return result;
    } finally {
      await file.close();
    }
  } catch (error) {
    return isMissingFilesystemError(error)
      ? { state: 'absent' }
      : {
          state: 'invalid',
          reason: `${filename} could not be read: ${filesystemErrorDetail(error)}`,
        };
  }
};

/** Check for the LadybugDB path independently from metadata ownership. */
const inspectCodeIndexDB = async (
  storagePath: string,
  metadata?: Pick<RepoMeta, 'graphPath'>,
): Promise<{ present: boolean; graphPath?: string; transientCode?: string }> => {
  const resolved = validateConfiguredStoragePath(storagePath);
  const lbugPath = path.resolve(resolved, LBUG_DIRECTORY);
  const lbugRel = path.relative(resolved, lbugPath);
  if (lbugRel.startsWith('..') || path.isAbsolute(lbugRel)) {
    return { present: false };
  }
  // A shared-store checkout slot (#3352) may read a commit graph instead of
  // owning one; `resolveGraphPath` only returns a path inside the same store's
  // commit graphs, else the slot's own graph.
  const graphPath = resolveGraphPath(resolved, metadata);
  try {
    await fsp.access(graphPath);
    return { present: true, graphPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      present: false,
      ...(code && TRANSIENT_FILESYSTEM_CODES.has(code) ? { transientCode: code } : {}),
    };
  }
};

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
  discovery?: DiscoveryMetadataCache,
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

  const storageParent = path.dirname(context.storagePath);
  const storageBase = path.basename(context.storagePath);
  if (storageBase.length === 0) {
    return {
      ...context,
      state: 'invalid_param',
      hasCodeIndexDB: false,
      reason: 'Storage path must not be a filesystem root.',
    };
  }
  // Rebuild the inspected directory through parent + basename and keep the
  // path.relative barrier on this SSA value at every filesystem sink.
  const inspectedStorage = path.resolve(storageParent, storageBase);
  const inspectedRel = path.relative(storageParent, inspectedStorage);
  if (inspectedRel.startsWith('..') || path.isAbsolute(inspectedRel)) {
    return {
      ...context,
      state: 'invalid_param',
      hasCodeIndexDB: false,
      reason: 'Storage path escaped its parent directory.',
    };
  }
  context = { ...context, storagePath: inspectedStorage };

  const repositoryLocal = isRepositoryLocalStoragePath(context.repoPath, inspectedStorage);
  const failedDirectoryInspection = (error: unknown): StorageInspection => {
    if (isMissingFilesystemError(error)) {
      return { ...context, state: 'missing', hasCodeIndexDB: false };
    }
    return {
      ...context,
      state: 'invalid_storage',
      hasCodeIndexDB: false,
      reason: `Storage directory could not be inspected: ${filesystemErrorDetail(error)}`,
    };
  };
  let directoryEntries: string[] | undefined;
  let codeIndex: Awaited<ReturnType<typeof inspectCodeIndexDB>>;
  let primary: MetadataReadResult;
  try {
    const linkStat = await fsp.lstat(inspectedStorage);
    const targetStat = linkStat.isSymbolicLink() ? await fsp.stat(inspectedStorage) : linkStat;
    if (!targetStat.isDirectory()) {
      return {
        ...context,
        state: 'invalid_storage',
        hasCodeIndexDB: false,
        reason: 'Storage path exists but is not a directory.',
      };
    }
    const primaryRead = readOwnershipMetadata(inspectedStorage, INDEX_METADATA_FILE, discovery);
    const graphRead = discovery
      ? primaryRead.then((result) =>
          inspectCodeIndexDB(inspectedStorage, result.state === 'valid' ? result.value : {}),
        )
      : inspectCodeIndexDB(inspectedStorage);
    const inspectDirectory = async (): Promise<string[] | undefined> => {
      if (!discovery) return fsp.readdir(inspectedStorage);
      // Discovery needs directory read permission even when it can skip enumeration.
      // fs.access does not check Windows ACLs. Ask Windows to open a directory reader.
      if (process.platform === 'win32') {
        const directory = await fsp.opendir(inspectedStorage);
        await directory.close();
      } else {
        await fsp.access(inspectedStorage, fs.constants.R_OK | fs.constants.X_OK);
      }
    };
    const [entries, codeIndexResult, primaryResult] = await Promise.all([
      inspectDirectory(),
      graphRead,
      primaryRead,
    ]);
    directoryEntries = entries;
    codeIndex = codeIndexResult;
    primary = primaryResult;
  } catch (error) {
    return failedDirectoryInspection(error);
  }

  const hasCodeIndexDB = codeIndex.present;
  const transientDBReason = codeIndex.transientCode
    ? `${codeIndex.transientCode}: LadybugDB directory could not be inspected.`
    : undefined;
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
    const legacy = await readOwnershipMetadata(
      context.storagePath,
      LEGACY_METADATA_FILE,
      discovery,
    );
    if (legacy.state === 'invalid') {
      return {
        ...context,
        state: 'invalid_storage',
        hasCodeIndexDB,
        reason: legacy.reason,
      };
    }
    if (legacy.state === 'absent') {
      try {
        directoryEntries ??= await fsp.readdir(inspectedStorage);
      } catch (error) {
        return failedDirectoryInspection(error);
      }
      const hasNonLockEntries = directoryEntries.some((name) => !INDEX_LOCK_ARTIFACTS.has(name));
      return {
        ...context,
        state: hasNonLockEntries ? 'unowned' : 'empty',
        hasCodeIndexDB,
        reason:
          transientDBReason ??
          (hasNonLockEntries
            ? 'Storage directory contains data but no valid ownership metadata.'
            : undefined),
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
    ...(discovery && state === 'owned' && codeIndex.graphPath
      ? {
          discovery: {
            graphPath: codeIndex.graphPath,
            contentRetention: metadata.contentRetention,
          },
        }
      : {}),
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
export const inspectRegisteredStorage = async (
  entry: { path: string; storagePath: string },
  discovery?: DiscoveryMetadataCache,
): Promise<StorageInspection> => inspectStoragePath(entry.storagePath, entry.path, discovery);

const requireInspectedStoragePath = (
  inspection: StorageInspection,
  requirements: StorageRequirements,
): string => {
  if (!requirements.allowedStates.includes(inspection.state)) {
    throw new StorageRequirementError(inspection, requirements);
  }
  // `foreign` is only adoptable for this checkout's own `.gitnexus`. An
  // external slot that names another repository stays rejected even when the
  // caller opted into `foreign` (analyze/index --force).
  if (
    inspection.state === 'foreign' &&
    !isRepositoryLocalStoragePath(inspection.repoPath, inspection.storagePath)
  ) {
    throw new StorageRequirementError(inspection, {
      ...requirements,
      allowedStates: requirements.allowedStates.filter((state) => state !== 'foreign'),
    });
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
 * removable when it is missing, empty, contains data without metadata, or
 * carries foreign metadata (this checkout's directory, another repo's stamp).
 * External storage has no such physical ownership proof and therefore must
 * contain metadata binding both the repository and the exact storage path.
 * External foreign or malformed metadata is never removable.
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
  const storageIsLocal = isRepositoryLocalStoragePath(repoPath, actualStoragePath);
  const comparableStorage = comparablePath(actualStoragePath);
  const comparableRepo = comparablePath(repoPath);
  const comparableRoot = comparablePath(path.parse(actualStoragePath).root);
  if (
    samePath(comparableStorage, comparableRoot) ||
    samePath(comparableStorage, comparableRepo) ||
    isPathAncestor(comparableStorage, comparableRepo)
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
    ? ['missing', 'empty', 'unowned', 'owned', 'foreign']
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
