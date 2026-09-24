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
import { slotNameForCanonicalPath, STORAGE_PATH_ENV, STORAGE_ROOT_ENV } from './storage-slot.js';

export const SHARED_STORE_ENV = 'GITNEXUS_SHARED_STORE';
export const STORES_DIR = 'stores';

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
}

/** Sharing is off globally, or an explicit storage env override takes precedence. */
export const isSharedStoreDisabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const value = env[SHARED_STORE_ENV];
  if (value !== undefined && DISABLED_VALUES.has(value.trim().toLowerCase())) return true;
  return env[STORAGE_PATH_ENV] !== undefined || env[STORAGE_ROOT_ENV] !== undefined;
};

const hasLinkedWorktrees = (commonDir: string): boolean => {
  try {
    return fs.readdirSync(path.join(commonDir, 'worktrees')).length > 0;
  } catch {
    return false;
  }
};

/**
 * Resolve the git common dir for a tree root, or null when `checkoutPath` is
 * not a tree root (non-git folder or an arbitrary subdirectory).
 */
const readCommonDir = (checkoutPath: string): string | null => {
  const dotGit = path.join(checkoutPath, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;

  // Linked worktree: `.git` is a file `gitdir: <common>/worktrees/<name>`, and
  // that per-worktree dir holds a `commondir` file pointing back at <common>.
  let gitDir: string;
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
    if (!match) return null;
    gitDir = path.resolve(checkoutPath, match[1]);
  } catch {
    return null;
  }
  try {
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim();
    return path.resolve(gitDir, common);
  } catch {
    // Submodules also use a `gitdir:` file but have no `commondir`; they are
    // standalone repositories, not linked worktrees.
    return null;
  }
};

/**
 * Store key for a checkout, or null when the checkout does not share.
 * Main checkout and every linked worktree of one repository get the same key.
 */
export const resolveSharedStoreKey = (
  checkoutPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  if (isSharedStoreDisabled(env)) return null;
  const commonDir = readCommonDir(path.resolve(checkoutPath));
  if (!commonDir || !hasLinkedWorktrees(commonDir)) return null;
  // `<repo>/.git` keys on `<repo>` for a readable name; a bare common dir
  // (`repo.git`) keys on itself. Both hash the canonical absolute path.
  const identity = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return slotName(identity);
};

/** Name every store path for `checkoutPath` under store `key`. */
export const sharedStoreLayout = (key: string, checkoutPath: string): SharedStoreLayout => {
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
  };
};

/** Resolve the full layout for a checkout, or null when it does not share. */
export const resolveSharedStore = (
  checkoutPath: string,
  env: NodeJS.ProcessEnv = process.env,
): SharedStoreLayout | null => {
  const key = resolveSharedStoreKey(checkoutPath, env);
  return key ? sharedStoreLayout(key, checkoutPath) : null;
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
