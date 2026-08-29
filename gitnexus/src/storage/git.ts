import { execFileSync, execSync } from 'child_process';
import { statSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../core/logger.js';
import { toZeroBasedLine } from '../core/ingestion/utils/line-base.js';
import { GITNEXUS_MANAGED_PATH_EXCLUDES } from './gitnexus-managed-paths.js';

// Git utilities for repository detection, commit tracking, and diff analysis

const chompGitOutput = (value: Buffer): string => value.toString().replace(/\r?\n$/, '');
const GIT_PATH_LIST_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * True when the working tree has uncommitted changes that analyze would
 * re-index, even at a matching HEAD. Excludes GITNEXUS_MANAGED_PATHS so
 * GitNexus's own analyze output never counts as dirty (regression vs PR #1233
 * behavior); whole directory trees are excluded, not just their root entries,
 * because the skill mirror writes across .agents/skills/ and deeper paths.
 * Conservative on any git failure.
 *
 * This drives `analyze`'s up-to-date fast path. It is deliberately coarse:
 * a false "dirty" here costs only a hash diff that finds nothing. `status`
 * reaches for the per-file comparison in core/index-content-drift.ts instead,
 * because there the same false positive is a verdict the user cannot clear
 * (#3077), and falls back to this only when that comparison cannot run.
 */
export const isWorkingTreeDirty = (repoPath: string): boolean => {
  try {
    const out = execFileSync(
      'git',
      ['status', '--porcelain', '--', '.', ...GITNEXUS_MANAGED_PATH_EXCLUDES],
      {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        encoding: 'utf8',
      },
    );
    return out.trim().length > 0;
  } catch {
    return true; // conservative on git failure
  }
};

const parsePorcelainPaths = (porcelain: string): string[] => {
  const paths = new Set<string>();
  const records = porcelain.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;

    const status = record.slice(0, 2);
    paths.add(record.slice(3));

    // In porcelain v1 `-z` mode, rename/copy source and destination paths are
    // separate NUL records (with no human-facing ` -> ` delimiter). Keep both:
    // either side may be present in the previous coverage set.
    if (status.includes('R') || status.includes('C')) {
      const pairedPath = records[++i];
      if (pairedPath) paths.add(pairedPath);
    }
  }
  return [...paths];
};

const gitPathListExec = {
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
  windowsHide: true,
  encoding: 'utf8' as const,
  maxBuffer: GIT_PATH_LIST_MAX_BUFFER,
};

const listHiddenIndexPaths = (repoPath: string): string[] => {
  const out = execFileSync('git', ['ls-files', '-v', '-z', '--'], {
    cwd: repoPath,
    ...gitPathListExec,
  });
  const paths: string[] = [];
  for (const record of out.split('\0')) {
    if (record.length < 3 || record[1] !== ' ') continue;
    const tag = record[0];
    // `S` marks skip-worktree. With `-v`, an assume-unchanged entry's
    // ordinary tag is lower-cased (`H` -> `h`, `S` -> `s`, etc.).
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) paths.push(record.slice(2));
  }
  return paths;
};

/**
 * Repo-relative paths `git status` reports as dirty or untracked, using the
 * same managed-path excludes as {@link isWorkingTreeDirty}, plus tracked paths
 * whose assume-unchanged or skip-worktree bits can hide content changes from
 * porcelain. `null` means either query failed — callers must not treat that as
 * a clean tree.
 */
export const listWorkingTreeDirtyPaths = (repoPath: string): string[] | null => {
  try {
    const out = execFileSync(
      'git',
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        '.',
        ...GITNEXUS_MANAGED_PATH_EXCLUDES,
      ],
      { cwd: repoPath, ...gitPathListExec },
    );
    return [...new Set([...parsePorcelainPaths(out), ...listHiddenIndexPaths(repoPath)])];
  } catch {
    return null;
  }
};

/**
 * Snapshot, per candidate file, whether it is safe for `selfCommitContextFiles`
 * to auto-commit — call this BEFORE `analyze` writes AGENTS.md/CLAUDE.md.
 * A file is safe when it does not exist yet (first-time creation, the normal
 * case) or is currently clean (`git status --porcelain` reports nothing for
 * it). A file that already has an uncommitted user edit is unsafe: without
 * this check `selfCommitContextFiles` cannot tell that edit apart from the
 * stats refresh `analyze` is about to write, and would silently sweep both
 * into one generated-looking commit. Fails closed — a git failure marks the
 * file unsafe rather than assuming it's clean. See #2639 review round 2.
 */
