/**
 * Classify and reclaim leftover per-branch index slots (#3331).
 *
 * Live means a name in local `refs/heads`. Classification never reverses
 * `branchSlug`; registry rows join through the same forward slug path
 * `clean --branch` already computes. Directory delete happens before the
 * registry drop; a failed rm keeps the summary so a later clean can retry.
 */

import fs from 'fs/promises';
import path from 'path';
import { BRANCHES_DIR } from './branch-index.js';
import { listLocalHeads } from './git.js';
import { isMissingFilesystemError, loadMeta } from './repo-meta.js';
import { getStoragePaths, removeBranchIndex } from './repo-manager.js';

export type StaleBranchReason =
  | 'ref-missing'
  | 'registry-only'
  | 'disk-only'
  | 'heads-unavailable'
  | 'probe-failed'
  | 'listing-failed';

export interface StaleBranchSlot {
  branch: string;
  dir: string | null;
  sizeBytes: number;
  reason: StaleBranchReason;
}

export interface ListStaleBranchSlotsInput {
  repoPath: string;
  storagePath: string;
  branches?: readonly { branch: string }[];
  /** Injected in tests. When omitted, listed from `repoPath`. */
  heads?: string[] | null;
  /** Default true. `--stale --force` skips the size walk; it never prints sizes. */
  includeSize?: boolean;
}

const slotDirForBranch = (repoPath: string, storagePath: string, branch: string): string =>
  path.dirname(getStoragePaths(repoPath, branch, storagePath).metaPath);

/** Same bound as `mapPool` in repo-manager: cap concurrent slot I/O. */
const STALE_SLOT_IO_CONCURRENCY = 8;

const mapPool = async <T, R>(
  items: readonly T[],
  mapper: (item: T) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(STALE_SLOT_IO_CONCURRENCY, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index] as T);
      }
    }),
  );
  return results;
};

/** Proven directory, proven absence, or a probe error that is not ENOENT/ENOTDIR. */
type DirectoryProbe = 'dir' | 'missing' | 'unreadable';

const probeDirectory = async (dir: string): Promise<DirectoryProbe> => {
  try {
    return (await fs.stat(dir)).isDirectory() ? 'dir' : 'unreadable';
  } catch (err) {
    return isMissingFilesystemError(err) ? 'missing' : 'unreadable';
  }
};

const directorySizeBytes = async (root: string): Promise<number> => {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(current, entry.name));
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
    for (const file of files) {
      try {
        total += (await fs.stat(file)).size;
      } catch {
        // Skip files that disappear or become unreadable mid-walk.
      }
    }
  }
  return total;
};

const metadataBranch = async (dir: string): Promise<string | null> => {
  const meta = await loadMeta(dir);
  return typeof meta?.branch === 'string' && meta.branch.length > 0 ? meta.branch : null;
};

