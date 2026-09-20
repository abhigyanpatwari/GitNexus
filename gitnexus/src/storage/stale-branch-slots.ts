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

const isDirectory = async (dir: string): Promise<boolean> => {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (err) {
    if (isMissingFilesystemError(err)) return false;
    return false;
  }
};

export const directorySizeBytes = async (root: string): Promise<number> => {
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
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await fs.stat(child)).size;
      } catch {
        // Size walks are best-effort; skip unreadable files.
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
  } catch (err) {
    if (!isMissingFilesystemError(err)) {
      diskDirs = [];
    }
  }

  const rows: StaleBranchSlot[] = [];
  const seenDirs = new Set<string>();

  for (const [resolvedDir, branch] of registryByDir) {
    const exists = await isDirectory(resolvedDir);
    const dir = exists ? resolvedDir : null;
    if (exists) seenDirs.add(resolvedDir);
    const sizeBytes = exists ? await directorySizeBytes(resolvedDir) : 0;
    if (live === null) {
      rows.push({ branch, dir, sizeBytes, reason: 'heads-unavailable' });
      continue;
    }
    if (!exists) {
      rows.push({ branch, dir: null, sizeBytes: 0, reason: 'registry-only' });
      continue;
    }
    if (!live.has(branch)) {
      rows.push({ branch, dir, sizeBytes, reason: 'ref-missing' });
    }
  }

  for (const dir of diskDirs) {
    const resolved = path.resolve(dir);
    if (seenDirs.has(resolved) || registryByDir.has(resolved)) continue;
    const branch = await metadataBranch(dir);
    if (branch === null) continue;
    const sizeBytes = await directorySizeBytes(dir);
    if (live === null) {
      rows.push({ branch, dir: resolved, sizeBytes, reason: 'heads-unavailable' });
      continue;
    }
    if (!live.has(branch)) {
      rows.push({ branch, dir: resolved, sizeBytes, reason: 'disk-only' });
    }
  }

  return rows;
};

export const isContainedBranchDir = (storagePath: string, dir: string): boolean => {
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

export const formatSlotSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      const probeCode = await fs.access(dir).then(
        () => null,
        (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? 'UNKNOWN',
      );
      dirGone = probeCode === 'ENOENT' || probeCode === 'ENOTDIR';
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

  await removeBranchIndex(repoPath, branch);
  const emptiedBranchesDir = await rmdirEmptyBranches(storagePath);
  return { ok: true, emptiedBranchesDir, keptRegistry: false };
};
