/**
 * Shared sibling index store (#3352).
 *
 * Linked worktrees of one repository share one store under the GitNexus home:
 *
 *   <GITNEXUS_HOME>/stores/<key>/
 *     caches/                         parse-cache + durable ParsedFile store
 *     commits/<commit>-<featureKey>/  one immutable graph per commit + settings
 *     checkouts/<slot>/               one checkout's metadata, membership, and
 *                                     private graph when it has local edits
 *
 * This module only resolves identity and names paths. It never creates,
 * writes, or deletes anything.
 *
 * Membership is decided from the `.git` entry alone (no `git` subprocess), so
 * the resolver stays cheap on hot paths (hooks, every CLI call). Only tree
 * roots participate — a subdirectory of a checkout never resolves to a store,
 * mirroring the `resolveRepoIdentityRoot` gate (#1259). A repository with no
 * linked worktree keeps its repository-local `.gitnexus`.
 */

import fs from 'fs';
import path from 'path';
import { stripWindowsLongPathPrefix } from '../lib/utils.js';
import { getGlobalDir } from './global-dir.js';
import { GITNEXUS_DIR, INDEX_METADATA_FILE, LBUG_DIRECTORY } from './storage-constants.js';
import { slotNameForCanonicalPath, STORAGE_PATH_ENV, STORAGE_ROOT_ENV } from './storage-slot.js';

export const SHARED_STORE_ENV = 'GITNEXUS_SHARED_STORE';
export const STORES_DIR = 'stores';
/**
 * Written into `<checkout>/.gitnexus/` when a checkout's index lives in a
 * shared store, so tools that probe the checkout can find it (#3352 R16).
 */
export const SHARED_STORE_POINTER = 'store.json';

// Same canonical form as storage-resolver's `storageSlotName`, so a checkout's
// slot name does not depend on which spelling (symlink, 8.3 name) reached it.
const slotName = (p: string): string => {
  const resolved = path.resolve(p);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  return slotNameForCanonicalPath(stripWindowsLongPathPrefix(canonical));
};

const DISABLED_VALUES = new Set(['off', '0', 'false', 'no']);
const COMMIT_RE = /^[0-9a-f]{7,64}$/;
const FEATURE_KEY_RE = /^[0-9a-f]{8,64}$/;

export interface SharedStoreLayout {
  /** Store key: readable basename plus a hash of the canonical git common dir. */
  key: string;
  root: string;
  cachesDir: string;
  commitsDir: string;
  checkoutsDir: string;
  /** This checkout's slot — the registry `storagePath` for a shared checkout. */
  checkoutSlot: string;
  /** The main checkout (parent of the git common dir); null for a bare repository. */
  canonicalCheckout: string | null;
}

/** Sharing is off globally, or an explicit storage env override takes precedence. */
export const isSharedStoreDisabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const value = env[SHARED_STORE_ENV];
  if (value !== undefined && DISABLED_VALUES.has(value.trim().toLowerCase())) return true;
  return env[STORAGE_PATH_ENV] !== undefined || env[STORAGE_ROOT_ENV] !== undefined;
};

// Every filesystem sink below rebuilds its path under a fixed parent and keeps
// an inline `path.relative` barrier on that value: checkout paths arrive from
// the HTTP analyze API and CodeQL does not treat a helper as a sanitizer.

const hasLinkedWorktrees = (commonDir: string): boolean => {
  const parent = path.resolve(commonDir);
  const worktrees = path.resolve(parent, 'worktrees');
  const rel = path.relative(parent, worktrees);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    return fs.readdirSync(worktrees).length > 0;
  } catch {
    return false;
  }
};

/** Read a small text file inside `parent`, or null when it is absent/unreadable. */
const readFileIn = (
  parent: string,
  name: string,
): { text: string } | { directory: true } | null => {
  const root = path.resolve(parent);
  const target = path.resolve(root, name);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return { text: fs.readFileSync(target, 'utf-8') };
  } catch (err) {
    // A single read (no stat first) avoids a check-then-use race; a directory
    // answers with EISDIR.
    return (err as NodeJS.ErrnoException).code === 'EISDIR' ? { directory: true } : null;
  }
};

