/**
 * Analyze-side operations for the shared sibling store (#3352).
 *
 * A shared checkout slot is in one of two states:
 *   - pointer: metadata records `graphPath` (a commit graph in the store);
 *              the slot has no graph of its own.
 *   - private: the slot owns `<slot>/lbug`; no `graphPath`.
 *
 * Analyze always writes the private path. `ensurePrivateSharedGraph` turns a
 * pointer into a private copy just before the first graph open/write, so a
 * clean checkout that hits the up-to-date fast path copies nothing.
 * `publishSharedGraph` runs after a successful analyze: a clean checkout at
 * HEAD moves its private graph into `commits/` (or drops it when that commit
 * graph already exists) and becomes a pointer again. Commit graphs are never
 * written after publish.
 */

import { createHash, randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { acquireIndexLock } from '../storage/index-lock.js';
import { withStoreLock } from '../storage/shared-store-lifecycle.js';
import { commitDistanceToHead, isWorkingTreeDirty } from '../storage/git.js';
import { registerRepo, saveMeta } from '../storage/repo-manager.js';
import { loadMeta, type RepoMeta } from '../storage/repo-meta.js';
import {
  commitGraphDir,
  resolveGraphPath,
  type SharedStoreLayout,
} from '../storage/shared-store.js';
import { GITNEXUS_DIR, INDEX_METADATA_FILE, LBUG_DIRECTORY } from '../storage/storage-constants.js';
import { wipeLbugDbFiles } from './lbug/lbug-adapter.js';
import { inspectLbugSidecars } from './lbug/sidecar-recovery.js';

type Log = (msg: string) => void;

/**
 * Fields that differ between checkouts or runs of the same content and
 * settings. Everything else in the metadata — schema fingerprint, analysis
 * features, capabilities, retention, runner identity, PDG and process
 * settings — must match for two checkouts to share a graph. A denylist fails
 * safe: an unexpected per-run field only prevents sharing, never mixes graphs.
 */
const FEATURE_KEY_EXCLUDED = new Set<string>([
  'repoPath',
  'storagePath',
  'graphPath',
  'lastCommit',
  'indexedAt',
  'branch',
  'remoteUrl',
  'fileHashes',
  'cacheKeys',
  'incrementalInProgress',
  'embeddingCheckpoint',
  'stats',
]);

/** Fields that describe one checkout; stripped from a published commit graph's metadata. */
const CHECKOUT_FIELDS = ['repoPath', 'storagePath', 'graphPath', 'branch', 'incrementalInProgress'];

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/** Hash of every graph-affecting metadata field (see FEATURE_KEY_EXCLUDED). */
export const featureKeyOf = (meta: RepoMeta): string => {
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!FEATURE_KEY_EXCLUDED.has(k)) kept[k] = v;
  }
  // Embedding presence changes graph content but lives only in `stats`.
  kept.hasEmbeddings = (meta.stats?.embeddings ?? 0) > 0;
  return createHash('sha256').update(stableStringify(kept)).digest('hex').slice(0, 16);
};

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );

interface CommitGraph {
  dir: string;
  commit: string;
  meta: RepoMeta;
}

const listCommitGraphs = async (layout: SharedStoreLayout): Promise<CommitGraph[]> => {
  let names: string[];
  try {
    names = await fs.readdir(layout.commitsDir);
  } catch {
    return [];
  }
  const graphs: CommitGraph[] = [];
  for (const name of names) {
    const match = /^([0-9a-f]{7,64})-([0-9a-f]{8,64})$/.exec(name);
    if (!match) continue;
    const dir = path.join(layout.commitsDir, name);
    const meta = await loadMeta(dir);
    if (!meta || !(await exists(path.join(dir, LBUG_DIRECTORY)))) continue;
    graphs.push({ dir, commit: match[1], meta });
  }
  return graphs;
};

/**
 * Pick the commit graph to seed a new checkout slot from: the one at HEAD,
 * else the ancestor with the fewest commits to HEAD. Ties go to the most
 * recently indexed graph.
 * ponytail: one `git` call pair per commit graph; fine for tens of graphs,
 * batch through `git rev-list` if stores grow to hundreds.
 */
