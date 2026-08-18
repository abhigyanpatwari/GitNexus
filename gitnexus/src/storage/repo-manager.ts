/**
 * Repository Manager
 *
 * Manages GitNexus index storage:
 * - Per-repo metadata file (gitnexus.json) under .gitnexus/, dual-written to a
 *   legacy meta.json mirror for backward compatibility (see MIGRATION.md)
 * - .gitnexus/ directory for local metadata and caches (parse-cache, parsedfile-store)
 * - Global registry at ~/.gitnexus/registry.json for MCP server discovery
 *
 * gitnexus.json is simply a filename distinct from the generic meta.json — it
 * has no bearing on git worktree behavior. .gitnexus/ remains fully git-ignored
 * in every case; each worktree already has its own independent .gitnexus/ by
 * construction (getStoragePath is per-checkout), regardless of which filename
 * the metadata inside it uses.
 */

import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import { getInferredRepoName, resolveRepoIdentityRoot, stripUrlCredentials } from './git.js';
import { stripWindowsLongPathPrefix } from '../lib/utils.js';
import { writeFileAtomic } from './fs-atomic.js';
import { logger } from '../core/logger.js';
import { acquireIndexLock, IndexLockTimeoutError, type IndexLockHandle } from './index-lock.js';
import {
  branchSlug,
  BRANCHES_DIR,
  resolveBranchPlacement,
  type BranchSummary,
} from './branch-index.js';
import {
  GITNEXUS_DIR,
  INDEX_METADATA_FILE,
  LEGACY_METADATA_FILE,
  getStoragePath,
  isMissingFilesystemError,
  loadMeta,
  tryReadMetaFile,
  type AnalyzerRunnerIdentity,
  type RepoMeta,
} from './repo-meta.js';
import {
  defaultStoragePath,
  ensureStoragePathWritable,
  InvalidStoragePathError,
  validateConfiguredStoragePath,
} from './storage-resolver.js';

// Re-export the #2106 branch primitives (extracted to branch-index.ts, R10) so
// existing `repo-manager` import sites and tests keep working unchanged.
export { branchSlug, resolveBranchPlacement };
export type { BranchSummary };

// Re-export the metadata primitives (extracted to repo-meta.ts) for the same
// reason. They moved DOWN a layer so `branch-index.ts` can read the flat slot's
// metadata without importing back out of this module — see repo-meta.ts for the
// cycle that made the extraction necessary. `LEGACY_METADATA_FILE` and
// `tryReadMetaFile` stay module-private here, exactly as before.
export { getStoragePath, INDEX_METADATA_FILE, isMissingFilesystemError, loadMeta };
export { ensureStoragePathWritable, InvalidStoragePathError };
export { CONTENT_RETENTION_SCHEMA_VERSION } from './repo-meta.js';
export type { ContentRetention, FtsProfile } from './repo-meta.js';
export type { AnalyzerRunnerIdentity, RepoMeta };

/**
 * Normalise a repo path for registry comparison across platforms
 * (#664 review feedback from @evander-wang).
 *
 * Why this exists: `path.resolve` alone is NOT enough for
 * cross-platform registry stability.
 *   - **macOS**: tmpdirs and `/var` are symlinks to `/private/var`.
 *     A child process that stored `/private/var/folders/.../repo` in
 *     the registry cannot later be matched by an outer caller that
 *     supplies the symlink form `/var/folders/.../repo`. `path.resolve`
 *     does not follow symlinks; `realpathSync.native` does.
 *   - **Windows**: GitHub runners surface tmpdirs in 8.3 short-name
 *     form (`RUNNERA~1\...`), but `process.cwd()` often returns the
 *     long form (`runneradmin\...`). `realpathSync.native` normalises
 *     both sides to the long-name canonical path.
 *   - **Windows, extended-length paths** (#2667): a caller can supply a
 *     `\\?\`-prefixed path — the usual MAX_PATH workaround — and
 *     `path.resolve` preserves the prefix, so the string compare below
 *     never matches the un-prefixed entry the registry stores. The
 *     realpath branch already dropped it (libuv strips the prefix inside
 *     `fs__realpath`), but the fallback branch did not, which is exactly
 *     the branch a missing path takes. `stripWindowsLongPathPrefix` is
 *     applied to both so the two branches agree.
 *
 * This normalisation is safe here precisely because the result is only ever
 * compared, never opened: Node does NOT re-add `\\?\` for over-MAX_PATH
 * paths, so an fs-facing path must keep whatever form the caller gave it.
 * See the `registerRepo` comment on applying canonicalisation at COMPARE
 * points only.
 *
 * Fallback behaviour: if the path does not exist on disk (e.g. a user
 * passed `gitnexus remove some-alias` and the alias misses every
 * registry entry, or the caller is resolving a path that was deleted
 * after registration), we return `path.resolve(p)` rather than
 * throwing. This preserves the idempotent-on-missing semantics of
 * `resolveRegistryEntry` / `remove`.
 *
 * Backwards compatibility: this function is applied to BOTH the
 * caller-supplied input AND each stored `entry.path` at compare time
 * inside `resolveRegistryEntry`, so registries written by older
 * versions still match correctly. Entries are NOT canonicalised at
 * write time — `registerRepo` stores `path.resolve(repoPath)` — which
 * is what makes the compare-only rule above hold.
 */
export const canonicalizePath = (p: string): string => {
  const resolved = path.resolve(p);
  try {
    return stripWindowsLongPathPrefix(realpathSync.native(resolved));
  } catch {
    return stripWindowsLongPathPrefix(resolved);
  }
};

/**
 * Compare two already-canonicalised registry paths. Case-insensitive on Windows
 * (its filesystem is), case-sensitive elsewhere. Both arguments must already be
 * run through {@link canonicalizePath}; this is the single comparison the registry
 * lookups/dedup/finalize checks all share so they answer identically.
 */
export const registryPathEquals = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Does the clone dir derived from an entry's *name* actually belong to that
 * entry? Registry names are not unique across storage locations: a cloned
 * repo under `~/.gitnexus/repos/<name>` and a local repo registered under the
 * same name share a `getCloneDir(entry.name)` result. The server's delete
 * handler must therefore never remove the clone dir based on the name alone —
 * only when the entry's own `path` resolves to that dir (mirroring its step-2b
 * rule that cleanup is driven off `entry.path`, so a same-named sibling's
 * clone is never removed). Both sides are canonicalised so symlinked or
 * differently-spelled forms of the same dir still match.
 */
export const cloneDirBelongsToEntry = (cloneDir: string, entryPath: string): boolean =>
  registryPathEquals(canonicalizePath(cloneDir), canonicalizePath(entryPath));

export interface IndexedRepo {
  repoPath: string;
  storagePath: string;
  lbugPath: string;
  metaPath: string;
  meta: RepoMeta;
}

/**
 * Shape of an entry in the global registry (~/.gitnexus/registry.json)
 */
export interface RegistryEntry {
  name: string;
  path: string;
  storagePath: string;
  indexedAt: string;
  lastCommit: string;
  /** See {@link RepoMeta.remoteUrl}. Mirrored from meta at register time. */
  remoteUrl?: string;
  stats?: RepoMeta['stats'];
  /**
   * Branch name owning the flat/primary index (#2106). Mirrors the flat
   * `meta.branch`. Absent for legacy single-branch entries and non-git repos —
   * additive and backward compatible.
   */
  branch?: string;
  /**
   * Non-primary branch indexes for this same path (#2106). Absent when only the
   * primary branch is indexed, preserving the one-entry-per-path model and the
   * legacy registry shape.
   */
  branches?: BranchSummary[];
}

const GITNEXUS_EXCLUDE_ENTRY = `${GITNEXUS_DIR}/`;

// ─── Local Storage Helpers ─────────────────────────────────────────────

