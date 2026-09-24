/**
 * Store-wide locking and reference-counted cleanup for the shared sibling
 * store (#3352).
 *
 * A commit graph is live while any member checkout slot's metadata records
 * it as `graphPath`. `reclaimSharedStore` deletes every commit graph with no
 * reference, and the whole store once no member and no commit graph remain.
 * It runs under the store's publish lock, so a concurrent analyze that is
 * publishing or pointing at a graph is never raced.
 */

import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { acquireIndexLock, requireExclusiveIndexLock, type IndexLockHandle } from './index-lock.js';
import {
  canonicalizePath,
  findRegistryEntryByRepoPath,
  readRegistry,
  registryPathEquals,
} from './repo-manager.js';
import { loadMeta } from './repo-meta.js';
import {
  SHARED_STORE_POINTER,
  storeRootOfCheckoutSlot,
  type SharedStoreLayout,
} from './shared-store.js';
import { GITNEXUS_DIR, LBUG_DIRECTORY } from './storage-constants.js';

type StoreRoot = Pick<SharedStoreLayout, 'root'>;

/**
 * Serialize one kind of store-wide write (`publish`, `cache`) across
 * checkouts. Each checkout's own slot is already covered by its index lock.
 */
export const withStoreLock = async <T>(
  layout: StoreRoot,
  name: 'publish' | 'cache',
  fn: () => Promise<T>,
): Promise<T> => {
  const lockDir = path.join(layout.root, 'locks', name);
  await fs.mkdir(lockDir, { recursive: true });
  const lock = await acquireIndexLock(lockDir);
  try {
    requireExclusiveIndexLock(lock, `Cannot acquire the shared-store ${name} lock at ${lockDir}.`);
    return await fn();
  } finally {
    lock.release();
  }
};

export interface ReclaimResult {
  /** Commit graph directories deleted. */
  removed: string[];
  /** Unreferenced commit graphs that could not be deleted (for example, open on Windows). */
  kept: string[];
  /** Member slots dropped by garbage collection. */
  droppedMembers: string[];
  /** The store root was deleted because nothing remained. */
  storeRemoved: boolean;
}

const listDir = (dir: string): Promise<string[]> => fs.readdir(dir).catch(() => [] as string[]);

/**
 * Listing for reclaim decisions: only a missing directory is empty. Any other
 * read error aborts, because treating an unreadable `checkouts/` as "no
 * members" would delete every commit graph as unreferenced.
 */
const listDirStrict = (dir: string): Promise<string[]> =>
  fs.readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });

/**
 * Member slots that no registry entry uses any more: the checkout directory is
 * gone, or its entry moved elsewhere (`--no-share`, sharing turned off). The
 * registry is the membership record for opted-in clones and for a main
 * checkout whose last worktree was removed, so identity alone cannot decide.
 * A slot with no attributable `repoPath` is never collected.
 */
const orphanMembers = async (slots: string[]): Promise<Set<string>> => {
  const entries = await readRegistry();
  const orphans = new Set<string>();
  for (const slot of slots) {
    const meta = await loadMeta(slot);
    if (!meta?.repoPath) continue;
    const entry = existsSync(meta.repoPath)
      ? findRegistryEntryByRepoPath(entries, meta.repoPath)
      : undefined;
    if (
      !entry ||
      !registryPathEquals(canonicalizePath(entry.storagePath), canonicalizePath(slot))
    ) {
      orphans.add(slot);
    }
  }
  return orphans;
};

/**
 * Reclaim with the store's publish lock already held. Analyze calls this right
 * after publishing so graphs a checkout stopped using are deleted at once
 * (KTD7), and slot pointers written under the same lock are always counted.
 */