const pickSeed = (repoPath: string, graphs: CommitGraph[]): CommitGraph | null => {
  let best: { graph: CommitGraph; distance: number } | null = null;
  for (const graph of graphs) {
    const distance = commitDistanceToHead(repoPath, graph.commit);
    if (distance === null) continue;
    const better =
      !best ||
      distance < best.distance ||
      (distance === best.distance && graph.meta.indexedAt > best.graph.meta.indexedAt);
    if (better) best = { graph, distance };
  }
  return best?.graph ?? null;
};

/**
 * Copy a repository-local index (`<checkout>/.gitnexus`) into an empty slot
 * as its private graph. Used before the store has any commit graph: the main
 * checkout was indexed before its first worktree existed, or a worktree still
 * has its pre-store index. The source is left untouched (R12). Returns false
 * when the source is missing, not an ancestor of HEAD, busy, or not
 * consolidated.
 */
const seedFromLocalIndex = async (
  slot: string,
  repoPath: string,
  source: string,
  log: Log,
): Promise<boolean> => {
  const sourceGraph = path.join(source, LBUG_DIRECTORY);
  const meta = await loadMeta(source);
  if (!meta || meta.incrementalInProgress || !meta.lastCommit) return false;
  if (!(await exists(sourceGraph))) return false;
  if (commitDistanceToHead(repoPath, meta.lastCommit) === null) return false;
  let lock;
  try {
    lock = await acquireIndexLock(source, { timeoutMs: 2_000 });
  } catch {
    return false; // another analyze is writing it; seed from scratch instead
  }
  try {
    if (lock.lockFree || (await inspectLbugSidecars(sourceGraph)).kind !== 'clean') return false;
    await fs.mkdir(slot, { recursive: true });
    const own = path.join(slot, LBUG_DIRECTORY);
    const tmp = `${own}.new.${randomUUID()}`;
    try {
      await fs.copyFile(sourceGraph, tmp, fsConstants.COPYFILE_FICLONE);
      await fs.rename(tmp, own);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      log(`Shared store: could not copy ${sourceGraph} (${(err as Error).message}).`);
      return false;
    }
  } finally {
    lock.release();
  }
  const seeded: RepoMeta = { ...meta, repoPath, storagePath: slot };
  delete seeded.graphPath;
  await saveMeta(slot, seeded);
  log(`Shared store: seeded from the local index at ${source}.`);
  return true;
};

/**
 * Seed a slot that has no metadata so the run that follows is up to date or
 * incremental instead of a full build. Preference order:
 *   1. a pointer to the store's commit graph nearest to HEAD;
 *   2. a copy of this checkout's own repository-local index;
 *   3. a copy of the main checkout's repository-local index.
 * Caller holds the slot's index lock.
 */
export const seedSharedSlot = async (
  layout: SharedStoreLayout,
  repoPath: string,
  log: Log,
): Promise<void> => {
  if (await loadMeta(layout.checkoutSlot)) return;
  const seed = pickSeed(repoPath, await listCommitGraphs(layout));
  if (seed) {
    await fs.mkdir(layout.checkoutSlot, { recursive: true });
    const meta: RepoMeta = {
      ...seed.meta,
      repoPath,
      storagePath: layout.checkoutSlot,
      graphPath: path.join(seed.dir, LBUG_DIRECTORY),
    };
    delete meta.incrementalInProgress;
    await saveMeta(layout.checkoutSlot, meta);
    log(`Shared store: seeded from commit graph ${seed.commit.slice(0, 12)}.`);
    return;
  }
  const locals = [repoPath, layout.canonicalCheckout]
    .filter((p): p is string => p !== null)
    .map((p) => path.join(p, GITNEXUS_DIR));
  for (const source of new Set(locals)) {
    if (await seedFromLocalIndex(layout.checkoutSlot, repoPath, source, log)) return;
  }
};

/**
 * Turn a pointer slot into a private one before analyze opens or writes the
 * graph. Returns false when the pointed-at shared graph cannot be copied
 * (garbage-collected or unreadable): the slot's file hashes then describe a
 * graph that is not there, and the caller must do a full build. Caller holds
 * the slot's index lock.
 */
