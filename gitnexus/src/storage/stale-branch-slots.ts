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
import { BRANCHES_DIR, branchSlug } from './branch-index.js';
import { listLocalHeads } from './git.js';
import { isMissingFilesystemError, loadMeta } from './repo-meta.js';
import { removeBranchIndex } from './repo-manager.js';

export type StaleBranchReason = 'ref-missing' | 'registry-only' | 'disk-only' | 'heads-unavailable';

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
}

const slotDirForBranch = (storagePath: string, branch: string): string =>
  path.join(storagePath, BRANCHES_DIR, branchSlug(branch));

/** Proven directory, proven absence, or a probe error that is not ENOENT/ENOTDIR. */
type DirectoryProbe = 'dir' | 'missing' | 'unreadable';

const probeDirectory = async (dir: string): Promise<DirectoryProbe> => {
  try {
    return (await fs.stat(dir)).isDirectory() ? 'dir' : 'missing';
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
  const heads = input.heads !== undefined ? input.heads : listLocalHeads(input.repoPath);
  const recorded = input.branches ?? [];
  const branchesRoot = path.join(input.storagePath, BRANCHES_DIR);
  const live = heads === null ? null : new Set(heads);

  const registryByDir = new Map<string, string>();
  for (const row of recorded) {
    registryByDir.set(path.resolve(slotDirForBranch(input.storagePath, row.branch)), row.branch);
  }

  let diskDirs: string[] = [];
  try {
    const entries = await fs.readdir(branchesRoot, { withFileTypes: true });
    diskDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(branchesRoot, entry.name));
  } catch {
    diskDirs = [];
  }

  const pending: Array<Omit<StaleBranchSlot, 'sizeBytes'>> = [];
  const seenDirs = new Set<string>();

  for (const [resolvedDir, branch] of registryByDir) {
    const probe = await probeDirectory(resolvedDir);
    if (probe === 'unreadable') continue;
    const exists = probe === 'dir';
    const dir = exists ? resolvedDir : null;
    if (exists) seenDirs.add(resolvedDir);
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

  for (const dir of diskDirs) {
    const resolved = path.resolve(dir);
    if (seenDirs.has(resolved) || registryByDir.has(resolved)) continue;
    const branch = await metadataBranch(dir);
    if (branch === null) continue;
    if (live === null) {
      pending.push({ branch, dir: resolved, reason: 'heads-unavailable' });
      continue;
    }
    if (!live.has(branch)) {
      pending.push({ branch, dir: resolved, reason: 'disk-only' });
    }
  }

  const sized: StaleBranchSlot[] = [];
  for (const row of pending) {
    sized.push({
      ...row,
      sizeBytes: row.dir ? await directorySizeBytes(row.dir) : 0,
    });
  }
  return sized;
};

const isContainedBranchDir = (storagePath: string, dir: string): boolean => {
  const branchesRoot = path.resolve(storagePath, BRANCHES_DIR);
  const resolved = path.resolve(dir);
  const relative = path.relative(branchesRoot, resolved);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

export const isDeleteCandidate = (slot: StaleBranchSlot): boolean =>
  slot.reason !== 'heads-unavailable';

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
    if (!isContainedBranchDir(storagePath, dir)) {
      return {
        ok: false,
        emptiedBranchesDir: false,
        keptRegistry: true,
        error: new Error(
          `Refusing to clean branch index outside the validated storage slot: ${dir}`,
        ),
      };
    }
    let rmError: NodeJS.ErrnoException | undefined;
    await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      rmError = err as NodeJS.ErrnoException;
    });
    let dirGone = !rmError;
    if (rmError) {
      dirGone = await fs.access(dir).then(
        () => false,
        (e: unknown) => isMissingFilesystemError(e),
      );
    }
    if (!dirGone) {
      return {
        ok: false,
        emptiedBranchesDir: false,
        keptRegistry: true,
        error: rmError ?? new Error(`Could not remove branch index: ${dir}`),
      };
    }
  }

  try {
    await removeBranchIndex(repoPath, branch);
  } catch (err) {
    return {
      ok: false,
      emptiedBranchesDir: false,
      keptRegistry: true,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  const emptiedBranchesDir = await rmdirEmptyBranches(storagePath);
  return { ok: true, emptiedBranchesDir, keptRegistry: false };
};
