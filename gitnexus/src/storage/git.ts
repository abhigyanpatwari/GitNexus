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
    return execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
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
    const raw = execSync('git rev-parse --show-toplevel', { cwd: fromPath }).toString().trim();
    // On Windows, git returns /d/Projects/Foo — path.resolve normalizes to D:\Projects\Foo
    return path.resolve(raw);
  } catch {
    return null;
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
 * Parse a repository name out of a git remote URL. Handles the common
 * SSH (`git@host:owner/repo.git`), HTTPS (`https://host/owner/repo.git`),
 * `git://`, `ssh://`, and `file://` shapes. Returns `null` for empty /
 * unparseable input.
 *
 * The heuristic: strip a trailing `.git` and trailing slashes, then
 * take the segment after the last `/` or `:`.
 */
export const parseRepoNameFromUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Strip `.git` suffix (case-insensitive) and any trailing slashes.
  const withoutSuffix = trimmed.replace(/\.git\/*$/i, '').replace(/\/+$/, '');
  // Last path segment, splitting on either `/` or `:` (covers SSH form).
  const m = withoutSuffix.match(/[/:]([^/:]+)$/);
  const candidate = m ? m[1] : withoutSuffix;
  return candidate || null;
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