/**
 * Get paths to key storage files.
 *
 * `storagePath` is ALWAYS the flat `<repo>/.gitnexus` — content-addressed
 * caches (`parse-cache/`, `parsedfile-store/`) live there and are shared
 * across branches (#2106 KTD7). When `branch` is provided, both `lbugPath`
 * and `metaPath` are scoped under `branches/<slug>/`. For the flat call
 * (no `branch`), `storagePath` and `lbugPath` remain byte-identical to the
 * pre-multi-branch behavior (#2106); `metaPath`'s FILENAME changed from
 * `meta.json` to `gitnexus.json` (PR #2363) — `saveMeta` keeps a `meta.json`
 * mirror in sync for consumers that still read the legacy name.
 *
 * Each branch slot has its own metadata file:
 * - Primary/flat: <repo>/.gitnexus/gitnexus.json
 * - Feature branches: <repo>/.gitnexus/branches/<slug>/gitnexus.json
 *
 * Callers should use `loadMeta(metaDir)` and `saveMeta(metaDir, meta)` where
 * metaDir is the directory containing the metadata file — both handle the
 * legacy mirror automatically.
 */
export const getStoragePaths = (repoPath: string, branch?: string) => {
  const storagePath = getStoragePath(repoPath);
  const baseDir = branch ? path.join(storagePath, BRANCHES_DIR, branchSlug(branch)) : storagePath;
  return {
    storagePath,
    lbugPath: path.join(baseDir, 'lbug'),
    metaPath: path.join(baseDir, INDEX_METADATA_FILE), // Branch-specific metadata file
  };
};

/**
 * Check whether a KuzuDB index exists in the given storage path.
 * Non-destructive — safe to call from status commands.
 */
export const hasKuzuIndex = async (storagePath: string): Promise<boolean> => {
  try {
    await fs.stat(path.join(storagePath, 'kuzu'));
    return true;
  } catch {
    return false;
  }
};

/**
 * Clean up stale KuzuDB files after migration to LadybugDB.
 *
 * Returns:
 *   found        — true if .gitnexus/kuzu existed and was deleted
 *   needsReindex — true if kuzu existed but lbug does not (re-analyze required)
 *
 * Callers own the user-facing messaging; this function only deletes files.
 */
export const cleanupOldKuzuFiles = async (
  storagePath: string,
): Promise<{ found: boolean; needsReindex: boolean }> => {
  const oldPath = path.join(storagePath, 'kuzu');
  const newPath = path.join(storagePath, 'lbug');
  try {
    await fs.stat(oldPath);
    // Old kuzu file/dir exists — determine if lbug is already present
    let needsReindex = false;
    try {
      await fs.stat(newPath);
    } catch {
      needsReindex = true;
    }
    // Delete kuzu database file and its sidecars (.wal, .lock)
    for (const suffix of ['', '.wal', '.lock']) {
      try {
        await fs.unlink(oldPath + suffix);
      } catch {}
    }
    // Also handle the case where kuzu was stored as a directory
    try {
      await fs.rm(oldPath, { recursive: true, force: true });
    } catch {}
    return { found: true, needsReindex };
  } catch {
    // Old path doesn't exist — nothing to do
    return { found: false, needsReindex: false };
  }
};

/**
 * Save metadata to the metadata file (gitnexus.json) in the given directory,
 * dual-writing the legacy `meta.json` mirror for backward compatibility.
 *
 * Atomic via tmp-file + rename (matches `saveParseCache`'s pattern). The
 * `incrementalInProgress` dirty flag travels through this file — a crash
 * mid-write would leave a corrupt `gitnexus.json` that the next run's
 * `loadMeta` would silently treat as "no prior index", losing the dirty
 * flag and skipping the recovery full-rebuild. Write-and-rename rules
 * that out: the rename is atomic on POSIX and on Windows (`fs.rename`
 * on `node:fs/promises` uses `MoveFileEx(REPLACE_EXISTING)`), so either
 * the old or the new file is observed at every moment.
 *
 * `gitnexus.json` is the primary write and must succeed. `meta.json` is a
 * best-effort mirror kept for consumers that only know the legacy filename
 * (see MIGRATION.md) — its write failure is logged, not thrown, so a
 * mirror-write hiccup never fails the caller's analyze run.
 */
export const saveMeta = async (metaDir: string, meta: RepoMeta): Promise<void> => {
  await fs.mkdir(metaDir, { recursive: true });
  // Serialised once: `meta` carries a fileHashes entry per file, so on a large
  // repo this string is megabytes and both writes want the identical bytes.
  const json = JSON.stringify(meta, null, 2);
  await writeFileAtomic(path.join(metaDir, INDEX_METADATA_FILE), json);
  try {
    await writeFileAtomic(path.join(metaDir, LEGACY_METADATA_FILE), json);
  } catch (err) {
    logger.warn({ err, metaDir }, 'Failed to write legacy meta.json mirror (non-critical)');
  }
};

/**
 * Check if a path has a GitNexus index (metadata file or legacy location)
 */
export const hasIndex = async (repoPath: string): Promise<boolean> => {
  const paths = getStoragePaths(repoPath);
  // Check new metadata file first
  try {
    await fs.access(paths.metaPath);
    return true;
  } catch {
    // Fall back to legacy location
    try {
      await fs.access(path.join(paths.storagePath, LEGACY_METADATA_FILE));
      return true;
    } catch {
      return false;
    }
  }
};

/**
 * Load an indexed repo from a path (checks metadata file first, then legacy)
 */
export const loadRepo = async (repoPath: string): Promise<IndexedRepo | null> => {
  const paths = getStoragePaths(repoPath);
  const meta = await loadMeta(paths.storagePath);
  if (!meta) return null;

  return {
    repoPath: path.resolve(repoPath),
    ...paths,
    meta,
  };
};

/** `indexedAt` as epoch millis; 0 when absent/unparseable (i.e. oldest). */
const metaTimestamp = (meta: RepoMeta): number => {
  const t = Date.parse(meta.indexedAt ?? '');
  return Number.isFinite(t) ? t : 0;
};

/**
 * Reconcile `gitnexus.json` and the legacy `meta.json` mirror in one
 * directory: whichever parses and is fresher (by `indexedAt`) wins and is
 * re-written to BOTH files via `saveMeta`. Never deletes anything.
 * Returns true when a write occurred.
 */
const reconcileMetaDir = async (dir: string): Promise<boolean> => {
  const primary = await tryReadMetaFile(dir, INDEX_METADATA_FILE);
  const legacy = await tryReadMetaFile(dir, LEGACY_METADATA_FILE);

  if (!primary && !legacy) {
    // Fresh directory (neither file) is a silent no-op; a file that exists
    // but doesn't parse deserves a warning — loadMeta will treat it as "no
    // prior index" and the next successful saveMeta self-heals it.
    for (const filename of [INDEX_METADATA_FILE, LEGACY_METADATA_FILE]) {
      try {
        await fs.access(path.join(dir, filename));
        logger.warn(
          { dir, filename },
          'Metadata file exists but is unreadable/corrupt; leaving as-is (next successful analyze rewrites it)',
        );
      } catch {
        // absent — expected for a fresh directory
      }
    }
    return false;
  }

  if (primary && legacy) {
    if (JSON.stringify(primary) === JSON.stringify(legacy)) return false; // converged
    // Both parse but differ — the fresher one wins (an older binary may have
    // re-analyzed and written only meta.json AFTER gitnexus.json was created;
    // blind-preferring the primary would permanently shadow that fresher
    // state, silently certifying a stale index as up to date).
    const winner = metaTimestamp(legacy) > metaTimestamp(primary) ? legacy : primary;
    await saveMeta(dir, winner);
    logger.info(
      { dir, winner: winner === legacy ? LEGACY_METADATA_FILE : INDEX_METADATA_FILE },
      'Reconciled diverged metadata files (fresher indexedAt wins, written to both)',
    );
    return true;
  }

  // Exactly one parses — establish/repair the other so both stay in sync.
  const survivor = (primary ?? legacy) as RepoMeta;
  await saveMeta(dir, survivor);
  return true;
};

/**
 * Reconcile the metadata files for a repo's flat slot and every
 * `branches/<slug>/` slot. Runs once per `analyze` (see run-analyze.ts).
 *
 * This is a best-effort compatibility sync, NOT a one-way migration: the
 * legacy `meta.json` mirror is kept in sync indefinitely (removal happens at
 * a future major version — see MIGRATION.md), so older binaries, still-running
 * MCP servers, and the shipped editor hooks keep working, and a rollback to a
 * pre-rename version sees current metadata instead of "no prior index".
 * Returns true when any file was written.
 */