export const reclaimSharedStoreLocked = async (
  storeRootInput: string,
  opts: { gc?: boolean; dryRun?: boolean } = {},
): Promise<ReclaimResult> => {
  // Absolute, so commit dirs compare equal to the resolved graphPath parents
  // even when GITNEXUS_HOME is relative.
  const storeRoot = path.resolve(storeRootInput);
  const result: ReclaimResult = { removed: [], kept: [], droppedMembers: [], storeRemoved: false };
  const checkoutsDir = path.join(storeRoot, 'checkouts');
  const commitsDir = path.join(storeRoot, 'commits');
  const referenced = new Set<string>();
  let slots = (await listDirStrict(checkoutsDir)).map((name) => path.join(checkoutsDir, name));
  if (opts.gc) {
    const orphans = await orphanMembers(slots);
    for (const slot of [...orphans]) {
      if (opts.dryRun) {
        result.droppedMembers.push(slot);
        continue;
      }
      // An analyze holds its slot's index lock until it has registered the
      // checkout, so a slot that is seeded but not yet registered is busy,
      // not orphaned. Judge and delete only a slot whose lock is free.
      let lock: IndexLockHandle;
      try {
        lock = await acquireIndexLock(slot, { timeoutMs: 1 });
      } catch {
        orphans.delete(slot);
        continue;
      }
      try {
        if (lock.lockFree || !(await orphanMembers([slot])).has(slot)) {
          orphans.delete(slot);
          continue;
        }
        await fs.rm(slot, { recursive: true, force: true });
        result.droppedMembers.push(slot);
      } finally {
        lock.release();
      }
    }
    slots = slots.filter((slot) => !orphans.has(slot));
  }
  for (const slot of slots) {
    const graphPath = (await loadMeta(slot))?.graphPath;
    if (graphPath) referenced.add(path.dirname(path.resolve(graphPath)));
  }

  for (const name of await listDirStrict(commitsDir)) {
    const dir = path.join(commitsDir, name);
    if (referenced.has(dir)) continue;
    if (opts.dryRun) {
      if (!name.startsWith('.')) result.removed.push(dir);
      continue;
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      if (!name.startsWith('.')) result.removed.push(dir);
    } catch {
      // Windows refuses to delete a file another process has open (an MCP
      // reader). Keep it for the next reclaim instead of failing the caller.
      if (!name.startsWith('.')) result.kept.push(dir);
    }
  }

  const isEmpty = async (): Promise<boolean> =>
    (await listDirStrict(checkoutsDir)).length + (await listDirStrict(commitsDir)).length === 0;
  if (!opts.dryRun && (await isEmpty())) {
    // Also hold the cache lock (publish -> cache, the only nesting order) so
    // a member saving caches cannot lose them, then re-check: a new member's
    // slot may have appeared while waiting. The lock directories live inside
    // the store; removing them while held is safe on POSIX and is retried on
    // the next reclaim elsewhere.
    await withStoreLock({ root: storeRoot }, 'cache', async () => {
      if (!(await isEmpty())) return;
      await fs
        .rm(storeRoot, { recursive: true, force: true })
        .then(() => {
          result.storeRemoved = true;
        })
        .catch(() => {});
    });
  }
  return result;
};

/**
 * Delete unreferenced commit graphs, stale publish staging, and — with `gc` —
 * member slots no registry entry uses. Removes the store itself when nothing
 * remains.
 */
export const reclaimSharedStore = async (
  storeRoot: string,
  opts: { gc?: boolean; dryRun?: boolean } = {},
): Promise<ReclaimResult> => {
  if (!existsSync(storeRoot)) {
    return { removed: [], kept: [], droppedMembers: [], storeRemoved: false };
  }
  return withStoreLock({ root: storeRoot }, 'publish', () =>
    reclaimSharedStoreLocked(storeRoot, opts),
  );
};

/**
 * After a storage slot was deleted: reclaim its store when it was a shared
 * checkout slot. No-op for any other storage path. Never throws — the slot
 * deletion already succeeded and reclaim is retried by the next clean.
 */
export const reclaimAfterSlotRemoval = async (
  storagePath: string,
): Promise<ReclaimResult | null> => {
  const storeRoot = storeRootOfCheckoutSlot(storagePath);
  if (!storeRoot) return null;
  try {
    return await reclaimSharedStore(storeRoot);
  } catch {
    return null;
  }
};