export const listStaleBranchSlots = async (
  input: ListStaleBranchSlotsInput,
): Promise<StaleBranchSlot[]> => {
  const recorded = input.branches ?? [];
  const branchesRoot = path.join(input.storagePath, BRANCHES_DIR);

  const registryByDir = new Map<string, string>();
  for (const row of recorded) {
    registryByDir.set(
      path.resolve(slotDirForBranch(input.repoPath, input.storagePath, row.branch)),
      row.branch,
    );
  }

  let diskDirs: string[] = [];
  try {
    const entries = await fs.readdir(branchesRoot, { withFileTypes: true });
    diskDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(branchesRoot, entry.name));
  } catch (err) {
    if (!isMissingFilesystemError(err)) {
      return [{ branch: '', dir: null, sizeBytes: 0, reason: 'listing-failed' }];
    }
    diskDirs = [];
  }

  if (recorded.length === 0 && diskDirs.length === 0) return [];

  const heads = input.heads !== undefined ? input.heads : listLocalHeads(input.repoPath);
  const live = heads === null ? null : new Set(heads);

  const pending: Array<Omit<StaleBranchSlot, 'sizeBytes'>> = [];

  const registryProbes = await mapPool([...registryByDir], async ([resolvedDir, branch]) => ({
    resolvedDir,
    branch,
    probe: await probeDirectory(resolvedDir),
  }));
  for (const { resolvedDir, branch, probe } of registryProbes) {
    if (probe === 'unreadable') {
      pending.push({ branch, dir: resolvedDir, reason: 'probe-failed' });
      continue;
    }
    const exists = probe === 'dir';
    const dir = exists ? resolvedDir : null;
    if (live === null) {
      pending.push({ branch, dir, reason: 'heads-unavailable' });
      continue;
    }
    if (!exists) {
      pending.push({ branch, dir: null, reason: 'registry-only' });
      continue;
    }
    if (!live.has(branch)) {
      pending.push({ branch, dir, reason: 'ref-missing' });
    }
  }

  const leftoverDirs = diskDirs.filter((dir) => !registryByDir.has(path.resolve(dir)));
  const leftoverMeta = await mapPool(leftoverDirs, async (dir) => ({
    dir,
    branch: await metadataBranch(dir),
  }));
  for (const { dir, branch } of leftoverMeta) {
    if (branch === null) continue;
    const resolved = path.resolve(dir);
    if (live === null) {
      pending.push({ branch, dir: resolved, reason: 'heads-unavailable' });
      continue;
    }
    if (!live.has(branch)) {
      pending.push({ branch, dir: resolved, reason: 'disk-only' });
    }
  }

  const includeSize = input.includeSize !== false;
  return mapPool(pending, async (row) => ({
    ...row,
    sizeBytes: includeSize && row.dir ? await directorySizeBytes(row.dir) : 0,
  }));
};

