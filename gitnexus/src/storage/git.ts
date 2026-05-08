import { execSync } from 'child_process';
import { statSync } from 'fs';
import path from 'path';

// Git utilities for repository detection, commit tracking, and diff analysis

export const isGitRepo = (repoPath: string): boolean => {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoPath, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const getCurrentCommit = (repoPath: string): string => {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: repoPath,
      // Suppress stderr -- without an explicit stdio option, Node's execSync
      // forwards the child's stderr to the parent process (documented behaviour).
      // When repoPath is not inside a git worktree, git prints
      // "fatal: not a git repository" to stderr, which leaks to the user's
      // terminal even though the error is caught here (#1172).
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
};

/**
 * Get a stable canonical identifier for the repo's `origin` remote, if any.
 *
 * Used to fingerprint two on-disk clones as the same logical repository
 * (issue #XXX — silent graph drift across sibling clones). `path` alone
 * is unreliable: worktrees, "clean clone for indexing" hygiene, and
 * multi-agent workspaces routinely have the same repo at multiple
 * absolute paths. The remote URL is the only on-disk signal that
 * survives those conventions.
 *
 * Normalisation strategy:
 *   - Strip a trailing `.git` so `https://x/y` and `https://x/y.git` collapse.
 *   - Strip a trailing `/` for the same reason.
 *   - `git@github.com:foo/bar` and `https://github.com/foo/bar` are
 *     intentionally NOT collapsed — they are different remotes from
 *     git's perspective and we don't want to assert equivalence.
 *   - Lower-case the host portion so `GitHub.com` and `github.com`
 *     don't desync; preserves case in path because some hosts
 *     (Bitbucket Server) treat repo paths case-sensitively.
 *
 * Returns `undefined` when there is no origin remote, the directory
 * isn't a git repo, or git itself isn't available.
 */
export const getRemoteUrl = (repoPath: string): string | undefined => {
  let raw: string;
  try {
    raw = execSync('git config --get remote.origin.url', {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  let normalised = raw.replace(/\/$/, '').replace(/\.git$/, '');

  // Lower-case the host segment of `scheme://[user@]host[:port]/...`
  // and the host segment of `git@host:owner/repo` SCP form.
  // SSH user-segment regex deliberately accepts the common
  // `git@`/`<alnum>-_@` cases. Less common usernames (e.g. with
  // dots) fall through to the URL-form branch — they will simply
  // not get host-case normalisation, which is acceptable: the raw
  // `git config` output is still a valid fingerprint, just slightly
  // less collapsible across host casings.
  const sshMatch = normalised.match(/^(git@|[a-zA-Z0-9_-]+@)([^:/]+)(:.+)$/);
  if (sshMatch) {
    normalised = `${sshMatch[1]}${sshMatch[2].toLowerCase()}${sshMatch[3]}`;
  } else {
    const urlMatch = normalised.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/]+)(\/.*)?$/);
    if (urlMatch) {
      normalised = `${urlMatch[1]}${urlMatch[2].toLowerCase()}${urlMatch[3] ?? ''}`;
    }
  }

  return normalised;
};

/**
 * Find the git repository root from any path inside the repo
 */
export const getGitRoot = (fromPath: string): string | null => {
  try {
    const raw = execSync('git rev-parse --show-toplevel', {
      cwd: fromPath,
      // Suppress stderr -- see getCurrentCommit comment and #1172.
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    // On Windows, git returns /d/Projects/Foo — path.resolve normalizes to D:\Projects\Foo
    return path.resolve(raw);
  } catch {
    return null;
  }
};

/**
 * Get the *canonical* repository root, dereferencing git worktrees.
 *
 * Unlike `getGitRoot` (which uses `git rev-parse --show-toplevel` and
 * returns the WORKTREE's root when called inside a linked worktree),
 * this uses `git rev-parse --git-common-dir` — the shared `.git`
 * directory, identical for the main checkout and every linked
 * worktree — and returns its parent.
 *
 * Why it matters (#1259): when `gitnexus analyze` runs inside a
 * worktree (e.g. `/repo/wt-feature/`), deriving `repoName` from
 * `path.basename(getGitRoot(cwd))` registers the project under the
 * worktree's directory slug (`wt-feature`) instead of the canonical
 * repo's basename (`repo`). Each worktree then re-registers as a
 * "different" project, AGENTS.md is rewritten with the wrong MCP URI,
 * and Claude-Code-style worktree workflows silently accumulate
 * duplicate registry entries.
 *
 * Returns `null` when the path is not inside a git repository or
 * `git` is not available, so callers can chain safely:
 * `getCanonicalRepoRoot(p) ?? getGitRoot(p) ?? p`.
 *
 * `--path-format=absolute` is required because `--git-common-dir`
 * returns a path *relative to cwd* by default (e.g. `../.git` when
 * called from a worktree), which would resolve to the wrong absolute
 * path if the caller later resolved it from a different directory.
 */
export const getCanonicalRepoRoot = (fromPath: string): string | null => {
  try {
    const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      cwd: fromPath,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!commonDir) return null;
    // Common dir is `<repo>/.git` for both the main checkout and all
    // linked worktrees. Its parent is the canonical repo root.
    return path.dirname(path.resolve(commonDir));
  } catch {
    return null;
  }
};

/**
 * Resolve `fromPath` to the directory whose basename should drive the
 * registry name (#1259) — the *identity root*. Three outcomes:
 *
 *   1. `fromPath` IS the canonical checkout root → returns it unchanged.
 *   2. `fromPath` is a linked-worktree root (has its own `.git` entry, but
 *      `git rev-parse --git-common-dir` points at a different `.git`) →
 *      returns the canonical repo root.
 *   3. `fromPath` is anything else — an arbitrary subdir under a git repo,
 *      a non-git folder, a `--skip-git` subdir of an unrelated parent
 *      checkout — returns `fromPath` unchanged.
 *
 * Why not just use `getCanonicalRepoRoot` directly? Because `git rev-parse
 * --git-common-dir` resolves the same canonical root for ANY path inside
 * a git repo, including unrelated subdirs. Using it for registry-name
 * derivation would silently re-key a `--skip-git` subdir analyze under
 * the parent git's basename, defeating the user's `--skip-git` intent
 * (regressing the #1232/#1233 fix). The "is this path a tree root"
 * gate confines the canonical-root collapse to exactly the cases where
 * #1259 matters: main checkouts and linked worktrees.
 */
export const resolveRepoIdentityRoot = (fromPath: string): string => {
  const resolved = path.resolve(fromPath);
  const canonical = getCanonicalRepoRoot(resolved);
  if (!canonical) return resolved; // non-git → use as-is
  if (canonical === resolved) return canonical; // canonical checkout
  if (hasGitDir(resolved)) return canonical; // linked worktree (has .git file)
  return resolved; // arbitrary subdir under a git repo → preserve as-is
};

/**
 * Find a git root by checking only `.git` entries on the ancestor chain.
 *
 * Unlike `getGitRoot`, this does not spawn `git`, so MCP can cheaply decide
 * whether a launch cwd is a worktree before running any subprocess there.
 */
export const findGitRootByDotGit = (fromPath: string): string | null => {
  let current = path.resolve(fromPath);
  try {
    if (!statSync(current).isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    return null;
  }

  while (true) {
    try {
      statSync(path.join(current, '.git'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
};
/**
 * Check whether a directory contains a .git entry (file or folder).
 *
 * This is intentionally a simple filesystem check rather than running
 * `git rev-parse`, so it works even when git is not installed or when
 * the directory is a git-worktree root (which has a .git file, not a
 * directory).  Use `isGitRepo` for a definitive git answer.
 *
 * @param dirPath - Absolute path to the directory to inspect.
 * @returns `true` when `.git` is present, `false` otherwise.
 */
export const hasGitDir = (dirPath: string): boolean => {
  try {
    statSync(path.join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
};

/**
 * Read `remote.origin.url` from a git repository, or `null` if not a
 * git repo, has no `origin` remote, or git is unavailable.
 *
 * Used by the registry-name inference path (#979) to recover a
 * meaningful repo name when `path.basename(repoPath)` is generic
 * (e.g. monorepo subprojects, git worktrees, Gas-Town-style
 * `<rig>/refinery/rig/` layouts).
 */
export const getRemoteOriginUrl = (repoPath: string): string | null => {
  try {
    const url = execSync('git config --get remote.origin.url', {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return url || null;
  } catch {
    return null;
  }
};

/**
 * Sanitize a repository name to prevent argument injection and ensure
 * cross-platform filesystem compatibility.
 *
 * 1. Strips leading dashes to prevent git command-line argument injection
 *    (e.g., --upload-pack=evil).
 * 2. Replaces characters that are unsafe for directory names across
 *    platforms (Windows/macOS/Linux) with underscores.
 * 3. Blocks path traversal segments ("." and "..") and Windows reserved
 *    names (e.g., CON, NUL) to prevent directory escape.
 */
export const sanitizeRepoName = (name: string): string => {
  // 1. Prevent argument injection by stripping leading dashes.
  // 2. Remove characters that are not alphanumerics, dots, underscores, or dashes.
  const sanitized = name.replace(/^-+/, '').replace(/[^a-zA-Z0-9._-]/g, '_');

  // 3. Block path traversal segments and Windows reserved names.
  // Windows reserved names like CON, PRN, AUX, NUL, COM1-9, LPT1-9 cannot
  // be used as directory names on Windows even if they have an extension.
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
  if (!sanitized || sanitized === '.' || sanitized === '..' || reserved.test(sanitized)) {
    return 'unknown';
  }

  return sanitized;
};

/**
 * Parse a repository name out of a git remote URL. Handles common shapes
 * including SSH (git@host:owner/repo.git) and HTTPS (https://host/owner/repo.git).
 *
 * Returns a sanitized, filesystem-safe name or null if no name could be inferred.
 * Returning null (rather than 'unknown') allows callers to use ?? null-coalescing
 * for fallbacks without risk of registry collisions on 'unknown'.
 */
export const parseRepoNameFromUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Strip trailing slashes without a regex to avoid polynomial-ReDoS on
  // pathological inputs like `https://x.com/y` + '/'.repeat(1e6).
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47 /* '/' */) end--;
  let cleaned = trimmed.slice(0, end);

  // Strip trailing .git (case-insensitive)
  if (cleaned.toLowerCase().endsWith('.git')) {
    cleaned = cleaned.slice(0, -4);
  }

  // Last path segment, handling colons for SSH URLs and path traversal.
  // Split on both / and : to consistently extract the last part.
  const candidate = cleaned.split(/[/:]/).pop() || '';
  if (!candidate) return null;

  const safe = sanitizeRepoName(candidate);
  return safe === 'unknown' ? null : safe;
};

/**
 * Convenience wrapper: derive a registry-friendly name from the repo's
 * `origin` remote, or `null` when it cannot be inferred.
 */
export const getInferredRepoName = (repoPath: string): string | null => {
  return parseRepoNameFromUrl(getRemoteOriginUrl(repoPath));
};

export interface DiffHunk {
  startLine: number;
  endLine: number;
}

export interface FileDiff {
  filePath: string;
  hunks: DiffHunk[];
}

/**
 * Parse unified diff output (with -U0) into per-file hunk ranges.
 * Extracts the new-file line ranges from @@ hunk headers.
 */
export function parseDiffHunks(diffOutput: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('+++ b/')) {
      current = { filePath: line.slice(6), hunks: [] };
      files.push(current);
    } else if (line.startsWith('@@') && current) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const start = parseInt(match[1], 10);
        const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        if (count > 0) {
          current.hunks.push({ startLine: start, endLine: start + count - 1 });
        }
      }
    }
  }
  return files;
}