export const reconcileMetadataFiles = async (repoPath: string): Promise<boolean> => {
  const storagePath = getStoragePath(repoPath);
  let changed = await reconcileMetaDir(storagePath);

  const branchesDir = path.join(storagePath, BRANCHES_DIR);
  let branchDirs: string[];
  try {
    branchDirs = await fs.readdir(branchesDir);
  } catch {
    // branchesDir may not exist (not a multi-branch repo) — expected, silent.
    return changed;
  }

  for (const branchDir of branchDirs) {
    const branchPath = path.join(branchesDir, branchDir);
    // Per-branch isolation: one bad branch dir (dangling symlink, EACCES)
    // must not silently abort reconciliation for every branch after it —
    // readdir order is stable, so an unguarded throw here would permanently
    // starve the same trailing branches on every run.
    try {
      const stat = await fs.stat(branchPath);
      if (!stat.isDirectory()) continue;
      if (await reconcileMetaDir(branchPath)) changed = true;
    } catch (err) {
      logger.warn(
        { branchDir, err },
        'Skipping branch directory during metadata reconciliation (non-critical)',
      );
    }
  }

  return changed;
};

/**
 * Find .gitnexus by walking up from a starting path
 */
export const findRepo = async (startPath: string): Promise<IndexedRepo | null> => {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    const repo = await loadRepo(current);
    if (repo) return repo;
    current = path.dirname(current);
  }

  return null;
};

export function isReadOnlyFilesystemError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EROFS' || code === 'EACCES' || code === 'EPERM';
}

/**
 * Keep .gitnexus/ ignored. It contains local index state and caches.
 */