/** Lexical / realpath containment: `child` is a proper descendant of `parent`. */
const isProperChildPath = (parent: string, child: string): boolean => {
  const root = path.resolve(parent);
  const resolved = path.resolve(child);
  const relative = path.relative(root, resolved);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const isSameNormalizedPath = (left: string, right: string): boolean =>
  path.relative(path.resolve(path.normalize(left)), path.resolve(path.normalize(right))) === '';

export const isContainedBranchDir = (storagePath: string, dir: string): boolean =>
  isProperChildPath(path.resolve(storagePath, BRANCHES_DIR), dir);

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

const keepRegistryFailure = (error: Error): RemoveBranchSlotResult => ({
  ok: false,
  emptiedBranchesDir: false,
  keptRegistry: true,
  error,
});

const refuseOutsideSlot = (dir: string): RemoveBranchSlotResult =>
  keepRegistryFailure(
    new Error(`Refusing to clean branch index outside the validated storage slot: ${dir}`),
  );

const slotPathExists = async (slotDir: string): Promise<boolean> => {
  try {
    await fs.lstat(slotDir);
    return true;
  } catch (err) {
    return !isMissingFilesystemError(err);
  }
};

/**
 * Delete a lexically contained slot. Returns a failure result, or `null` when
 * the slot path is gone and the registry row may drop.
 */
const removeValidatedSlotDir = async (
  storagePath: string,
  dir: string,
): Promise<RemoveBranchSlotResult | null> => {
  if (!isContainedBranchDir(storagePath, dir)) {
    return refuseOutsideSlot(dir);
  }

  const branchesRoot = path.resolve(storagePath, BRANCHES_DIR);

  let branchesStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    branchesStat = await fs.lstat(branchesRoot);
  } catch (err) {
    if (isMissingFilesystemError(err)) return null;
    return keepRegistryFailure(toError(err));
  }

  // Never walk a branches/ symlink (rm of a child would delete the target).
  if (branchesStat.isSymbolicLink()) {
    return refuseOutsideSlot(dir);
  }

  let realStorage: string;
  let realBranches: string;
  try {
    realStorage = await fs.realpath(storagePath);
    realBranches = await fs.realpath(branchesRoot);
  } catch (err) {
    if (isMissingFilesystemError(err)) return null;
    return keepRegistryFailure(toError(err));
  }

  // Junctions may not report as symlinks from lstat; realpath must still land
  // on storagePath/branches, not an outside tree.
  const expectedBranches = path.normalize(path.join(realStorage, BRANCHES_DIR));
  if (!isSameNormalizedPath(realBranches, expectedBranches)) {
    return refuseOutsideSlot(dir);
  }

  let slotStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    slotStat = await fs.lstat(dir);
  } catch (err) {
    if (isMissingFilesystemError(err)) return null;
    return keepRegistryFailure(toError(err));
  }

  let deleteError: Error | undefined;
  try {
    // A symlink, or a Windows junction that lstat reports as a directory,
    // must be unlinked at the lexical path. Never fs.rm through a target
    // that realpath places outside branches/.
    const realDir = slotStat.isSymbolicLink() ? null : await fs.realpath(dir);
    const unlinkOnly =
      slotStat.isSymbolicLink() || (realDir !== null && !isProperChildPath(realBranches, realDir));

    // Revalidate immediately before the destructive op. Another process can
    // replace branches/ or the slot after the earlier lstat/realpath awaits.
    const lastBranches = await fs.lstat(branchesRoot);
    if (lastBranches.isSymbolicLink()) {
      return refuseOutsideSlot(dir);
    }
    const lastSlot = await fs.lstat(dir);
    const lastUnlinkOnly = lastSlot.isSymbolicLink() || unlinkOnly;
    if (lastUnlinkOnly) {
      await fs.unlink(dir);
    } else {
      const lastReal = await fs.realpath(dir);
      if (!isProperChildPath(realBranches, lastReal)) {
        await fs.unlink(dir);
      } else {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    deleteError = toError(err);
  }

  if (await slotPathExists(dir)) {
    return keepRegistryFailure(deleteError ?? new Error(`Could not remove branch index: ${dir}`));
  }
  return null;
};

export const isDeleteCandidate = (slot: StaleBranchSlot): boolean =>
  slot.reason === 'ref-missing' || slot.reason === 'registry-only' || slot.reason === 'disk-only';

export type StaleListingBlock = 'heads-unavailable' | 'listing-failed';

/** Git-list or branches/ listing failed; clean and doctor must not reclaim. */
export const staleListingBlock = (slots: readonly StaleBranchSlot[]): StaleListingBlock | null => {
  if (slots.some((slot) => slot.reason === 'heads-unavailable')) return 'heads-unavailable';
  if (slots.some((slot) => slot.reason === 'listing-failed')) return 'listing-failed';
  return null;
};

export interface RemoveBranchSlotInput {
  repoPath: string;
  storagePath: string;
  branch: string;
  /** Slot directory to remove, or `null` for a registry-only row. */
  dir: string | null;
}

export interface RemoveBranchSlotResult {
  ok: boolean;
  emptiedBranchesDir: boolean;
  keptRegistry: boolean;
  error?: Error;
}

const rmdirEmptyBranches = async (storagePath: string): Promise<boolean> => {
  try {
    await fs.rmdir(path.join(storagePath, BRANCHES_DIR));
    return true;
  } catch {
    return false;
  }
};

export const removeBranchSlot = async (
  input: RemoveBranchSlotInput,
): Promise<RemoveBranchSlotResult> => {
  const { repoPath, storagePath, branch, dir } = input;
  if (dir !== null) {
    const slotDirError = await removeValidatedSlotDir(storagePath, dir);
    if (slotDirError) return slotDirError;
  }

  const dropRegistry =
    dir === null || isSameNormalizedPath(dir, slotDirForBranch(repoPath, storagePath, branch));
  if (dropRegistry) {
    try {
      await removeBranchIndex(repoPath, branch);
    } catch (err) {
      return keepRegistryFailure(toError(err));
    }
  }
  const emptiedBranchesDir = await rmdirEmptyBranches(storagePath);
  return { ok: true, emptiedBranchesDir, keptRegistry: !dropRegistry };
};