export const snapshotSelfCommitSafety = (
  repoPath: string,
  candidateFiles: string[],
): Map<string, boolean> => {
  const safety = new Map<string, boolean>();
  for (const name of candidateFiles) {
    if (!existsSync(path.join(repoPath, name))) {
      safety.set(name, true);
      continue;
    }
    try {
      const status = execFileSync('git', ['status', '--porcelain', '--', name], {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        encoding: 'utf8',
      });
      safety.set(name, status.trim().length === 0);
    } catch {
      safety.set(name, false);
    }
  }
  return safety;
};

/**
 * Best-effort auto-commit for the AGENTS.md/CLAUDE.md files `analyze --self-commit`
 * just (re)wrote. Filters `candidateFiles` down to the ones that actually exist
 * under `repoPath` AND were marked safe by `snapshotSelfCommitSafety` — a file
 * that already had an uncommitted edit before this run is skipped (logged),
 * never swept into the generated commit. Never `git add -A`. `git status
 * --porcelain` (not `diff --quiet`) is deliberate: a first-time `analyze` run
 * creates AGENTS.md/CLAUDE.md fresh, and untracked files never show up in
 * `git diff`, only in `git status` — the same reason `isWorkingTreeDirty`
 * above uses `--porcelain`. If `git commit` fails after `git add` already
 * staged the safe files (e.g. missing git identity), the staged files are
 * reset back to unstaged so the user's index isn't silently left mutated.
 * No-ops silently (never throws) when: none of the candidate files exist or
 * are safe, none changed, or any git step fails. Must never fail the
 * surrounding `analyze` run. See #2639.
 */