export const ensureGitNexusIgnored = async (repoPath: string): Promise<void> => {
  const gitignorePath = path.join(getStoragePath(repoPath), '.gitignore');
  const desired = '*\n';

  // Idempotent fast path: skip the write entirely when the file already has
  // the expected content. Lets this run cleanly on read-only mounts (e.g.
  // the documented Docker workflow with WORKSPACE_DIR bound :ro) when an
  // earlier `analyze` already created the file. See issue #1549.
  try {
    if ((await fs.readFile(gitignorePath, 'utf-8')) === desired) {
      await ensureGitInfoExclude(repoPath);
      return;
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  try {
    await fs.mkdir(path.dirname(gitignorePath), { recursive: true });
    await fs.writeFile(gitignorePath, desired, 'utf-8');
  } catch (err: any) {
    if (isReadOnlyFilesystemError(err)) {
      logger.warn(
        { path: gitignorePath, code: err.code },
        'GitNexus storage filesystem is not writable; skipping .gitnexus/.gitignore. Cache files may appear as untracked in this repo locally.',
      );
    } else {
      throw err;
    }
  }

  await ensureGitInfoExclude(repoPath);
};

const ensureGitInfoExclude = async (repoPath: string): Promise<void> => {
  const gitDirPath = path.join(path.resolve(repoPath), '.git');
  const excludePath = path.join(gitDirPath, 'info', 'exclude');

  try {
    const gitDir = await fs.stat(gitDirPath);
    if (!gitDir.isDirectory()) return;
  } catch {
    return;
  }

  let content = '';
  try {
    content = await fs.readFile(excludePath, 'utf-8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const excludes = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (excludes.includes(GITNEXUS_DIR) || excludes.includes(GITNEXUS_EXCLUDE_ENTRY)) return;

  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  try {
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, `${content}${separator}${GITNEXUS_EXCLUDE_ENTRY}\n`, 'utf-8');
  } catch (err: any) {
    if (isReadOnlyFilesystemError(err)) {
      logger.warn(
        { path: excludePath, code: err.code },
        'GitNexus storage filesystem is not writable; skipping .git/info/exclude update. .gitnexus/ cache directory may appear as untracked in `git status` locally.',
      );
    } else {
      throw err;
    }
  }
};

// ─── Global Registry (~/.gitnexus/registry.json) ───────────────────────

/**
 * Get the path to the global GitNexus directory
 */
export const getGlobalDir = (): string => {
  return process.env.GITNEXUS_HOME || path.join(os.homedir(), '.gitnexus');
};

/**
 * Get the path to the global registry file
 */
export const getGlobalRegistryPath = (): string => {
  return path.join(getGlobalDir(), 'registry.json');
};

/**
 * Lock namespace for the global registry.
 *
 * Deliberately a dedicated sub-directory rather than {@link getGlobalDir}
 * itself: an index slot's lock dir is always `<repo>/.gitnexus` (or
 * `<repo>/.gitnexus/branches/<slug>`), so for a repository rooted at the
 * user's home directory — dotfiles-at-`$HOME` is a real layout — the per-repo
 * analyze lock and the global-dir lock would resolve to the SAME directory.
 * `acquireIndexLock` is not reentrant, so `runFullAnalysis` (which holds the
 * per-repo lock across its whole pipeline) would then self-deadlock the moment
 * it reached `registerRepo`/`adoptFlatBranchLabel`. No repo's index slot can
 * ever be named `registry-lock`, so this namespace cannot collide.
 */
const getRegistryLockDir = (): string => path.join(getGlobalDir(), 'registry-lock');

/**
 * Wait ceiling for the registry lock. A registry transaction is a sub-second
 * JSON read/merge/write, so it must NOT inherit the index lock's 10-minute
 * default (sized for multi-minute analyze runs): `gitnexus augment` runs on
 * every editor/agent tool call with a documented sub-500ms cold-start budget
 * and reaches this lock via `listRegisteredRepos({ validate: true })`.
 */
const REGISTRY_LOCK_TIMEOUT_MS = 5_000;

/**
 * Serialize global registry read/merge/write transactions across processes.
 *
 * The registry is shared by every indexed repository, so per-index locks do
 * not protect this file. Reuse the cross-platform index lock primitive with a
 * registry-private lock namespace; the handle is kernel-owned on supported
 * platforms and crash-reclaimable by the existing fallback.
 *
 * On timeout the transaction proceeds UNLOCKED rather than throwing: the lock
 * closes a lost-update race that existed unguarded before #2716, so degrading
 * to the old best-effort behaviour is strictly better than failing an
 * `analyze`/`list`/`augment` outright on a wedged lock (a stale pid-reuse
 * ghost on platforms without start-time verification can look live forever).
 */
const withRegistryLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  let lock: IndexLockHandle | null = null;
  try {
    lock = await acquireIndexLock(getRegistryLockDir(), {
      timeoutMs: REGISTRY_LOCK_TIMEOUT_MS,
      // Registry contention was previously invisible: `acquireIndexLock`'s own
      // `log` texts name an "analyze" holder, which misattributes a registry
      // wait, so surface a registry-specific line instead (#2716 review).
      onWaitStart: () =>
        logger.info('Waiting for another GitNexus process to finish a registry update…'),
    });
  } catch (err) {
    if (!(err instanceof IndexLockTimeoutError)) throw err;
    logger.warn(
      { timeoutMs: REGISTRY_LOCK_TIMEOUT_MS },
      'Timed out waiting for the global registry lock; proceeding without it. A concurrent registry write may be lost.',
    );
  }
  try {
    return await operation();
  } finally {
    lock?.release();
  }
};

/**
 * Drop credentials from every entry's `remoteUrl` (#2914).
 *
 * Applied on BOTH registry edges. Capture-time stripping in `getRemoteUrl`
 * only covers values this version writes; a `registry.json` (or a per-repo
 * meta that a re-register copies forward) written by an older version still
 * holds the credential. Reading through here keeps it out of every consumer —
 * `listRegisteredRepos`, MCP `list_repos`, `gitnexus list`, group sync — and
 * writing through here means the next registry write drops it at rest instead
 * of round-tripping it back to disk.
 *
 * Sanitised values compare equal to a freshly captured `getRemoteUrl`, so
 * sibling-clone matching (#2054) is unaffected: both sides lose the same span.
 */
const sanitizeEntries = (entries: RegistryEntry[]): RegistryEntry[] =>
  entries.map((e) => {
    if (!e.remoteUrl) return e;
    const cleaned = stripUrlCredentials(e.remoteUrl);
    return cleaned === e.remoteUrl ? e : { ...e, remoteUrl: cleaned };
  });

/**
 * Read the global registry. Returns empty array if not found.
 */
export const readRegistry = async (): Promise<RegistryEntry[]> => {
  try {
    const raw = await fs.readFile(getGlobalRegistryPath(), 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    // `storagePath` was not present in pre-external-storage registry files.
    // Normalize only that legacy absence at the read boundary; malformed values
    // remain visible to the existing destructive-operation safety checks.
    const entries = data.map((entry) =>
      entry && typeof entry.path === 'string' && entry.storagePath === undefined
        ? { ...entry, storagePath: defaultStoragePath(entry.path) }
        : entry,
    ) as RegistryEntry[];
    return sanitizeEntries(entries);
  } catch {
    return [];
  }
};

/**
 * Write the global registry to disk.
 *
 * Atomic tmp+rename: a crash mid-write can never leave a truncated
 * registry.json that the next load would treat as empty and silently drop
 * every registered repo (#2106 R9). The tmp path must stay per-write — the
 * registry is the one file every gitnexus process on the machine writes, and
 * `withRegistryLock` degrades to unlocked on timeout, so the write cannot rely
 * on the lock to keep two writers off one staging path (#2888).
 *
 * `attempts` is forwarded to the rename retry; best-effort callers pass `1`.
 */
const writeRegistry = async (entries: RegistryEntry[], attempts?: number): Promise<void> => {
  await fs.mkdir(getGlobalDir(), { recursive: true });
  await writeFileAtomic(
    getGlobalRegistryPath(),
    JSON.stringify(sanitizeEntries(entries), null, 2),
    attempts,
  );
};

/**
 * Options for {@link registerRepo}. All optional — callers without any
 * disambiguation requirement can keep calling `registerRepo(path, meta)`
 * unchanged.
 */
export interface RegisterRepoOptions {
  /**
   * User-provided alias from `analyze --name <alias>` (#829). Overrides
   * the default basename-derived registry `name`. Persisted — subsequent
   * re-analyses of the same path without `--name` preserve the alias.
   */
  name?: string;
  /**
   * Allow two DIFFERENT repo paths to register under the same alias
   * (#829). Mapped from the `--allow-duplicate-name` CLI flag.
   *
   * Scope: this flag governs cross-path alias sharing only — one repo
   * path always has exactly one registry entry (and therefore exactly
   * one alias). Re-analyzing the same path with `--name Y` overwrites
   * a previous `--name X`; it does NOT create a second entry or a
   * second alias for the same path (see the upsert-by-resolved-path
   * logic in {@link registerRepo} and the
   * `re-registerRepo with a different name overrides the previous
   * alias` test in `test/unit/repo-manager.test.ts`).
   *
   * Distinct from `--force` (which only triggers pipeline re-index);
   * a user accepting a duplicate alias should not be forced to also
   * re-run the full pipeline.
   */
  allowDuplicateName?: boolean;
  /**
   * Non-primary branch this run indexed (#2106). When set, the branch's
   * summary is upserted into the entry's `branches[]` and the primary
   * top-level fields are left untouched. When `undefined`, this is a
   * primary/flat run that refreshes the top-level fields (and preserves any
   * existing branch summaries).
   */
  branch?: string;
}

/**
 * Thrown by {@link registerRepo} when a requested name is already in
 * use by a DIFFERENT path. The CLI layer surfaces this as an actionable
 * error instead of relying on `.message` string-matching.
 *
 * The colliding alias is exposed as `err.registryName` (not `err.name`).
 * `err.name` keeps its inherited `Error.prototype.name` semantics (the
 * class name) so downstream code can do the usual `err.name ===
 * 'RegistryNameCollisionError'` checks; use the `kind` discriminant or
 * `instanceof RegistryNameCollisionError` for type-safe narrowing.
 */
export class RegistryNameCollisionError extends Error {
  readonly kind = 'RegistryNameCollisionError' as const;
  constructor(
    public readonly registryName: string,
    public readonly existingPath: string,
    public readonly requestedPath: string,
  ) {
    super(
      `Registry name "${registryName}" is already used by "${existingPath}".\n` +
        `Pass --name <alias> to register "${requestedPath}" under a different name, ` +
        `or --allow-duplicate-name to allow both paths under the same name (leaves -r <name> ambiguous for these two).`,
    );
    this.name = 'RegistryNameCollisionError';
  }
}

/** Returns true when a previously-registered entry's `name` differs from
 *  both `path.basename(entry.path)` and the git-remote-derived name —
 *  i.e. a user explicitly aliased it via `analyze --name <alias>` on a
 *  prior run. Used to preserve the alias across re-analyses that omit
 *  `--name`. The remote-derived name is treated as an inference, not a
 *  custom alias, so re-analyses keep tracking remote renames.
 *
 *  `inferredName` is passed in (rather than re-derived) so callers can
 *  avoid a second `git config` subprocess invocation. */
const hasCustomAlias = (entry: RegistryEntry, inferredName: string | null): boolean => {
  const resolved = path.resolve(entry.path);
  if (entry.name === path.basename(resolved)) return false;
  // Canonical-root-derived names are not user aliases either (#1259):
  // a worktree registered under the canonical repo's basename
  // (e.g. `{name: 'repo', path: '/repo/wt-feature'}`) must re-register
  // cleanly without firing the duplicate-name collision guard. Without
  // this check `entry.name = 'repo'` !== `path.basename('/repo/wt-feature') = 'wt-feature'`,
  // so the prior check returns true → `isPreservedAlias = true` → guard
  // throws `RegistryNameCollisionError` against the also-registered
  // canonical checkout entry. The Claude-Code per-task worktree workflow
  // — analyze canonical, then analyze worktree, then re-analyze worktree
  // — would break on the third call.
  if (entry.name === path.basename(resolveRepoIdentityRoot(resolved))) return false;
  if (inferredName && entry.name === inferredName) return false;
  return true;
};

/**
 * Register (add or update) a repo in the global registry.
 * Called after `gitnexus analyze` completes.
 *
 * Name resolution precedence (#829, #979):
 *   1. explicit `opts.name` (from `analyze --name <alias>`)
 *   2. preserved alias on an existing entry for this path
 *   3. `git config --get remote.origin.url` repo name (#979 — recovers
 *      a meaningful name for monorepo subprojects, git worktrees, and
 *      Gas-Town-style `<rig>/refinery/rig/` layouts where the basename
 *      is generic)
 *   4. `path.basename(repoPath)` (the original default)
 *
 * Duplicate-name guard: if another path already uses the resolved
 * `name`, throw {@link RegistryNameCollisionError} unless
 * `opts.allowDuplicateName` is set. The guard ONLY fires when the user explicitly passed a
 * `name`; un-aliased basename collisions continue to register silently
 * so existing users who don't know about `--name` see no behaviour
 * change.
 *
 * Returns the `name` that was actually written to the registry — the
 * caller can re-use it to keep AGENTS.md / skill files aligned with the
 * MCP-visible repo name (#979).
 */
const registerRepoUnlocked = async (
  repoPath: string,
  meta: RepoMeta,
  opts?: RegisterRepoOptions,
): Promise<string> => {
  // Preserve the caller's chosen path form in the registry — don't
  // canonicalise at write time. This matters for two reasons:
  //   1. `list` and error messages show the path the user actually
  //      knows (e.g. the 8.3 short form they typed), not a runtime-
  //      resolved long form they've never seen.
  //   2. Keeps pre-existing #829 test assertions that compare
  //      `err.existingPath` against `path.resolve(tmpPath)` stable.
  // Canonicalisation is applied at COMPARE points only (see below),
  // which is where the cross-platform divergence actually matters.
  const resolved = path.resolve(repoPath);
  const { storagePath } = getStoragePaths(resolved);

  // Canonical form used strictly for comparison — `realpathSync.native`
  // expands macOS /var → /private/var and Windows 8.3 → long-name,
  // falling back to `path.resolve` when the path doesn't exist.
  const canonicalInput = canonicalizePath(repoPath);

  const entries = await readRegistry();
  const existingIdx = entries.findIndex((e) => {
    // Canonicalise the STORED entry too so pre-canonicalisation
    // registries (written by older versions, or paths passed in a
    // different form) still match correctly. `canonicalizePath` falls
    // back to `path.resolve` when the path no longer exists on disk,
    // so stale entries that have been rm'd externally still resolve
    // to a stable key instead of throwing.
    const a = canonicalizePath(e.path);
    const b = canonicalInput;
    return registryPathEquals(a, b);
  });
  const existing = existingIdx >= 0 ? entries[existingIdx] : null;

  // Precedence: explicit --name > preserved alias > remote-inferred > basename.
  // Skip the `git config` subprocess entirely when --name was passed —
  // the remote isn't consulted in that case.
  let name: string;
  let isPreservedAlias = false;
  if (opts?.name !== undefined) {
    name = opts.name;
  } else {
    // Compute the remote-derived name at most once. It feeds both the
    // alias-preservation check (`hasCustomAlias` needs it to distinguish
    // a sticky user alias from a previously-stored remote inference) and
    // the fallback name when neither --name nor a preserved alias apply.
    const inferred = getInferredRepoName(resolved);
    if (existing && hasCustomAlias(existing, inferred)) {
      name = existing.name;
      isPreservedAlias = true;
    } else {
      // Canonical-root fallback: when `resolved` is a worktree root,
      // derive the registry name from the canonical repo's basename, not
      // the worktree slug — see #1259. `resolveRepoIdentityRoot` confines
      // the collapse to canonical checkouts and linked worktree roots only,
      // so `--skip-git` subdirs of unrelated parent git repos keep using
      // their own basename (preserves the #1232/#1233 fix's intent).
      name = inferred ?? path.basename(resolveRepoIdentityRoot(resolved));
    }
  }

  // Duplicate-name guard: only fire when the user EXPLICITLY asked for
  // this name (via opts.name or a preserved alias). Unqualified basename
  // and remote-inferred collisions are preserved for backward-compat —
  // they still register, and the user sees the ambiguity at `-r` / `list`
  // resolution time (which is already improved by the disambiguated error
  // messages and list output #829 ships).
  const explicitName = opts?.name !== undefined || isPreservedAlias;
  if (explicitName && !opts?.allowDuplicateName) {
    // Compare canonical-vs-canonical here too so `/var/foo` and
    // `/private/var/foo` (same repo, different form) aren't treated as
    // two colliding paths.
    const collidingEntry = entries.find(
      (e, i) =>
        i !== existingIdx &&
        e.name.toLowerCase() === name.toLowerCase() &&
        canonicalizePath(e.path) !== canonicalInput,
    );
    if (collidingEntry) {
      throw new RegistryNameCollisionError(name, collidingEntry.path, resolved);
    }
  }

  // This run's branch summary (non-primary runs only); hoisted so the
  // re-read-before-write merge below can re-apply it against a fresh snapshot.
  const summary: BranchSummary | null = opts?.branch
    ? {
        branch: opts.branch,
        indexedAt: meta.indexedAt,
        lastCommit: meta.lastCommit,
        stats: meta.stats,
      }
    : null;

  let entry: RegistryEntry;
  if (summary) {
    // Non-primary branch run (#2106): keep the primary's top-level fields and
    // upsert this branch into branches[]. One entry per path is preserved.
    // When the registry entry is missing (lost/rebuilt registry.json), rebuild
    // the primary top-level from the FLAT meta.json rather than this branch's
    // meta, so `--branch <primary>` can still resolve (#2106 review).
    const flatMeta = existing ? null : await loadMeta(storagePath);
    const base: RegistryEntry = existing ?? {
      name,
      path: resolved,
      storagePath,
      indexedAt: flatMeta?.indexedAt ?? meta.indexedAt,
      lastCommit: flatMeta?.lastCommit ?? meta.lastCommit,
      remoteUrl: flatMeta?.remoteUrl ?? meta.remoteUrl,
      stats: flatMeta?.stats ?? meta.stats,
      ...(flatMeta?.branch ? { branch: flatMeta.branch } : {}),
    };
    const branches = (base.branches ?? []).filter((b) => b.branch !== summary.branch);
    branches.push(summary);
    entry = { ...base, name, branches };
  } else {
    // Primary/flat run: refresh top-level fields, preserve any branch summaries
    // already recorded for this path so a primary re-analyze does not drop them.
    entry = {
      name,
      path: resolved,
      storagePath,
      indexedAt: meta.indexedAt,
      lastCommit: meta.lastCommit,
      remoteUrl: meta.remoteUrl,
      stats: meta.stats,
      ...(meta.branch ? { branch: meta.branch } : {}),
      ...(existing?.branches ? { branches: existing.branches } : {}),
    };
  }

  // Re-read immediately before writing to narrow the lost-update window (#2106
  // R9): re-derive THIS run's delta against the FRESHEST snapshot so a
  // concurrent change to the OTHER axis (a branch upsert vs a primary refresh)
  // survives instead of being clobbered by a stale entry-time view.
  const fresh = await readRegistry();
  const freshIdx = fresh.findIndex((e) => {
    const a = canonicalizePath(e.path);
    return registryPathEquals(a, canonicalInput);
  });
  const freshExisting = freshIdx >= 0 ? fresh[freshIdx] : null;
  let merged: RegistryEntry;
  if (summary) {
    // Branch run: keep the FRESH top-level + branches, just upsert our summary.
    const base = freshExisting ?? entry;
    const branches = (base.branches ?? []).filter((b) => b.branch !== summary.branch);
    branches.push(summary);
    merged = { ...base, name, branches };
  } else {
    // Primary run: apply our refreshed top-level, but defer to the FRESH
    // branches[] (a concurrent branch upsert or `clean --branch` wins).
    merged = { ...entry };
    if (freshExisting?.branches) merged.branches = freshExisting.branches;
    else delete merged.branches;
  }
  if (freshIdx >= 0) {
    fresh[freshIdx] = merged;
  } else {
    fresh.push(merged);
  }

  await writeRegistry(fresh);
  return name;
};

export const registerRepo = async (
  repoPath: string,
  meta: RepoMeta,
  opts?: RegisterRepoOptions,
): Promise<string> => withRegistryLock(() => registerRepoUnlocked(repoPath, meta, opts));

/**
 * Remove a repo from the global registry.
 * Called after `gitnexus clean`.
 */
const unregisterRepoUnlocked = async (repoPath: string): Promise<void> => {
  // Canonicalise BOTH sides so an unregister call issued with the
  // symlink form (`/var/folders/.../repo`) still matches an entry
  // written with the realpath form (`/private/var/folders/.../repo`),
  // and vice versa. Matches the semantics of `registerRepo` and
  // `resolveRegistryEntry` post-#1003 review.
  const resolved = canonicalizePath(repoPath);
  const entries = await readRegistry();
  const filtered = entries.filter((e) => !registryPathEquals(canonicalizePath(e.path), resolved));
  await writeRegistry(filtered);
};

export const unregisterRepo = async (repoPath: string): Promise<void> =>
  withRegistryLock(() => unregisterRepoUnlocked(repoPath));

/**
 * Remove a single non-primary branch's summary from a repo's registry entry
 * (#2106 R7). Called by `gitnexus clean --branch`. Returns `true` when a
 * matching `branches[]` summary was found and removed; `false` otherwise (so
 * the CLI can report "no such indexed branch" without crashing). The top-level
 * primary entry is left intact; an empty `branches[]` is dropped to keep the
 * registry shape legacy-clean.
 */
const removeBranchIndexUnlocked = async (repoPath: string, branch: string): Promise<boolean> => {
  const resolved = canonicalizePath(repoPath);
  const entries = await readRegistry();
  const idx = entries.findIndex((e) => registryPathEquals(canonicalizePath(e.path), resolved));
  if (idx < 0) return false;
  const entry = entries[idx];
  const before = entry.branches?.length ?? 0;
  if (!entry.branches || before === 0) return false;
  const remaining = entry.branches.filter((b) => b.branch !== branch);
  if (remaining.length === before) return false; // branch not recorded
  if (remaining.length > 0) entry.branches = remaining;
  else delete entry.branches;
  entries[idx] = entry;
  await writeRegistry(entries);
  return true;
};

export const removeBranchIndex = async (repoPath: string, branch: string): Promise<boolean> =>
  withRegistryLock(() => removeBranchIndexUnlocked(repoPath, branch));

/**
 * Record that the flat workspace slot now serves `branch` (#2354).
 *
 * The flat index follows the checked-out working tree, so when a plain
 * analyze lands on a branch that also has a pinned `branches/<slug>/`
 * sub-index, that sub-index becomes permanently shadowed — explicit
 * `--branch` runs re-resolve to the flat slot and query-side branch scoping
 * serves the flat handle first. Delete the shadowed directory and drop its
 * registry summary in the same pass (leaving either half behind would strand
 * un-cleanable disk bloat), and refresh the entry's top-level `branch` label
 * so `list`/`list_repos`/branch-scoped queries stay coherent.
 *
 * Deliberately narrow for the analyze fast path: a missing registry entry is
 * a no-op — including the sub-index deletion, which only runs for registered
 * repos (never self-heals an unregistered repo, per #2264/#1169; the registry
 * check precedes the rm per #2364 review F2) — and no subprocess is spawned.
 *
 * Only the closing re-read/mutate/write runs under the registry lock. The
 * recursive `rm` stays outside it — mirroring `clean.ts`, which deletes the
 * branch directory before calling the (locked) `removeBranchIndex` — so a slow
 * delete (large sub-index, AV scan, network mount) never blocks every other
 * registry operation on the machine.
 */
export const adoptFlatBranchLabel = async (repoPath: string, branch: string): Promise<void> => {
  const canonicalInput = canonicalizePath(repoPath);
  const isRegistered = (list: RegistryEntry[]): number =>
    list.findIndex((e) => registryPathEquals(canonicalizePath(e.path), canonicalInput));
  // Cheap membership gate only (#2364 review F2): never touch the disk for an
  // unregistered repo. The mutate below re-reads its own fresh snapshot.
  if (isRegistered(await readRegistry()) < 0) return; // no-op, disk included (no self-heal)

  const resolved = path.resolve(repoPath);
  const { storagePath } = getStoragePaths(resolved);
  // Remove a shadowed sub-index directory, mirroring `clean --branch`'s
  // containment guard: the target MUST live under .gitnexus/branches/.
  const branchDir = path.join(storagePath, BRANCHES_DIR, branchSlug(branch));
  const branchesRoot = path.join(storagePath, BRANCHES_DIR) + path.sep;
  let dirGone = false;
  if (branchDir.startsWith(branchesRoot)) {
    let rmError: NodeJS.ErrnoException | undefined;
    await fs.rm(branchDir, { recursive: true, force: true }).catch((err: unknown) => {
      rmError = err as NodeJS.ErrnoException;
    });
    // The registry summary may be dropped only for a verifiably-gone
    // directory: `clean --branch` resolves its target solely via the
    // recorded summary, so dropping it while the dir survives (e.g. Windows
    // EBUSY on an lbug held open by a live MCP server) would strand
    // un-cleanable disk bloat (#2364 review F4). A resolved force:true rm
    // proves absence; on failure, probe the disk and treat only
    // provably-absent errno as gone — EACCES/EIO are "not provably absent",
    // the same polarity as listRegisteredRepos({ validate: true }).
    if (!rmError) {
      dirGone = true;
    } else {
      const probeCode = await fs.access(branchDir).then(
        () => null,
        (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? 'UNKNOWN',
      );
      dirGone = probeCode === 'ENOENT' || probeCode === 'ENOTDIR';
    }
    if (dirGone) {
      // Non-recursive by design: only removes the parent when no other pinned
      // sub-index remains, so an empty branches/ dir doesn't read as "pinned".
      await fs.rmdir(path.join(storagePath, BRANCHES_DIR)).catch(() => {});
    } else {
      logger.warn(
        { path: branchDir, code: rmError?.code },
        'Could not remove the shadowed branch sub-index; keeping its registry summary so `gitnexus clean --branch` can still target it.',
      );
    }
  }

  // Re-read AFTER the potentially slow recursive rm, and under the lock: the
  // registry is a multi-writer whole-file overwrite, and writing a pre-rm
  // snapshot would silently clobber concurrent registerRepo/removeBranchIndex
  // writers — the #2106 R9 re-read-before-write discipline registerRepo follows.
  await withRegistryLock(async () => {
    const entries = await readRegistry();
    const idx = isRegistered(entries);
    if (idx < 0) return; // unregistered concurrently → still a no-op
    const entry = entries[idx];
    const remaining = dirGone ? entry.branches?.filter((b) => b.branch !== branch) : entry.branches;
    const droppedSummary = (entry.branches?.length ?? 0) !== (remaining?.length ?? 0);
    if (entry.branch === branch && !droppedSummary) return; // already coherent
    entry.branch = branch;
    if (remaining && remaining.length > 0) entry.branches = remaining;
    else delete entry.branches;
    entries[idx] = entry;
    await writeRegistry(entries);
  });
};

/**
 * Thrown by {@link resolveRegistryEntry} when no registered repo matches
 * the caller's target string (by alias, basename, remote-inferred name,
 * or resolved path). CLI callers that want idempotent "remove" semantics
 * should catch this and exit 0 with a warning; non-idempotent callers
 * (e.g. MCP tools) can surface the error directly.
 */
export class RegistryNotFoundError extends Error {
  readonly kind = 'RegistryNotFoundError' as const;
  constructor(
    public readonly target: string,
    public readonly availableNames: string[],
  ) {
    const hint =
      availableNames.length > 0
        ? ` Available: ${availableNames.join(', ')}.`
        : ' No repositories are currently registered.';
    super(`No registered repo matches "${target}".${hint}`);
    this.name = 'RegistryNotFoundError';
  }
}

/**
 * Thrown by {@link resolveRegistryEntry} when the target string matches
 * the `name` of two or more entries — only possible when the user
 * previously registered duplicates via `analyze --name X
 * --allow-duplicate-name` (#829). The error carries enough information
 * for the caller to render an actionable disambiguation hint without
 * string-matching on `.message`.
 *
 * `kind` is a string literal discriminant (same pattern as
 * {@link RegistryNameCollisionError}) so callers can narrow via
 * `err.kind === 'RegistryAmbiguousTargetError'` without importing the
 * class.
 */
export class RegistryAmbiguousTargetError extends Error {
  readonly kind = 'RegistryAmbiguousTargetError' as const;
  constructor(
    public readonly target: string,
    public readonly matches: RegistryEntry[],
  ) {
    const listing = matches.map((m) => `  - ${m.name}  (${m.path})`).join('\n');
    super(
      `Multiple registered repos match "${target}":\n${listing}\n` +
        `Pass the absolute path instead to disambiguate.`,
    );
    this.name = 'RegistryAmbiguousTargetError';
  }
}

/**
 * Thrown by {@link assertAnalysisFinalized} when a successful `analyze`
 * run did not actually persist the index metadata file or did not register
 * the repo in `~/.gitnexus/registry.json` (#1169).
 *
 * Why this exists: on Windows, `gitnexus analyze` has been observed to
 * exit cleanly (code 0) with `lbug.wal` written but no metadata file,
 * leaving the repo invisible to `gitnexus list`/`status` and downstream
 * MCP discovery. The only signal to the user was an empty banner —
 * which is indistinguishable from a no-op early return. This invariant
 * fails loudly with an actionable diagnostic so the silent-finalize bug
 * surfaces with a non-zero exit code and a recoverable error message
 * regardless of the upstream root cause (re-exec churn, native module
 * side effects, antivirus, or future regressions).
 */
export class AnalysisNotFinalizedError extends Error {
  readonly kind = 'AnalysisNotFinalizedError' as const;
  constructor(
    public readonly repoPath: string,
    public readonly storagePath: string,
    public readonly missing: 'meta' | 'registry-entry',
    public readonly registryPath: string,
  ) {
    const detail =
      missing === 'meta'
        ? `${INDEX_METADATA_FILE} was not written to ${path.join(storagePath, INDEX_METADATA_FILE)}`
        : `registry entry for ${repoPath} was not added to ${registryPath}`;
    super(
      `Analysis did not finalize for ${repoPath}: ${detail}. ` +
        `The on-disk index is incomplete and was not registered. ` +
        `Re-run "gitnexus analyze" — if the problem persists, inspect ` +
        `${storagePath} for a stale lbug.wal that signals an aborted write.`,
    );
    this.name = 'AnalysisNotFinalizedError';
  }
}

/**
 * True when the global registry already contains an entry whose canonical path
 * matches `repoPath`. Uses the same canonical, case-folded (Windows) comparison
 * as {@link assertAnalysisFinalized} so "is it registered?" answers identically
 * at the analyze fast-path gate and at the finalize assertion. Pure read.
 */
export const isRepoRegistered = async (repoPath: string): Promise<boolean> => {
  const entries = await readRegistry();
  const canonicalInput = canonicalizePath(path.resolve(repoPath));
  return entries.some((e) => registryPathEquals(canonicalizePath(e.path), canonicalInput));
};

/**
 * Verify that a successful `analyze` call actually produced an indexed,
 * registered repo on disk. Two checks, both strictly required:
 *
 *   1. `gitnexus.json` must exist at `<repoPath>/.gitnexus/gitnexus.json`
 *      (the primary metadata file; the legacy `meta.json` mirror is not
 *      sufficient — a finalized analyze always writes the primary).
 *   2. The global registry (`getGlobalRegistryPath()`) must contain an
 *      entry whose canonical path matches `repoPath`.
 *
 * Throws {@link AnalysisNotFinalizedError} on the first failure with the
 * specific missing artifact. Pure read — does not mutate disk state.
 *
 * Callers must skip this assertion on the `alreadyUpToDate` early-return
 * path, where the rebuild was deliberately not run.
 */
export const assertAnalysisFinalized = async (repoPath: string): Promise<void> => {
  const resolved = path.resolve(repoPath);
  const { storagePath, metaPath } = getStoragePaths(resolved);

  try {
    await fs.access(metaPath);
  } catch {
    throw new AnalysisNotFinalizedError(resolved, storagePath, 'meta', getGlobalRegistryPath());
  }

  if (!(await isRepoRegistered(resolved))) {
    throw new AnalysisNotFinalizedError(
      resolved,
      storagePath,
      'registry-entry',
      getGlobalRegistryPath(),
    );
  }
};

/**
 * Thrown by {@link assertSafeStoragePath} when a registry entry's
 * `storagePath` does NOT point at the expected `<entry.path>/.gitnexus`
 * subfolder. CLI destructive commands (`remove`, `clean --all`) should
 * catch this and exit non-zero without deleting anything — the usual
 * cause is a corrupted or hand-edited `~/.gitnexus/registry.json`, and
 * proceeding would mean `fs.rm(recursive: true)` on whatever odd path
 * the entry is pointing at.
 */
export class UnsafeStoragePathError extends Error {
  readonly kind = 'UnsafeStoragePathError' as const;
  constructor(
    public readonly entry: RegistryEntry,
    public readonly expectedStoragePath: string,
    public readonly actualStoragePath: string,
  ) {
    super(
      `Refusing to remove storage path for safety: expected ` +
        `"${expectedStoragePath}" under the repo's .gitnexus subfolder, ` +
        `but the registry entry has "${actualStoragePath}". ` +
        `This usually means the registry entry is corrupted or was ` +
        `hand-edited. Delete the entry manually from ~/.gitnexus/registry.json ` +
        `and re-run analyze.`,
    );
    this.name = 'UnsafeStoragePathError';
  }
}

/**
 * Guard rail for destructive CLI paths (`remove` #664,
 * `clean --all` #258, future MCP `remove` tool): verify that a
 * registry entry's `storagePath` names the registered index. Repository-local
 * indexes are validated by their canonical `<repo>/.gitnexus` path; external
 * slots must additionally prove their ownership through matching persisted
 * metadata before a recursive deletion is allowed.
 *
 * Why this exists (#1003 review — @magyargergo):
 *   - `~/.gitnexus/registry.json` is a plain-text user-writable file.
 *     A corrupted, hand-edited, or downgrade/upgrade-racing entry
 *     could plausibly end up with `storagePath === ""` (resolves to
 *     cwd), `storagePath === path` (the repo root!), `storagePath`
 *     equal to a parent/sibling of the repo, or simply any arbitrary
 *     filesystem path.
 *   - `fs.rm(recursive: true, force: true)` on ANY of those would be
 *     a runtime disaster — at best delete the user's working tree, at
 *     worst nuke an unrelated directory tree they happen to own.
 *   - `clean` (default, cwd-scoped) is safe by construction — it
 *     re-derives storagePath from `findRepo(cwd)` and never trusts
 *     the registry field. But `clean --all` DOES iterate the registry
 *     and trust each entry's stored storagePath (same shape as
 *     `remove`), so this helper must be wired into that loop too.
 *   - An external slot is intentionally not constrained under a checkout. Its
 *     own metadata must bind both the source checkout path and the resolved
 *     storage path before it may be removed.
 *
 * The local-path branch stays a pure string check for legacy entries. The
 * external branch reads metadata so a hand-edited registry cannot redirect a
 * destructive command to an arbitrary directory.
 */
export const assertSafeStoragePath = async (entry: RegistryEntry): Promise<void> => {
  const expected = defaultStoragePath(entry.path);
  let actual: string;
  try {
    actual = validateConfiguredStoragePath(entry.storagePath);
  } catch {
    throw new UnsafeStoragePathError(entry, expected, path.resolve(entry.storagePath));
  }

  if (registryPathEquals(expected, actual)) return;

  const root = path.parse(actual).root;
  if (
    registryPathEquals(actual, root) ||
    registryPathEquals(actual, path.resolve(entry.path)) ||
    registryPathEquals(path.dirname(actual), actual)
  ) {
    throw new UnsafeStoragePathError(entry, expected, actual);
  }

  const meta = await loadMeta(actual);
  if (
    !meta ||
    !meta.storagePath ||
    !registryPathEquals(canonicalizePath(meta.repoPath), canonicalizePath(entry.path)) ||
    !registryPathEquals(meta.storagePath, actual)
  ) {
    throw new UnsafeStoragePathError(entry, expected, actual);
  }
};

/**
 * Resolve a user-supplied target string (from `gitnexus remove <target>`
 * or equivalent MCP tool argument) to a single registry entry.
 *
 * Match precedence (first hit wins, subsequent tiers are only tried if
 * the prior tier produces zero matches):
 *   1. Exact resolved-path match (Windows: case-insensitive).
 *      Paths are unique by registry construction, so a path match can
 *      never be ambiguous.
 *   2. Exact `name` match (case-insensitive). If ≥ 2 entries share the
 *      name — only possible via `--allow-duplicate-name` (#829) —
 *      throws {@link RegistryAmbiguousTargetError}.
 *
 * No fuzzy / partial matching — unambiguous, scriptable behaviour is
 * more important than convenience for destructive commands.
 *
 * Throws {@link RegistryNotFoundError} if no entry matches.
 *
 * `entries` is passed in (rather than re-read) so callers that already
 * hold the registry snapshot (e.g. to print a "before" state) can avoid
 * a second disk read, and so tests can inject fixtures without touching
 * `GITNEXUS_HOME`.
 */
export const resolveRegistryEntry = (entries: RegistryEntry[], target: string): RegistryEntry => {
  // Tier 1: path match. Canonicalise BOTH sides so symlink and
  // Windows-8.3 quirks don't cause a false miss — e.g. the caller
  // passes `/var/folders/.../repo` while the registry has
  // `/private/var/folders/.../repo` (both resolve to the same
  // `realpath.native`). See `canonicalizePath` for the rationale.
  //
  // Canonicalising the STORED entry (not just the input) is what gives
  // us backward-compat for registries written by versions that only
  // ran `path.resolve` — both get canonicalised here at compare time.
  const canonicalTarget = canonicalizePath(target);
  const pathMatch = entries.find((e) => {
    const a = canonicalizePath(e.path);
    const b = canonicalTarget;
    return registryPathEquals(a, b);
  });
  if (pathMatch) return pathMatch;

  // Tier 2: name match. Case-insensitive on all platforms — registry
  // name collisions are already filtered case-insensitively in
  // `registerRepo`, so "APP" vs "app" are considered the same key.
  const targetLower = target.toLowerCase();
  const nameMatches = entries.filter((e) => e.name.toLowerCase() === targetLower);
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new RegistryAmbiguousTargetError(target, nameMatches);
  }

  // Tier 3: miss. Build the available-names hint ONCE; resolveRepo-style
  // disambiguated labels (`app (/path)`) are applied when the same name
  // appears in multiple entries so the user sees the same hint shape as
  // `-r <name>` errors.
  const nameCounts = new Map<string, number>();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const availableNames = entries.map((e) =>
    (nameCounts.get(e.name.toLowerCase()) ?? 0) > 1 ? `${e.name} (${e.path})` : e.name,
  );
  throw new RegistryNotFoundError(target, availableNames);
};

/**
 * List all registered repos from the global registry.
 *
 * With `validate: true`, prunes only entries whose metadata is *provably* gone
 * (fs.access on both gitnexus.json and legacy meta.json fails with ENOENT or
 * ENOTDIR) and persists the result on a best-effort basis: the pruned view is
 * always returned, even when the write fails. Entries that are merely "not provably
 * absent" — any other fs.access failure (EIO/EAGAIN/EBUSY/EACCES, etc.) — are
 * KEPT, so a transient I/O storm cannot wipe the registry. A kept entry is
 * therefore "not confirmed present," not "confirmed present"; downstream DB
 * opens are independently and lazily guarded.
 */
export const listRegisteredRepos = async (opts?: {
  validate?: boolean;
}): Promise<RegistryEntry[]> => {
  const entries = await readRegistry();
  if (!opts?.validate) return entries;

  // Validate each entry still has a .gitnexus/ directory with metadata
  const valid: RegistryEntry[] = [];
  for (const entry of entries) {
    // Named to avoid shadowing the exported `hasIndex` function above.
    let indexFound = false;
    let firstNonMissingError: NodeJS.ErrnoException | null = null;
    let lastMissingError: NodeJS.ErrnoException | null = null;

    // Check for new metadata file first
    try {
      await fs.access(path.join(entry.storagePath, INDEX_METADATA_FILE));
      indexFound = true;
    } catch (err: any) {
      if (isMissingFilesystemError(err)) lastMissingError = err;
      else firstNonMissingError = err;
    }

    // Fall back to legacy meta.json
    if (!indexFound) {
      try {
        await fs.access(path.join(entry.storagePath, LEGACY_METADATA_FILE));
        indexFound = true;
      } catch (err: any) {
        if (isMissingFilesystemError(err)) lastMissingError = err;
        else if (!firstNonMissingError) firstNonMissingError = err;
      }
    }

    if (indexFound) {
      valid.push(entry);
    } else if (!firstNonMissingError && lastMissingError) {
      // Index genuinely removed — safe to prune
    } else {
      // Not provably absent — keep entry to prevent mass registry wipe.
      // Warn so an I/O storm becomes observable instead of silently
      // keeping (or, pre-fix, silently wiping) entries.
      logger.warn(
        { name: entry.name, storagePath: entry.storagePath, code: firstNonMissingError?.code },
        'Keeping registry entry despite fs.access failure (not provably absent); not pruning to avoid mass registry wipe.',
      );
      valid.push(entry);
    }
  }

  // If we pruned any entries, save the cleaned registry — under the lock, and
  // only then. The validation walk above is read-only (an fs.access per entry,
  // slow on a network mount or a large registry) and the common case prunes
  // nothing, so holding the global lock across it would serialize every
  // `gitnexus augment` behind unrelated registry work for no benefit. Re-read
  // inside the lock and drop the provably-absent paths from that fresh
  // snapshot, so a concurrent registration in the validation window survives.
  if (valid.length !== entries.length) {
    const pruned = new Set(
      entries.filter((entry) => !valid.includes(entry)).map((entry) => entry.path),
    );
    try {
      await withRegistryLock(async () => {
        const fresh = await readRegistry();
        // attempts: 1 — the catch below discards a failure, so the rename
        // backoff would only make every other process wait out this lock.
        await writeRegistry(
          fresh.filter((entry) => !pruned.has(entry.path)),
          1,
        );
      });
    } catch (err) {
      // Best-effort housekeeping: callers consume the returned view, and the
      // prune set is recomputed on the next validating read. It must not throw
      // — this runs on MCP startup (LocalBackend.init → refreshRepos), where
      // nothing catches and a rejection reads as "Server disconnected".
      logger.warn(
        { err, prunedCount: pruned.size },
        'Could not persist the pruned global registry; continuing with the in-memory pruned view.',
      );
    }
  }

  return valid;
};

// ─── Global CLI Config (~/.gitnexus/config.json) ─────────────────────────

export interface CLIConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  provider?:
    | 'openai'
    | 'openrouter'
    | 'azure'
    | 'custom'
    | 'cursor'
    | 'claude'
    | 'codex'
    | 'opencode'
    | 'minimax';
  cursorModel?: string;
  claudeModel?: string;
  codexModel?: string;
  opencodeModel?: string;
  /** Azure api-version query param (e.g. '2024-10-21'). Only used when provider is 'azure'. */
  apiVersion?: string;
  /** Set true when the deployment is a reasoning model (o1, o3, o4-mini). Auto-detected for OpenAI; must be set for Azure deployments. */
  isReasoningModel?: boolean;
}

/**
 * Get the path to the global CLI config file
 */
export const getGlobalConfigPath = (): string => {
  return path.join(getGlobalDir(), 'config.json');
};

/**
 * Load CLI config from ~/.gitnexus/config.json
 */
export const loadCLIConfig = async (): Promise<CLIConfig> => {
  try {
    const raw = await fs.readFile(getGlobalConfigPath(), 'utf-8');
    return JSON.parse(raw) as CLIConfig;
  } catch {
    return {};
  }
};

/**
 * Save CLI config to ~/.gitnexus/config.json
 */
export const saveCLIConfig = async (config: CLIConfig): Promise<void> => {
  const dir = getGlobalDir();
  await fs.mkdir(dir, { recursive: true });
  const configPath = getGlobalConfigPath();
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  // Restrict file permissions on Unix (config may contain API keys)
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(configPath, 0o600);
    } catch {
      /* best-effort */
    }
  }
};

