/**
 * Repository Manager
 *
 * Manages GitNexus index storage in .gitnexus/ at repo root.
 * Also maintains a global registry at ~/.gitnexus/registry.json
 * so the MCP server can discover indexed repos from any cwd.
 */

import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import { getInferredRepoName } from './git.js';

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
 * versions (where `registerRepo` only ran `path.resolve`) still match
 * correctly. Newly-written entries are canonicalised at write time too
 * so the registry stabilises over analyze/re-analyze cycles.
 */
export const canonicalizePath = (p: string): string => {
  const resolved = path.resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

export interface RepoMeta {
  repoPath: string;
  lastCommit: string;
  indexedAt: string;
  /**
   * Canonical `origin` remote URL captured at index time. Used to
   * fingerprint the same logical repo across multiple on-disk clones
   * (worktrees, agent workspaces, "clean clone for indexing"). When
   * absent (no remote configured, git unavailable, etc.) the repo is
   * treated as path-only and sibling-clone detection is skipped.
   */
  remoteUrl?: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
}

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
}

const GITNEXUS_DIR = '.gitnexus';
const GITNEXUS_EXCLUDE_ENTRY = `${GITNEXUS_DIR}/`;

// ─── Local Storage Helpers ─────────────────────────────────────────────

/**
 * Get the .gitnexus storage path for a repository
 */
export const getStoragePath = (repoPath: string): string => {
  return path.join(path.resolve(repoPath), GITNEXUS_DIR);
};

/**
 * Get paths to key storage files
 */