export const selfCommitContextFiles = (
  repoPath: string,
  candidateFiles: string[],
  preRunSafety: Map<string, boolean>,
): void => {
  const existing = candidateFiles.filter((name) => existsSync(path.join(repoPath, name)));
  if (existing.length === 0) return;

  const safe = existing.filter((name) => preRunSafety.get(name) === true);
  const skippedDirty = existing.filter((name) => preRunSafety.get(name) !== true);
  if (skippedDirty.length > 0) {
    logger.warn(
      { files: skippedDirty },
      'gitnexus: --self-commit skipping file(s) with uncommitted changes from before this analyze run',
    );
  }
  if (safe.length === 0) return;

  try {
    const status = execFileSync('git', ['status', '--porcelain', '--', ...safe], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      encoding: 'utf8',
    });
    if (status.trim().length === 0) return; // nothing to commit
  } catch {
    return; // git failed (not a repo, git missing, etc.) — nothing to do
  }

  try {
    execFileSync('git', ['add', '--', ...safe], {
      cwd: repoPath,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (err) {
    logger.warn({ err, files: safe }, 'gitnexus: --self-commit failed to stage context files');
    return;
  }

  try {
    execFileSync(
      'git',
      ['commit', '-m', 'chore(gitnexus): refresh index stats [skip ci]', '--', ...safe],
      { cwd: repoPath, stdio: 'ignore', windowsHide: true },
    );
  } catch (err) {
    // Commit failed after `git add` already staged `safe` (e.g. missing git
    // identity). Restore the index to its pre-add state for exactly those
    // files rather than leaving them silently staged — `analyze` reporting
    // "success" must not leave the user's index mutated.
    try {
      execFileSync('git', ['reset', '--', ...safe], {
        cwd: repoPath,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* best-effort restore; nothing more we can do */
    }
    logger.warn({ err, files: safe }, 'gitnexus: --self-commit failed to commit context files');
  }
};

export const isGitRepo = (repoPath: string): boolean => {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: repoPath,
      stdio: 'ignore',
      windowsHide: true,
    });
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
      windowsHide: true,
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
};

/**
 * Remove `user[:password]@` userinfo from an http(s) URL.
 *
 * `git config remote.origin.url` returns whatever was configured, and the
 * HTTPS token form `https://x-access-token:<token>@host/owner/repo` is how
 * CI checkouts and credential helpers routinely authenticate. That string
 * reached `registry.json`, the per-repo meta and the MCP `list_repos`
 * payload verbatim, which turned repository discovery into credential
 * disclosure (#2914).
 *
 * Only `http`/`https` are rewritten. `ssh://git@host/…` and the SCP-like
 * `git@host:owner/repo` carry an SSH *user name*, not a secret, and are part
 * of the remote's identity — dropping it would repoint the sibling-clone
 * fingerprint (#2054) for every already-registered repo.
 *
 * The match is bounded by the authority (`[^/]*` cannot cross the first `/`
 * after the scheme) and greedy to the last `@` in it, so a password
 * containing `@` is removed whole rather than leaving its tail behind.
 */
export const stripUrlCredentials = (url: string): string =>
  url.replace(/^(https?:\/\/)[^/]*@/i, '$1');

/**
 * Get a stable canonical identifier for the repo's `origin` remote, if any.
 *
 * Used to fingerprint two on-disk clones as the same logical repository
 * (prevents silent graph drift across sibling clones — see #2054). `path` alone
 * is unreliable: worktrees, "clean clone for indexing" hygiene, and
 * multi-agent workspaces routinely have the same repo at multiple
 * absolute paths. The remote URL is the only on-disk signal that
 * survives those conventions.
 *
 * Normalisation strategy:
 *   - Strip http(s) userinfo credentials (see {@link stripUrlCredentials}).
 *     Done FIRST, before the host lower-casing below — that regex treats the
 *     whole `user:pass@host` span as the host and would mangle the secret's
 *     case on its way into the registry (#2914).
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
      windowsHide: true,
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  let normalised = stripUrlCredentials(raw)
    .replace(/\/$/, '')
    .replace(/\.git$/, '');

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
  const resolved = path.resolve(fromPath);
  // Avoid git rev-parse --show-toplevel trimming trailing spaces from the
  // repository root on Windows; callers that need identity keys canonicalize
  // this value with realpath before comparing it.
  if (hasGitDir(resolved)) return resolved;

  try {
    const raw = chompGitOutput(
      execSync('git rev-parse --show-toplevel', {
        cwd: fromPath,
        // Suppress stderr -- see getCurrentCommit comment and #1172.
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    );
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
    const commonDir = chompGitOutput(
      execSync('git rev-parse --path-format=absolute --git-common-dir', {
        cwd: fromPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    );
    if (!commonDir) return null;
    // Common dir is `<repo>/.git` for both the main checkout and all
    // linked worktrees. Its parent is the canonical repo root.
    return path.dirname(path.resolve(commonDir));
  } catch {
    return null;
  }
};

// getGitInfoExcludePath/getCoreExcludesFilePath are called once per repo
// PER language/contract extractor during group sync (#2606) — an N-repo
// group fans out to 6+ extractors each calling these, so an uncached
// execSync per call turns into O(extractors × repos) blocking subprocess
// spawns. Both resolve to the same value for the same fromPath for the
// life of the process (git config/exclude files don't change mid-run), so
// memoize by fromPath. ponytail: process-lifetime cache, never invalidated
// — fine for one-shot CLI runs; the long-lived MCP server would need a
// TTL or explicit invalidation if a user edits core.excludesFile mid-session.
const gitInfoExcludePathCache = new Map<string, string | null>();
const coreExcludesFilePathCache = new Map<string, string>();

/**
 * Path to the repo's `$GIT_COMMON_DIR/info/exclude` file — git's own
 * per-repo, untracked exclude list (same tier as `.gitignore` in
 * precedence, but never committed, so it works even when the caller has
 * no write access to the repo's tracked content). Shared across every
 * linked worktree of a repo, matching git's own resolution (#2606).
 *
 * Returns `null` when `fromPath` is not inside a git repository or `git`
 * is unavailable; callers should treat that the same as "no file".
 */
export const getGitInfoExcludePath = (fromPath: string): string | null => {
  const cached = gitInfoExcludePathCache.get(fromPath);
  if (cached !== undefined) return cached;

  let result: string | null;
  try {
    const commonDir = chompGitOutput(
      execSync('git rev-parse --path-format=absolute --git-common-dir', {
        cwd: fromPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    );
    result = commonDir ? path.join(path.resolve(commonDir), 'info', 'exclude') : null;
  } catch {
    result = null;
  }
  gitInfoExcludePathCache.set(fromPath, result);
  return result;
};

/**
 * Path to git's own global, all-repos ignore file: the value of
 * `core.excludesFile` (any config scope — system/global/local, resolved
 * the same way `git` itself would from `fromPath`), or git's documented
 * default of `$XDG_CONFIG_HOME/git/ignore` when unset (gitignore(5)).
 * Lowest-precedence source, mirroring git's own behavior (#2606).
 *
 * Never throws: an unset key or unavailable `git` falls through to the
 * default path, which is always computable without `git`.
 */
export const getCoreExcludesFilePath = (fromPath: string): string => {
  const cached = coreExcludesFilePathCache.get(fromPath);
  if (cached !== undefined) return cached;

  let result: string | undefined;
  try {
    const configured = chompGitOutput(
      execSync('git config --get --type=path core.excludesFile', {
        cwd: fromPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    );
    if (configured) result = configured;
  } catch {
    // Unset, or git unavailable — fall through to git's documented default.
  }
  if (!result) {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    result = path.join(xdgConfigHome, 'git', 'ignore');
  }
  coreExcludesFilePathCache.set(fromPath, result);
  return result;
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
      windowsHide: true,
    })
      .toString()
      .trim();
    return url || null;
  } catch {
    return null;
  }
};

/**
 * Best-effort detection of the repository's default branch (#243).
 *
 * Reads `git symbolic-ref --short refs/remotes/origin/HEAD`, which resolves to
 * the short ref `origin/<branch>` that the local `origin/HEAD` points at, and
 * strips the `origin/` prefix. This is a purely local lookup — it never makes a
 * network call. Returns `null` when there is no git repo, no `origin` remote, no
 * `origin/HEAD` (e.g. it was never set by clone, or the repo is detached), or
 * git is unavailable, so callers can fall back to a configured/default branch.
 */
export const getDefaultBranch = (repoPath: string): string | null => {
  try {
    const ref = execSync('git symbolic-ref --short refs/remotes/origin/HEAD', {
      cwd: repoPath,
      // Suppress stderr -- see getCurrentCommit comment and #1172. Without it,
      // git prints "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref"
      // to the user's terminal on repos that never set origin/HEAD.
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .toString()
      .trim();
    if (!ref) return null;
    return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
  } catch {
    return null;
  }
};

/**
 * Name of the currently checked-out branch, or `null` when HEAD is detached
 * (CI checkouts, `git checkout <sha>`), the directory is not a git worktree, or
 * git is unavailable.
 *
 * `git rev-parse --abbrev-ref HEAD` prints the literal `HEAD` for a detached
 * checkout. We map that (and empty output) to `null` so callers fall back to the
 * flat/default index rather than ever creating a branch literally named
 * "HEAD" (#2106).
 */
export const getCurrentBranch = (repoPath: string): string | null => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      // Suppress stderr -- see getCurrentCommit comment and #1172.
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .toString()
      .trim();
    if (!branch || branch === 'HEAD') return null;
    return branch;
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

/**
 * An inclusive run of changed lines in the NEW file, 1-based like `@@` headers
 * and every other git line number. Graph rows are 0-based (#2377), so a consumer
 * comparing the two converts one side first — see `coalesceHunks` callers.
 */
export interface DiffHunk {
  startLine: number;
  endLine: number;
  /** Phantom brand, never set — see {@link GraphLineRange}. */
  readonly lineBase?: 'git1';
}

export interface FileDiff {
  filePath: string;
  hunks: DiffHunk[];
}

/**
 * Parse unified diff output (with -U0) into per-file hunk ranges.
 * Extracts the new-file line ranges from @@ hunk headers.
 *
 * A pure deletion adds no new lines, and unified diff spells that empty range
 * as the line BEFORE it: `@@ -4,2 +3,0 @@` removed old lines 4–5 from between
 * new lines 3 and 4 (git emits `+0,0` when the deletion is at the head of the
 * file). The hunk still says WHERE the change landed, so it becomes the
 * one-line range at that anchor rather than being dropped. Dropping it left the
 * file entry with no hunks at all, so `detect_changes` contributed no bound for
 * the path, issued no query, and reported "No changes detected." for a commit
 * that deleted a function (#2915 review).
 *
 * The anchor line only, not the pair straddling the gap: a symbol that
 * contained the deleted text still contains the anchor, whereas extending to
 * the following line would also claim a symbol that merely STARTS after the
 * gap — the widening {@link coalesceHunks} is careful never to do.
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
        } else {
          // Deletion: anchor on the line the removed text followed, clamped to
          // 1 for a `+0,0` deletion at the head of the file (see above).
          const anchor = Math.max(start, 1);
          current.hunks.push({ startLine: anchor, endLine: anchor });
        }
      }
    }
  }
  return files;
}

/**
 * Merge a file's hunks into sorted, non-touching ranges.
 *
 * `detect_changes` used to fold one `(n.startLine <= $hunkEndI AND n.endLine >=
 * $hunkStartI)` pair per hunk into a single Cypher `WHERE` clause. A
 * machine-generated file (a cache JSON, a lockfile, a golden fixture) diffs at
 * thousands of hunks with `-U0`, and the resulting expression tree is deep
 * enough that LadybugDB's recursive evaluator copy overflows its worker-thread
 * stack: a bare SIGBUS with no error output where secondary threads get 512 KB
 * (macOS), and a swallowed 30s query timeout where they get more (#2915).
 *
 * Only ranges that overlap or ABUT (`next.startLine <= current.endLine + 1`)
 * are merged, so the union covers exactly the lines the raw hunks covered —
 * coalescing can never widen a range into a symbol the hunks did not touch.
 */
export function coalesceHunks(hunks: readonly GraphLineRange[]): GraphLineRange[] {
  if (hunks.length === 0) return [];
  const sorted = [...hunks].sort((a, b) => a.startLine - b.startLine);
  const merged: GraphLineRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const next = sorted[i];
    if (next.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, next.endLine);
    else merged.push({ ...next });
  }
  return merged;
}

/**
 * An inclusive line range in the GRAPH's 0-based space, not git's 1-based one.
 *
 * A separate type from {@link DiffHunk} on purpose: the two carry the same two
 * fields in different bases, and mixing them is exactly the #2377 bug — every
 * symbol shifts one line and an edit to a symbol's last line reports nothing
 * changed. The phantom `lineBase` field is what makes that distinction real to
 * the compiler: two OPTIONAL properties with incompatible literal types are
 * mutually unassignable, so a value typed {@link DiffHunk} cannot reach
 * {@link hunksOverlapRange} without a conversion in between, while a bare
 * `{ startLine, endLine }` literal still satisfies both and no construction
 * site needs a cast. The brand catches plumbing that passes the wrong array,
 * not a range a caller built by hand out of 1-based numbers.
 */
export interface GraphLineRange {
  startLine: number;
  endLine: number;
  /** Phantom brand, never set — see above. */
  readonly lineBase?: 'graph0';
}

/**
 * Group a diff's hunks by file, converted into the graph's 0-based line space.
 *
 * The conversion lives here, at the parse boundary, rather than in each
 * consumer: `parseDiffHunks` stays faithful to git (1-based, like the `@@`
 * headers it reads) and everything downstream compares graph-native values.
 *
 * A path can appear twice in one diff (e.g. a rename reported alongside an
 * edit), so hunks accumulate per path instead of the later entry winning —
 * accumulated raw first, coalesced once, so a path repeated K times costs one
 * sort rather than K.
 */
export function coalesceHunksByPath(fileDiffs: FileDiff[]): Map<string, GraphLineRange[]> {
  const rawByPath = new Map<string, GraphLineRange[]>();
  for (const fileDiff of fileDiffs) {
    const ranges = rawByPath.get(fileDiff.filePath) ?? [];
    for (const hunk of fileDiff.hunks) {
      ranges.push({
        startLine: toZeroBasedLine(hunk.startLine),
        endLine: toZeroBasedLine(hunk.endLine),
      });
    }
    if (ranges.length > 0) rawByPath.set(fileDiff.filePath, ranges);
  }

  const byPath = new Map<string, GraphLineRange[]>();
  for (const [filePath, ranges] of rawByPath) byPath.set(filePath, coalesceHunks(ranges));
  return byPath;
}

/**
 * Does any hunk overlap the inclusive line range [startLine, endLine]?
 *
 * `coalesced` must come from {@link coalesceHunks} — sorted and disjoint, which
 * is what makes the binary search valid — and both sides must use the same line
 * base.
 */
export function hunksOverlapRange(
  coalesced: GraphLineRange[],
  startLine: number,
  endLine: number,
): boolean {
  // Lower bound: first hunk ending at or after startLine. `lo === length` means
  // every hunk ends before the range starts (and covers the empty list).
  let lo = 0;
  let hi = coalesced.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (coalesced[mid].endLine >= startLine) hi = mid;
    else lo = mid + 1;
  }
  return lo < coalesced.length && coalesced[lo].startLine <= endLine;
}