// ─── Sibling-clone detection ─────────────────────────────────────────────
//
// A "sibling clone" is a different on-disk path that points at the same
// logical repository (same `origin` remote URL) as a registered index.
// This shows up in three operationally important shapes (see issue):
//
//   1. The same repo is checked out under multiple paths (worktrees,
//      multi-agent workspaces). Only one is indexed; the others silently
//      diverge from the graph.
//   2. The indexed clone is itself behind its own HEAD (the existing
//      `checkStaleness` already handles this case).
//   3. A query is issued from a `cwd` that lives inside a sibling clone
//      whose HEAD has drifted from the indexed `lastCommit`.
//
// Detection is intentionally remote-URL-based and does NOT walk the
// filesystem hunting for unregistered clones — only registered entries
// are considered. The `cwd`-driven branch ({@link checkSiblingDrift})
// also accepts an unregistered cwd, because the live caller's working
// directory is the one place we can cheaply learn about an
// unregistered clone.

/**
 * Find other registered entries whose `remoteUrl` matches the given
 * one, excluding `selfPath` (case-insensitive on Windows). Entries
 * without a `remoteUrl` are ignored — we cannot prove sibling-ness
 * without a fingerprint.
 */
export const findSiblingClones = async (
  remoteUrl: string | undefined,
  selfPath: string,
): Promise<RegistryEntry[]> => {
  if (!remoteUrl) return [];
  const entries = await readRegistry();
  const isWin = process.platform === 'win32';
  const norm = (p: string) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
  const self = norm(selfPath);
  return entries.filter((e) => e.remoteUrl === remoteUrl && norm(e.path) !== self);
};

/**
 * Description of how a working directory relates to a registered index.
 *
 * `match` semantics:
 *   - `path`              — `cwd` is inside the registered entry's path.
 *   - `sibling-by-remote` — `cwd` is in a different on-disk clone of the
 *                           same repo (same `remoteUrl`).
 *   - `none`              — no relationship found.
 */
export interface CwdMatch {
  match: 'path' | 'sibling-by-remote' | 'none';
  entry?: RegistryEntry;
  /** The git toplevel of `cwd`, when `cwd` is inside a git work tree. */
  cwdGitRoot?: string;
  /** HEAD of the cwd's clone, when resolvable. */
  cwdHead?: string;
  /**
   * Number of commits the registered `lastCommit` is behind the
   * sibling-clone HEAD, when both refs are known to the cwd's clone.
   * `undefined` when the comparison cannot be performed (e.g. the
   * indexed commit isn't reachable from cwd).
   */
  drift?: number;
  /** Human-readable hint, set whenever the situation warrants warning. */
  hint?: string;
}
