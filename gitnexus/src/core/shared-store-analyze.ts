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
import { acquireIndexLock, requireExclusiveIndexLock } from '../storage/index-lock.js';
import { commitDistanceToHead, isWorkingTreeDirty } from '../storage/git.js';
import { registerRepo, saveMeta } from '../storage/repo-manager.js';
import { loadMeta, type RepoMeta } from '../storage/repo-meta.js';
import {
  commitGraphDir,
  resolveGraphPath,
  type SharedStoreLayout,
} from '../storage/shared-store.js';
import { INDEX_METADATA_FILE, LBUG_DIRECTORY } from '../storage/storage-constants.js';
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
 * Give a slot with no metadata a pointer to the best commit graph, so the
 * run that follows is up to date (same commit, clean) or incremental from
 * that graph's file hashes. Caller holds the slot's index lock.
 */
export const seedSharedSlot = async (
  layout: SharedStoreLayout,
  repoPath: string,
  log: Log,
): Promise<void> => {
  if (await loadMeta(layout.checkoutSlot)) return;
  const seed = pickSeed(repoPath, await listCommitGraphs(layout));
  if (!seed) return;
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
};

/**
 * Turn a pointer slot into a private one before analyze opens or writes the
 * graph. No-op for a slot that already owns its graph or has no graph at all.
 * Caller holds the slot's index lock.
 */
export const ensurePrivateSharedGraph = async (slot: string, log: Log): Promise<void> => {
  const own = path.join(slot, LBUG_DIRECTORY);
  const pointed = resolveGraphPath(slot);
  if (pointed === own) return;
  const meta = await loadMeta(slot);
  if (!meta) return;
  if (!(await exists(own))) {
    // `lbug.new.<id>` is swept by the slot lock if this process dies mid-copy.
    const tmp = `${own}.new.${randomUUID()}`;
    const started = Date.now();
    await fs.copyFile(pointed, tmp, fsConstants.COPYFILE_FICLONE);
    await fs.rename(tmp, own);
    log(`Shared store: copied the shared graph for local changes in ${Date.now() - started}ms.`);
  }
  delete meta.graphPath;
  await saveMeta(slot, meta);
};

const withPublishLock = async <T>(layout: SharedStoreLayout, fn: () => Promise<T>): Promise<T> => {
  const lockDir = path.join(layout.root, 'locks', 'publish');
  await fs.mkdir(lockDir, { recursive: true });
  const lock = await acquireIndexLock(lockDir);
  try {
    requireExclusiveIndexLock(lock, `Cannot acquire the shared-store publish lock at ${lockDir}.`);
    return await fn();
  } finally {
    lock.release();
  }
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
    const published = await withPublishLock(layout, async () => {
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