export const ensurePrivateSharedGraph = async (slot: string, log: Log): Promise<boolean> => {
  const own = path.join(slot, LBUG_DIRECTORY);
  const pointed = resolveGraphPath(slot);
  if (pointed === own) return true;
  const meta = await loadMeta(slot);
  if (!meta) return true;
  if (!(await exists(own))) {
    // `lbug.new.<id>` is swept by the slot lock if this process dies mid-copy.
    const tmp = `${own}.new.${randomUUID()}`;
    const started = Date.now();
    try {
      await fs.copyFile(pointed, tmp, fsConstants.COPYFILE_FICLONE);
      await fs.rename(tmp, own);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      log(`Shared store: shared graph unavailable (${reason}); doing a full build.`);
      return false;
    }
    log(`Shared store: copied the shared graph for local changes in ${Date.now() - started}ms.`);
  }
  delete meta.graphPath;
  await saveMeta(slot, meta);
  return true;
};

/**
 * Every directory in the store whose metadata may record parse-cache keys:
 * each checkout slot (its branch slots are read by the caller's per-root
 * fold) and each commit graph.
 */
export const listStoreMetaRoots = async (layout: SharedStoreLayout): Promise<string[]> => {
  const roots: string[] = [];
  for (const dir of [layout.checkoutsDir, layout.commitsDir]) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.startsWith('.')) roots.push(path.join(dir, name));
    }
  }
  return roots;
};

/**
 * After a successful analyze of the flat slot: publish or reuse the commit
 * graph when the checkout is clean at HEAD, and make sure the registry points
 * at the slot. Caller holds the slot's index lock.
 */
export const publishSharedGraph = async (
  layout: SharedStoreLayout,
  repoPath: string,
  currentCommit: string,
  log: Log,
): Promise<void> => {
  const slot = layout.checkoutSlot;
  const meta = await loadMeta(slot);
  if (!meta) return;
  const own = path.join(slot, LBUG_DIRECTORY);

  const shareable =
    currentCommit !== '' &&
    meta.lastCommit === currentCommit &&
    !meta.incrementalInProgress &&
    !isWorkingTreeDirty(repoPath);
  if (shareable) {
    const target = commitGraphDir(layout, currentCommit, featureKeyOf(meta));
    const targetGraph = path.join(target, LBUG_DIRECTORY);
    const published = await withStoreLock(layout, 'publish', async () => {
      if (await exists(targetGraph)) {
        await wipeLbugDbFiles(own);
        return true;
      }
      if (!(await exists(own)) || (await inspectLbugSidecars(own)).kind !== 'clean') return false;
      await fs.mkdir(layout.commitsDir, { recursive: true });
      const staging = path.join(layout.commitsDir, `.publish-${randomUUID()}`);
      await fs.mkdir(staging);
      const commitMeta: Record<string, unknown> = { ...meta };
      for (const field of CHECKOUT_FIELDS) delete commitMeta[field];
      try {
        await fs.rename(own, path.join(staging, LBUG_DIRECTORY));
        await fs.writeFile(path.join(staging, INDEX_METADATA_FILE), JSON.stringify(commitMeta));
        await fs.rename(staging, target);
      } catch (err) {
        // Put the graph back so the slot stays usable as a private index.
        await fs.rename(path.join(staging, LBUG_DIRECTORY), own).catch(() => {});
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        log(
          `Shared store: could not publish (${(err as Error).message}); keeping a private graph.`,
        );
        return false;
      }
      log(`Shared store: published commit graph ${currentCommit.slice(0, 12)}.`);
      return true;
    });
    if (published) {
      meta.graphPath = targetGraph;
      await saveMeta(slot, meta);
    }
  } else if (meta.graphPath !== undefined && (await exists(own))) {
    delete meta.graphPath;
    await saveMeta(slot, meta);
  }

  // The up-to-date fast path skips registration; a seeded or adopted checkout
  // must still end up registered at its slot.
  await registerRepo(repoPath, meta, { storagePath: slot });
};

export { withStoreLock };
