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
import { acquireIndexLock, requireExclusiveIndexLock } from './index-lock.js';
import { loadMeta } from './repo-meta.js';
import {
  resolveSharedStore,
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
 * A member slot whose checkout is gone or no longer resolves to this store
 * (the worktree was deleted, or sharing was turned off for it).
 */
const isOrphanMember = async (slot: string, storeRoot: string): Promise<boolean> => {
  const meta = await loadMeta(slot);
  if (!meta?.repoPath) return false; // unknown slot: never collect what we cannot attribute
  if (!existsSync(meta.repoPath)) return true;
  const layout = resolveSharedStore(meta.repoPath);
  return !layout || layout.root !== storeRoot || layout.checkoutSlot !== slot;
};

/**
 * Delete unreferenced commit graphs, stale publish staging, and — with `gc` —
 * member slots whose checkout no longer belongs to the store. Removes the
 * store itself when nothing remains.
 */
export const reclaimSharedStore = async (
  storeRoot: string,
  opts: { gc?: boolean } = {},
): Promise<ReclaimResult> => {
  const result: ReclaimResult = { removed: [], kept: [], droppedMembers: [], storeRemoved: false };
  if (!existsSync(storeRoot)) return result;
  const checkoutsDir = path.join(storeRoot, 'checkouts');
  const commitsDir = path.join(storeRoot, 'commits');

  await withStoreLock({ root: storeRoot }, 'publish', async () => {
    const referenced = new Set<string>();
    let slots = (await listDir(checkoutsDir)).map((name) => path.join(checkoutsDir, name));
    if (opts.gc) {
      const live: string[] = [];
      for (const slot of slots) {
        if (await isOrphanMember(slot, storeRoot)) {
          await fs.rm(slot, { recursive: true, force: true });
          result.droppedMembers.push(slot);
        } else {
          live.push(slot);
        }
      }
      slots = live;
    }
    for (const slot of slots) {
      const graphPath = (await loadMeta(slot))?.graphPath;
      if (graphPath) referenced.add(path.dirname(path.resolve(graphPath)));
    }

    for (const name of await listDir(commitsDir)) {
      const dir = path.join(commitsDir, name);
      if (referenced.has(dir)) continue;
      try {
        await fs.rm(dir, { recursive: true, force: true });
        if (!name.startsWith('.')) result.removed.push(dir);
      } catch {
        // Windows refuses to delete a file another process has open (an MCP
        // reader). Keep it for the next reclaim instead of failing the clean.
        if (!name.startsWith('.')) result.kept.push(dir);
      }
    }

    const remaining = (await listDir(checkoutsDir)).length + (await listDir(commitsDir)).length;
    if (remaining === 0) {
      // The lock directory lives inside the store; removing it while held is
      // safe on POSIX and is retried on the next reclaim elsewhere.
      await fs
        .rm(storeRoot, { recursive: true, force: true })
        .then(() => {
          result.storeRemoved = true;
        })
        .catch(() => {});
    }
  });
  return result;
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
const POINTER_DIR_KEEP = new Set([SHARED_STORE_POINTER, '.gitignore']);

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

/** Remove the pointer file (the directory stays if it holds anything else). */
export const removeSharedStorePointer = async (checkoutPath: string): Promise<void> => {
  const dir = path.join(checkoutPath, GITNEXUS_DIR);
  await fs.rm(path.join(dir, SHARED_STORE_POINTER), { force: true });
  const rest = await listDir(dir);
  if (rest.length === 1 && rest[0] === '.gitignore')
    await fs.rm(dir, { recursive: true, force: true });
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
