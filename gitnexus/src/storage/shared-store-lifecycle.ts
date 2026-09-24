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
  storeRootOfCheckoutSlot,
  type SharedStoreLayout,
} from './shared-store.js';
import { LBUG_DIRECTORY } from './storage-constants.js';

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

/** Graph directory a checkout slot reads, for reporting. */
export const describeSharedGraph = (
  graphPath: string,
  storagePath: string,
): 'shared' | 'private' =>
  path.resolve(graphPath) === path.join(path.resolve(storagePath), LBUG_DIRECTORY)
    ? 'private'
    : 'shared';