/** Whether a checkout slot reads a shared commit graph or its own private graph. */
export const describeSharedGraph = (
  graphPath: string,
  storagePath: string,
): 'shared' | 'private' =>
  path.resolve(graphPath) === path.join(path.resolve(storagePath), LBUG_DIRECTORY)
    ? 'private'
    : 'shared';

/** Files a shared checkout keeps in `<checkout>/.gitnexus`; everything else there is legacy. */
const POINTER_DIR_KEEP = new Set([SHARED_STORE_POINTER, '.gitignore', 'run.cjs']);

/**
 * Point `<checkout>/.gitnexus` at the checkout's store slot (#3352 R16). The
 * directory's other contents — a pre-adoption index — are left untouched.
 */
export const writeSharedStorePointer = async (
  checkoutPath: string,
  layout: Pick<SharedStoreLayout, 'key' | 'checkoutSlot'>,
): Promise<void> => {
  const dir = path.join(checkoutPath, GITNEXUS_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, SHARED_STORE_POINTER),
    `${JSON.stringify({ version: 1, storeKey: layout.key, checkoutSlot: layout.checkoutSlot }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
};

/**
 * Remove the pointer file. The directory stays if it holds anything else, or
 * if it cannot be listed (its contents are then unknown).
 */
export const removeSharedStorePointer = async (checkoutPath: string): Promise<void> => {
  const dir = path.join(checkoutPath, GITNEXUS_DIR);
  await fs.rm(path.join(dir, SHARED_STORE_POINTER), { force: true });
  const rest = await fs
    .readdir(dir)
    .catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? [] : null));
  if (rest?.every((name) => POINTER_DIR_KEEP.has(name))) {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

const sizeOf = async (target: string): Promise<number> => {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await listDir(target)) total += await sizeOf(path.join(target, name));
  return total;
};

export interface LegacyLocalIndex {
  dir: string;
  entries: string[];
  bytes: number;
}

/**
 * A pre-adoption index left in `<checkout>/.gitnexus` after the checkout moved
 * into a shared store (#3352 R13). Null when the checkout is not shared or
 * the directory holds only the pointer.
 */
export const findLegacyLocalIndex = async (
  checkoutPath: string,
  storagePath: string,
): Promise<LegacyLocalIndex | null> => {
  if (!storeRootOfCheckoutSlot(storagePath)) return null;
  const dir = path.join(checkoutPath, GITNEXUS_DIR);
  const entries = (await listDir(dir)).filter((name) => !POINTER_DIR_KEEP.has(name));
  if (entries.length === 0) return null;
  let bytes = 0;
  for (const name of entries) bytes += await sizeOf(path.join(dir, name));
  return { dir, entries, bytes };
};

/** Delete a legacy local index, keeping the pointer. Returns what was removed. */
export const removeLegacyLocalIndex = async (
  checkoutPath: string,
  storagePath: string,
): Promise<LegacyLocalIndex | null> => {
  const legacy = await findLegacyLocalIndex(checkoutPath, storagePath);
  if (!legacy) return null;
  for (const name of legacy.entries) {
    await fs.rm(path.join(legacy.dir, name), { recursive: true, force: true });
  }
  return legacy;
};

/**
 * Run `fn` (delete a slot, unregister its checkout) under the slot's index
 * lock when `storagePath` is a shared-store checkout slot, then remove
 * `checkoutPath`'s store pointer before releasing it. An analyze holds that
 * lock until it has registered the checkout and written its pointer, so it
 * cannot re-register a slot this removes, write into it, or have its new
 * pointer deleted afterwards. Other storage runs `fn` directly, as before.
 */
export const withCheckoutSlotLock = async <T>(
  storagePath: string,
  fn: () => Promise<T>,
  checkoutPath?: string,
): Promise<T> => {
  if (!storeRootOfCheckoutSlot(storagePath)) return fn();
  const lock = await acquireIndexLock(storagePath);
  try {
    requireExclusiveIndexLock(lock, `Cannot acquire the index lock at ${storagePath}.`);
    const result = await fn();
    if (checkoutPath) await removeSharedStorePointer(checkoutPath);
    return result;
  } finally {
    lock.release();
  }
};