/**
 * Resolve the git common dir for a tree root, or null when `checkoutPath` is
 * not a tree root (non-git folder or an arbitrary subdirectory).
 */
const readCommonDir = (checkoutPath: string): string | null => {
  const root = path.resolve(checkoutPath);
  const dotGit = readFileIn(root, '.git');
  if (!dotGit) return null;
  if ('directory' in dotGit) return path.join(root, '.git');

  // Linked worktree: `.git` is a file `gitdir: <common>/worktrees/<name>`, and
  // that per-worktree dir holds a `commondir` file pointing back at <common>.
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(dotGit.text);
  if (!match) return null;
  const gitDir = path.resolve(root, match[1]);
  const common = readFileIn(gitDir, 'commondir');
  // Submodules also use a `gitdir:` file but have no `commondir`; they are
  // standalone repositories, not linked worktrees.
  if (!common || !('text' in common)) return null;
  return path.resolve(gitDir, common.text.trim());
};

/**
 * Store key for a checkout, or null when the checkout does not share.
 * Main checkout and every linked worktree of one repository get the same key.
 */
const resolveIdentity = (
  checkoutPath: string,
  env: NodeJS.ProcessEnv,
): { key: string; canonicalCheckout: string | null } | null => {
  if (isSharedStoreDisabled(env)) return null;
  const commonDir = readCommonDir(path.resolve(checkoutPath));
  if (!commonDir || !hasLinkedWorktrees(commonDir)) return null;
  // `<repo>/.git` keys on `<repo>` for a readable name; a bare common dir
  // (`repo.git`) keys on itself. Both hash the canonical absolute path.
  const canonicalCheckout = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
  return { key: slotName(canonicalCheckout ?? commonDir), canonicalCheckout };
};

export const resolveSharedStoreKey = (
  checkoutPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null => resolveIdentity(checkoutPath, env)?.key ?? null;

/** Name every store path for `checkoutPath` under store `key`. */
export const sharedStoreLayout = (
  key: string,
  checkoutPath: string,
  canonicalCheckout: string | null = null,
): SharedStoreLayout => {
  const storesRoot = path.join(getGlobalDir(), STORES_DIR);
  const root = path.resolve(storesRoot, key);
  if (path.dirname(root) !== path.resolve(storesRoot)) {
    throw new Error(`Shared store key escapes the stores directory: ${key}`);
  }
  const checkoutsDir = path.join(root, 'checkouts');
  return {
    key,
    root,
    cachesDir: path.join(root, 'caches'),
    commitsDir: path.join(root, 'commits'),
    checkoutsDir,
    checkoutSlot: path.join(checkoutsDir, slotName(checkoutPath)),
    canonicalCheckout,
  };
};

/** Resolve the full layout for a checkout, or null when it does not share. */
export const resolveSharedStore = (
  checkoutPath: string,
  env: NodeJS.ProcessEnv = process.env,
): SharedStoreLayout | null => {
  const identity = resolveIdentity(checkoutPath, env);
  return identity
    ? sharedStoreLayout(identity.key, checkoutPath, identity.canonicalCheckout)
    : null;
};

/** Directory of the immutable graph for one commit and feature key. */
export const commitGraphDir = (
  layout: SharedStoreLayout,
  commit: string,
  featureKey: string,
): string => {
  if (!COMMIT_RE.test(commit)) throw new Error(`Invalid commit id for shared store: ${commit}`);
  if (!FEATURE_KEY_RE.test(featureKey)) {
    throw new Error(`Invalid feature key for shared store: ${featureKey}`);
  }
  return path.join(layout.commitsDir, `${commit}-${featureKey}`);
};

// A single path segment: `..repo-<hash>` is a legal slot name, `..` is not.
const isDirectChild = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !path.isAbsolute(rel) && !rel.includes(path.sep);
};

