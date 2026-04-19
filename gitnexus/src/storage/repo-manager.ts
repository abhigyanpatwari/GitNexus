/**
 * Repository Manager
 *
 * Manages GitNexus index storage in .gitnexus/ at repo root.
 * Also maintains a global registry at ~/.gitnexus/registry.json
 * so the MCP server can discover indexed repos from any cwd.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getInferredRepoName } from './git.js';

export interface RepoMeta {
  repoPath: string;
  lastCommit: string;
  indexedAt: string;
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
  stats?: RepoMeta['stats'];
}

const GITNEXUS_DIR = '.gitnexus';

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
 * Add .gitnexus to .gitignore if not already present
 */
export const addToGitignore = async (repoPath: string): Promise<void> => {
  const gitignorePath = path.join(repoPath, '.gitignore');

  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    if (content.includes(GITNEXUS_DIR)) return;

    const newContent = content.endsWith('\n')
      ? `${content}${GITNEXUS_DIR}\n`
      : `${content}\n${GITNEXUS_DIR}\n`;
    await fs.writeFile(gitignorePath, newContent, 'utf-8');
  } catch {
    // .gitignore doesn't exist, create it
    await fs.writeFile(gitignorePath, `${GITNEXUS_DIR}\n`, 'utf-8');
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
  const resolved = path.resolve(repoPath);
  const { storagePath } = getStoragePaths(resolved);

  const entries = await readRegistry();
  const existingIdx = entries.findIndex((e) => {
    const a = path.resolve(e.path);
    const b = resolved;
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
    const collidingEntry = entries.find(
      (e, i) =>
        i !== existingIdx &&
        e.name.toLowerCase() === name.toLowerCase() &&
        path.resolve(e.path) !== resolved,
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
  const resolved = path.resolve(repoPath);
  const entries = await readRegistry();
  const filtered = entries.filter((e) => path.resolve(e.path) !== resolved);
  await writeRegistry(filtered);
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