export const getStoragePaths = (repoPath: string) => {
  const storagePath = getStoragePath(repoPath);
  return {
    storagePath,
    lbugPath: path.join(storagePath, 'lbug'),
    metaPath: path.join(storagePath, 'meta.json'),
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
 * Load metadata from an indexed repo
 */
export const loadMeta = async (storagePath: string): Promise<RepoMeta | null> => {
  try {
    const metaPath = path.join(storagePath, 'meta.json');
    const raw = await fs.readFile(metaPath, 'utf-8');
    return JSON.parse(raw) as RepoMeta;
  } catch {
    return null;
  }
};

/**
 * Save metadata to storage
 */
export const saveMeta = async (storagePath: string, meta: RepoMeta): Promise<void> => {
  await fs.mkdir(storagePath, { recursive: true });
  const metaPath = path.join(storagePath, 'meta.json');
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
};

/**
 * Check if a path has a GitNexus index
 */
export const hasIndex = async (repoPath: string): Promise<boolean> => {
  const { metaPath } = getStoragePaths(repoPath);
  try {
    await fs.access(metaPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Load an indexed repo from a path
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

/**
 * Keep generated index files ignored without modifying the user's root .gitignore.
 */
export const ensureGitNexusIgnored = async (repoPath: string): Promise<void> => {
  const gitignorePath = path.join(getStoragePath(repoPath), '.gitignore');

  await fs.mkdir(path.dirname(gitignorePath), { recursive: true });
  await fs.writeFile(gitignorePath, '*\n', 'utf-8');

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

  await fs.mkdir(path.dirname(excludePath), { recursive: true });

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
  await fs.writeFile(excludePath, `${content}${separator}${GITNEXUS_EXCLUDE_ENTRY}\n`, 'utf-8');
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
 * Read the global registry. Returns empty array if not found.
 */
export const readRegistry = async (): Promise<RegistryEntry[]> => {
  try {
    const raw = await fs.readFile(getGlobalRegistryPath(), 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
};

/**
 * Write the global registry to disk
 */
const writeRegistry = async (entries: RegistryEntry[]): Promise<void> => {
  const dir = getGlobalDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getGlobalRegistryPath(), JSON.stringify(entries, null, 2), 'utf-8');
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
export const registerRepo = async (
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
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
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
      name = inferred ?? path.basename(resolved);
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

  const entry: RegistryEntry = {
    name,
    path: resolved,
    storagePath,
    indexedAt: meta.indexedAt,
    lastCommit: meta.lastCommit,
    remoteUrl: meta.remoteUrl,
    stats: meta.stats,
  };

  if (existingIdx >= 0) {
    entries[existingIdx] = entry;
  } else {
    entries.push(entry);
  }

  await writeRegistry(entries);
  return name;
};

/**
 * Remove a repo from the global registry.
 * Called after `gitnexus clean`.
 */
export const unregisterRepo = async (repoPath: string): Promise<void> => {
  // Canonicalise BOTH sides so an unregister call issued with the
  // symlink form (`/var/folders/.../repo`) still matches an entry
  // written with the realpath form (`/private/var/folders/.../repo`),
  // and vice versa. Matches the semantics of `registerRepo` and
  // `resolveRegistryEntry` post-#1003 review.
  const resolved = canonicalizePath(repoPath);
  const entries = await readRegistry();
  const matches = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const filtered = entries.filter((e) => !matches(canonicalizePath(e.path), resolved));
  await writeRegistry(filtered);
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
 * run did not actually persist `meta.json` or did not register the repo
 * in `~/.gitnexus/registry.json` (#1169).
 *
 * Why this exists: on Windows, `gitnexus analyze` has been observed to
 * exit cleanly (code 0) with `lbug.wal` written but no `meta.json`,
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
        ? `meta.json was not written to ${path.join(storagePath, 'meta.json')}`
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
 * Verify that a successful `analyze` call actually produced an indexed,
 * registered repo on disk. Two checks, both strictly required:
 *
 *   1. `meta.json` must exist at `<repoPath>/.gitnexus/meta.json`.
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

  const entries = await readRegistry();
  const canonicalInput = canonicalizePath(resolved);
  const isWin = process.platform === 'win32';
  const found = entries.some((e) => {
    const a = canonicalizePath(e.path);
    return isWin ? a.toLowerCase() === canonicalInput.toLowerCase() : a === canonicalInput;
  });
  if (!found) {
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
 * registry entry's `storagePath` is the canonical `<repo>/.gitnexus`
 * subfolder of its `path`. If not, throw {@link UnsafeStoragePathError}
 * so the caller exits without touching disk.
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
 *   - `server/api.ts` recomputes storagePath from `getStoragePath(entry.path)`
 *     and so is likewise safe-by-construction.
 *
 * Pure string check — does NOT require the paths to exist on disk.
 * Windows: case-insensitive; POSIX: case-sensitive. Matches the
 * comparison shape used elsewhere in this module.
 */
export const assertSafeStoragePath = (entry: RegistryEntry): void => {
  const expected = path.join(path.resolve(entry.path), '.gitnexus');
  const actual = path.resolve(entry.storagePath);
  const matches =
    process.platform === 'win32'
      ? expected.toLowerCase() === actual.toLowerCase()
      : expected === actual;
  if (!matches) {
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
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
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
 * Optionally validates that each entry's .gitnexus/ still exists.
 */
export const listRegisteredRepos = async (opts?: {
  validate?: boolean;
}): Promise<RegistryEntry[]> => {
  const entries = await readRegistry();
  if (!opts?.validate) return entries;

  // Validate each entry still has a .gitnexus/ directory
  const valid: RegistryEntry[] = [];
  for (const entry of entries) {
    try {
      await fs.access(path.join(entry.storagePath, 'meta.json'));
      valid.push(entry);
    } catch {
      // Index no longer exists — skip
    }
  }

  // If we pruned any entries, save the cleaned registry
  if (valid.length !== entries.length) {
    await writeRegistry(valid);
  }

  return valid;
};

// ─── Global CLI Config (~/.gitnexus/config.json) ─────────────────────────

export interface CLIConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  provider?: 'openai' | 'openrouter' | 'azure' | 'custom' | 'cursor';
  cursorModel?: string;
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