/**
 * Store root for a checkout slot (`<stores>/<key>/checkouts/<slot>`), or null
 * when `storagePath` is not a checkout slot. Pure path check — no I/O.
 */
export const storeRootOfCheckoutSlot = (storagePath: string): string | null => {
  const storesRoot = path.resolve(getGlobalDir(), STORES_DIR);
  const slot = path.resolve(storagePath);
  const checkoutsDir = path.dirname(slot);
  const root = path.dirname(checkoutsDir);
  if (path.basename(checkoutsDir) !== 'checkouts') return null;
  if (!isDirectChild(checkoutsDir, slot) || !isDirectChild(storesRoot, root)) return null;
  return root;
};

/**
 * The graph a flat storage slot reads.
 *
 * Non-shared storage is always `<storagePath>/lbug`, with no I/O. A shared
 * checkout slot may record `graphPath` in its metadata, naming a commit graph
 * in the same store; any other recorded value (outside the store, a sibling's
 * private slot, unreadable metadata) falls back to the slot's own graph so a
 * hand-edited file cannot redirect reads.
 */
// Store-slot metadata can be megabytes (file hashes, cache keys) and this runs
// on hot paths (MCP repo refresh, every getStoragePaths). Re-parse only when
// the file's identity changes; a stat is the per-call cost.
// ponytail: unbounded map keyed by slot path — one entry per shared checkout,
// small; add eviction if a process ever tracks thousands of slots.
const recordedGraphCache = new Map<string, { key: string; recorded: unknown }>();

const readRecordedGraphPath = (slot: string): unknown => {
  const root = path.resolve(slot);
  const metaPath = path.resolve(root, INDEX_METADATA_FILE);
  const rel = path.relative(root, metaPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  // One open, then stat and read through the same descriptor, so the cache
  // key always describes the bytes that were parsed.
  const fd = fs.openSync(metaPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const cached = recordedGraphCache.get(metaPath);
    if (cached?.key === key) return cached.recorded;
    const recorded = (JSON.parse(fs.readFileSync(fd, 'utf-8')) as { graphPath?: unknown })
      .graphPath;
    recordedGraphCache.set(metaPath, { key, recorded });
    return recorded;
  } finally {
    fs.closeSync(fd);
  }
};

export const resolveGraphPath = (storagePath: string): string => {
  const own = path.join(storagePath, LBUG_DIRECTORY);
  const root = storeRootOfCheckoutSlot(storagePath);
  if (!root) return own;
  let recorded: unknown;
  try {
    recorded = readRecordedGraphPath(storagePath);
  } catch {
    return own;
  }
  if (typeof recorded !== 'string' || !path.isAbsolute(recorded)) return own;
  const graph = path.resolve(recorded);
  const commitDir = path.dirname(graph);
  const valid =
    path.basename(graph) === LBUG_DIRECTORY && isDirectChild(path.join(root, 'commits'), commitDir);
  return valid ? graph : own;
};

/**
 * The store slot named by `<checkout>/.gitnexus/store.json`, or null. The
 * recorded slot must be this checkout's own slot under the stores directory,
 * so a copied or hand-edited pointer cannot redirect reads to another index.
 */
export const readSharedStorePointer = (checkoutPath: string): string | null => {
  const root = path.resolve(checkoutPath);
  const pointerPath = path.resolve(root, GITNEXUS_DIR, SHARED_STORE_POINTER);
  const pointerRel = path.relative(root, pointerPath);
  if (pointerRel.startsWith('..') || path.isAbsolute(pointerRel)) return null;
  let recorded: unknown;
  try {
    recorded = (JSON.parse(fs.readFileSync(pointerPath, 'utf-8')) as { checkoutSlot?: unknown })
      .checkoutSlot;
  } catch {
    return null;
  }
  if (typeof recorded !== 'string' || !path.isAbsolute(recorded)) return null;
  const slot = path.resolve(recorded);
  if (!storeRootOfCheckoutSlot(slot)) return null;
  return path.basename(slot) === slotName(checkoutPath) ? slot : null;
};
