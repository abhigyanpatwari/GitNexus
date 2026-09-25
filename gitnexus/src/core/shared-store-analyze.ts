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
import { existsSync, constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { acquireIndexLock, requireExclusiveIndexLock } from '../storage/index-lock.js';
import {
  commitDistanceToHead,
  getRemoteUrl,
  hasGitDir,
  isWorkingTreePristine,
} from '../storage/git.js';
import {
  canonicalizePath,
  findRegistryEntryByRepoPath,
  readRegistry,
  registerRepo,
  registryPathEquals,
  resolveRegistryEntry,
  saveMeta,
  type RegistryEntry,
} from '../storage/repo-manager.js';
import { loadMeta, type RepoMeta } from '../storage/repo-meta.js';
import {
  cloneStoreKey,
  commitGraphDir,
  resolveGraphPath,
  resolveSharedStore,
  sharedStoreLayout,
  storeRootOfCheckoutSlot,
  type SharedStoreLayout,
} from '../storage/shared-store.js';
import {
  GRAPH_CLONE_MARKER,
  type GraphCloneKind,
  reclaimAfterSlotRemoval,
  reclaimSharedStoreLocked,
  removeSharedStorePointer,
  withStoreLock,
  writeSharedStorePointer,
} from '../storage/shared-store-lifecycle.js';
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

/**
 * Copy a graph file to `dest` via a unique `lbug.new.<id>` temp (swept by the
 * slot lock if this process dies mid-copy), cloning copy-on-write where the
 * filesystem supports it (APFS, btrfs, XFS with reflink). A clone shares every
 * unchanged page with the source, so a private graph costs only what the
 * checkout's edits rewrite; elsewhere it is a full copy. Which one happened is
 * recorded next to `dest` for `status`. On failure the temp is removed and
 * the error thrown.
 */
const cloneGraphFile = async (source: string, dest: string): Promise<void> => {
  const tmp = `${dest}.new.${randomUUID()}`;
  try {
    let kind: GraphCloneKind = 'copy-on-write';
    try {
      await fs.copyFile(source, tmp, fsConstants.COPYFILE_FICLONE_FORCE);
    } catch {
      kind = 'copy';
      await fs.copyFile(source, tmp);
    }
    await fs.rename(tmp, dest);
    await fs.writeFile(path.join(path.dirname(dest), GRAPH_CLONE_MARKER), kind);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};

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
const pickSeed = (
  repoPath: string,
  graphs: CommitGraph[],
): { graph: CommitGraph; distance: number } | null => {
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
  return best;
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
  const usable = (m: RepoMeta | null): m is RepoMeta =>
    !!m &&
    !m.incrementalInProgress &&
    !!m.lastCommit &&
    commitDistanceToHead(repoPath, m.lastCommit) !== null;
  if (!usable(await loadMeta(source)) || !(await exists(sourceGraph))) return false;
  let lock;
  try {
    lock = await acquireIndexLock(source, { timeoutMs: 2_000 });
  } catch {
    return false; // another analyze is writing it; seed from scratch instead
  }
  let meta: RepoMeta;
  try {
    if (lock.lockFree || (await inspectLbugSidecars(sourceGraph)).kind !== 'clean') return false;
    // Re-read under the lock: an analyze that finished while this waited
    // rewrote both, and the copied graph must match the saved metadata.
    const locked = await loadMeta(source);
    if (!usable(locked)) return false;
    meta = locked;
    await fs.mkdir(slot, { recursive: true });
    try {
      await cloneGraphFile(sourceGraph, path.join(slot, LBUG_DIRECTORY));
    } catch (err) {
      log(`Shared store: could not copy ${sourceGraph} (${(err as Error).message}).`);
      return false;
    }
  } finally {
    lock.release();
  }
  // A local index may hold uncommitted edits from when it was built. Clearing
  // lastCommit forces the next run through the file-hash diff, which rewrites
  // any file whose content differs, instead of trusting the up-to-date path.
  const seeded: RepoMeta = { ...meta, repoPath, storagePath: slot, lastCommit: '' };
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
  const picked = pickSeed(repoPath, await listCommitGraphs(layout));
  const seed = picked?.graph;
  // A commit graph matches its commit exactly, so a checkout showing exactly
  // that commit is up to date. Any other checkout gets an empty lastCommit,
  // like seedFromLocalIndex, so its next run hash-diffs.
  const upToDate = picked?.distance === 0 && isWorkingTreePristine(repoPath);
  // Record the pointer under the publish lock, where reclaim counts
  // references, so the graph cannot be deleted between the pick and the save.
  const pointed =
    seed &&
    (await withStoreLock(layout, 'publish', async () => {
      const graph = path.join(seed.dir, LBUG_DIRECTORY);
      if (!(await exists(graph))) return false;
      await fs.mkdir(layout.checkoutSlot, { recursive: true });
      const meta: RepoMeta = {
        ...seed.meta,
        repoPath,
        storagePath: layout.checkoutSlot,
        graphPath: graph,
        lastCommit: upToDate ? seed.meta.lastCommit : '',
      };
      delete meta.incrementalInProgress;
      await saveMeta(layout.checkoutSlot, meta);
      return true;
    }));
  if (seed && pointed) {
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
 * graph. With `copy: false` the slot just stops pointing and the caller builds
 * its own graph from scratch. Returns false when the pointed-at shared graph cannot be copied
 * (garbage-collected or unreadable): the slot's file hashes then describe a
 * graph that is not there, and the caller must do a full build. Caller holds
 * the slot's index lock.
 */
export const ensurePrivateSharedGraph = async (
  slot: string,
  log: Log,
  opts: { copy?: boolean } = {},
): Promise<boolean> => {
  const own = path.join(slot, LBUG_DIRECTORY);
  const pointed = resolveGraphPath(slot);
  if (pointed === own) return true;
  const meta = await loadMeta(slot);
  if (!meta) return true;
  // `copy: false` — the caller rebuilds from scratch and reads nothing from
  // the old graph, so only the pointer is dropped.
  if (opts.copy === false) {
    await fs.rm(path.join(slot, GRAPH_CLONE_MARKER), { force: true });
  } else if (!(await exists(own))) {
    const started = Date.now();
    try {
      await cloneGraphFile(pointed, own);
    } catch (err) {
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

  // A graph built while files were dirty still holds those edits even after
  // they are reverted (the up-to-date path does not re-diff a clean tree), so
  // only a graph whose build saw no dirty covered file may become shared.
  const builtClean = (meta.indexCoverage?.dirtyPaths ?? []).length === 0;
  const shareable =
    currentCommit !== '' &&
    meta.lastCommit === currentCommit &&
    !meta.incrementalInProgress &&
    builtClean &&
    // Embeddings still owed stay with this checkout, which finishes them; a
    // commit graph never changes, so a shared copy would stay short for good.
    !meta.embeddingCheckpoint &&
    // A sparse or partial checkout builds a graph missing the files it hides.
    isWorkingTreePristine(repoPath);
  // Every pointer change and the reclaim that follows run under one publish
  // lock, so a concurrent reclaim never sees a half-recorded reference.
  await withStoreLock(layout, 'publish', async () => {
    let keptStaging = false;
    if (shareable) {
      const target = commitGraphDir(layout, currentCommit, featureKeyOf(meta));
      const targetGraph = path.join(target, LBUG_DIRECTORY);
      let published = await exists(targetGraph);
      // A commit graph published before embedding checkpoints were kept
      // private may hold fewer embeddings than this checkout's own graph.
      // Keep the better private graph; the commit graph stays as it is, since
      // other checkouts may read it.
      const targetMeta = published ? await loadMeta(target) : null;
      const ownIsBetter =
        published &&
        (!targetMeta ||
          !!targetMeta.embeddingCheckpoint ||
          (targetMeta.stats?.embeddings ?? 0) < (meta.stats?.embeddings ?? 0)) &&
        (await exists(own));
      if (ownIsBetter) {
        published = false;
        log(
          `Shared store: commit graph ${currentCommit.slice(0, 12)} is less complete; keeping the private graph.`,
        );
      } else if (published) {
        try {
          await wipeLbugDbFiles(own);
        } catch (err) {
          // An open reader (Windows) can block the delete. The analysis
          // already succeeded; keep the private graph and try next run.
          published = false;
          log(
            `Shared store: could not drop the private graph (${(err as Error).message}); keeping it.`,
          );
        }
      } else if ((await exists(own)) && (await inspectLbugSidecars(own)).kind === 'clean') {
        await fs.mkdir(layout.commitsDir, { recursive: true });
        const staging = path.join(layout.commitsDir, `.publish-${randomUUID()}`);
        await fs.mkdir(staging);
        const commitMeta: Record<string, unknown> = { ...meta };
        for (const field of CHECKOUT_FIELDS) delete commitMeta[field];
        try {
          await fs.rename(own, path.join(staging, LBUG_DIRECTORY));
          await fs.writeFile(path.join(staging, INDEX_METADATA_FILE), JSON.stringify(commitMeta));
          await fs.rename(staging, target);
          published = true;
          log(`Shared store: published commit graph ${currentCommit.slice(0, 12)}.`);
        } catch (err) {
          // Put the graph back so the slot stays usable as a private index.
          const staged = path.join(staging, LBUG_DIRECTORY);
          const restored = await fs.rename(staged, own).then(
            () => true,
            () => false,
          );
          if (restored || !(await exists(staged))) {
            await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
            log(
              `Shared store: could not publish (${(err as Error).message}); keeping a private graph.`,
            );
          } else {
            // The staging dir now holds this checkout's only graph. Keep it,
            // and skip this run's reclaim (which deletes unreferenced staging),
            // so it can be moved back by hand; the next analyze of this
            // checkout finds no graph and rebuilds.
            keptStaging = true;
            log(
              `Shared store: could not publish (${(err as Error).message}) or restore the graph; ` +
                `it is at ${staged}.`,
            );
          }
        }
      }
      if (published) {
        meta.graphPath = targetGraph;
        await saveMeta(slot, meta);
      }
    } else if (meta.graphPath !== undefined && (await exists(own))) {
      delete meta.graphPath;
      await saveMeta(slot, meta);
    }
    // Reclaim would delete the kept staging dir as unreferenced.
    if (keptStaging) return;
    // Best effort: an unreadable store must not fail a finished analysis.
    try {
      const reclaimed = await reclaimSharedStoreLocked(layout.root);
      if (reclaimed.removed.length > 0) {
        log(`Shared store: removed ${reclaimed.removed.length} commit graph(s) no checkout uses.`);
      }
    } catch (err) {
      log(`Shared store: skipped cleanup (${(err as Error).message}).`);
    }
  });

  // The up-to-date fast path skips registration; a seeded or adopted checkout
  // must still end up registered at its slot. Branch summaries recorded for a
  // previous storage location point at sub-indexes the slot does not hold.
  const previous = findRegistryEntryByRepoPath(await readRegistry(), repoPath);
  const moved =
    previous !== undefined &&
    !registryPathEquals(canonicalizePath(previous.storagePath), canonicalizePath(slot));
  await registerRepo(repoPath, meta, { storagePath: slot, dropBranches: moved });
  await writeSharedStorePointer(repoPath, layout);
};

/** The store a checkout's registry entry already points into, if any. */
const registeredStore = (
  entries: readonly RegistryEntry[],
  repoPath: string,
): SharedStoreLayout | undefined => {
  const own = findRegistryEntryByRepoPath(entries, repoPath);
  const root = own ? storeRootOfCheckoutSlot(own.storagePath) : null;
  return root ? sharedStoreLayout(path.basename(root), repoPath) : undefined;
};

/**
 * Store for a clone with no store of its own: the store a registered sibling
 * clone (same normalized `origin` URL, checkout still present) already uses,
 * or, when siblings exist but none shares yet, a new store keyed on the
 * canonical path that sorts first among this clone and its siblings. Every
 * sibling computes that same founder key, so clones founding the store
 * concurrently still land in one store (#3374); the key is only a name, so the
 * store keeps working if the founder's checkout is later deleted. Graphs are
 * keyed by commit and feature key, so clones only ever share a graph built
 * from the same commit with the same settings. A lone clone keeps its
 * repository-local index.
 */
const siblingCloneStore = (
  entries: readonly RegistryEntry[],
  repoPath: string,
): SharedStoreLayout | undefined => {
  const remote = getRemoteUrl(repoPath);
  if (!remote) return undefined;
  const self = canonicalizePath(repoPath);
  const siblings = entries.filter(
    (e) =>
      e.remoteUrl === remote &&
      !registryPathEquals(canonicalizePath(e.path), self) &&
      existsSync(e.path),
  );
  if (siblings.length === 0) return undefined;
  const keys = siblings
    .map((e) => storeRootOfCheckoutSlot(e.storagePath))
    .filter((root): root is string => root !== null)
    .map((root) => path.basename(root))
    .sort();
  if (keys[0]) return sharedStoreLayout(keys[0], repoPath);
  // Order the way the registry compares paths: case-folded on Windows, whose
  // slot names hash the folded form too.
  const fold = (p: string): string => (registryPathEquals('A', 'a') ? p.toLowerCase() : p);
  const founder = [self, ...siblings.map((e) => canonicalizePath(e.path))].reduce((a, b) =>
    fold(b) < fold(a) ? b : a,
  );
  return sharedStoreLayout(cloneStoreKey(founder), repoPath);
};

/**
 * Store for a checkout that is not a linked worktree: the store named by
 * `--share-with`, the one its registry entry already points into, or a
 * sibling clone's store (#3352). `--share-with` requires the normalized remote
 * URL to match the member it names (R3); `analyze --no-share` records an
 * opt-out that stops automatic joining. Only tree roots participate, as in
 * `resolveSharedStore`: `getRemoteUrl` answers from any subdirectory, so
 * without this gate `analyze --skip-git <clone>/pkg` would join (#3374).
 */
export const resolveOptedInStore = async (
  repoPath: string,
  shareWith: string | undefined,
): Promise<SharedStoreLayout | undefined> => {
  if (!hasGitDir(repoPath)) {
    if (!shareWith) return undefined;
    throw new Error(
      `--share-with: "${repoPath}" is not the root of a git checkout. ` +
        'Only a clone root can share an index store.',
    );
  }
  const entries = await readRegistry();
  if (shareWith) {
    let target;
    try {
      target = resolveRegistryEntry(entries, shareWith);
    } catch {
      throw new Error(`--share-with: "${shareWith}" is not a registered repository.`);
    }
    const root = storeRootOfCheckoutSlot(target.storagePath);
    if (!root) {
      throw new Error(
        `--share-with: "${shareWith}" does not use a shared index store. ` +
          'Name a linked worktree of the repository (analyze it first).',
      );
    }
    const remote = getRemoteUrl(repoPath);
    if (!remote || remote !== target.remoteUrl) {
      throw new Error(
        `--share-with: remote URL mismatch — this checkout is "${remote ?? '(no origin remote)'}", ` +
          `"${target.name}" is "${target.remoteUrl ?? '(no origin remote)'}". ` +
          'Only clones of the same repository can share an index store.',
      );
    }
    return sharedStoreLayout(path.basename(root), repoPath);
  }
  const registered = registeredStore(entries, repoPath);
  if (registered) return registered;
  if (findRegistryEntryByRepoPath(entries, repoPath)?.shareOptOut) return undefined;
  return siblingCloneStore(entries, repoPath);
};

/**
 * The store slot a checkout is registered at, for `--no-share`. Linked
 * worktrees always share (turn sharing off with GITNEXUS_SHARED_STORE=off),
 * so only a clone can leave.
 */
export const optedInSlotToLeave = async (repoPath: string): Promise<string | undefined> => {
  if (resolveSharedStore(repoPath)) {
    throw new Error(
      '--no-share: linked worktrees always use the shared index store. ' +
        'Set GITNEXUS_SHARED_STORE=off to index every checkout into its own .gitnexus.',
    );
  }
  return registeredStore(await readRegistry(), repoPath)?.checkoutSlot;
};

/**
 * After a successful `--no-share` run: re-register the checkout at its new
 * storage and delete its old store slot, both under the old slot's index lock
 * so an analyze still running on that slot cannot re-register it afterwards
 * or write into a deleted directory. Then reclaim what only that slot used.
 */
export const leaveSharedStore = async (
  repoPath: string,
  previousSlot: string,
  newStoragePath: string,
  log: Log,
): Promise<void> => {
  const lock = await acquireIndexLock(previousSlot);
  try {
    requireExclusiveIndexLock(lock, `Cannot acquire the index lock at ${previousSlot}.`);
    await registerLeftStore(repoPath, newStoragePath);
    await removeSharedStorePointer(repoPath);
    // Last: the file lock backend keeps its lock file inside this directory.
    await fs.rm(previousSlot, { recursive: true, force: true });
  } finally {
    lock.release();
  }
  await reclaimAfterSlotRemoval(previousSlot);
  log(`Shared store: left ${previousSlot}.`);
};

/**
 * After a run that indexed outside a store: if the registry still names a
 * store slot for this checkout, re-register it at `storagePath`. No-op when
 * the entry is already elsewhere or the new location has no finished index.
 */
export const registerLeftStore = async (repoPath: string, storagePath: string): Promise<void> => {
  const entry = findRegistryEntryByRepoPath(await readRegistry(), repoPath);
  if (!entry || !storeRootOfCheckoutSlot(entry.storagePath)) return;
  const meta = await loadMeta(storagePath);
  if (!meta?.lastCommit) return;
  await registerRepo(repoPath, meta, { storagePath });
  await removeSharedStorePointer(repoPath);
};
