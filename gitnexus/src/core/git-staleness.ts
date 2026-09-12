/**
 * Git working tree vs index commit staleness (used by MCP resources, group status, etc.).
 * Lives in core/ so application code does not depend on the MCP package layer.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'path';
import { readRegistry, type RegistryEntry, type CwdMatch } from '../storage/repo-manager.js';
import { findGitRootByDotGit, getCurrentCommit, getRemoteUrl } from '../storage/git.js';
import type { StalenessInfo } from './staleness-status.js';

// The status/payload types and helpers live in the pure `staleness-status.ts`
// (#3256); the types are re-exported here for existing importers.
export type { StalenessInfo, StalenessStatus } from './staleness-status.js';

const execFileAsync = promisify(execFile);

/**
 * Ceiling for one `git rev-list` staleness probe. Generous for the local
 * history walk this is, and short enough that an unresponsive working tree
 * degrades to "not stale" quickly rather than holding a request open.
 */
const STALENESS_TIMEOUT_MS = 5_000;

const behindHint = (n: number): string =>
  `⚠️ Index is ${n} commit${n > 1 ? 's' : ''} behind HEAD. Run analyze tool to update.`;

// Says only what a failed count plus a resolved HEAD establish: the index is not
// at HEAD and the gap is uncountable. Reaching here does NOT prove the indexed
// commit left history — that is the usual cause (a pruned `fetch --depth 1`),
// but any other `rev-list` failure lands here too, so the cause is hedged.
const DIVERGED_HINT =
  "⚠️ Index is not at HEAD and the commit gap could not be counted — the recorded commit may no longer be in this clone's history. Run analyze tool to update.";

const unknown = (): StalenessInfo => ({ isStale: false, commitsBehind: 0, status: 'unknown' });

const fromCount = (commitsBehind: number): StalenessInfo =>
  commitsBehind > 0
    ? { isStale: true, commitsBehind, hint: behindHint(commitsBehind), status: 'behind' }
    : { isStale: false, commitsBehind: 0, status: 'current' };

/**
 * `rev-list` could not answer. Asking for HEAD alone needs no history walk and
 * still separates all three answers: HEAD unreadable is `unknown`, HEAD past the
 * indexed commit is `diverged`, and HEAD still *at* it is `current` — the ref
 * prints the indexed SHA, so the index is at HEAD however `rev-list` failed. The
 * historical fail-open values are kept either way; only `status` differs.
 */
const fromHead = (head: string | null, lastCommit: string): StalenessInfo => {
  if (!head) return unknown();
  if (head === lastCommit) return { isStale: false, commitsBehind: 0, status: 'current' };
  return { isStale: false, commitsBehind: 0, hint: DIVERGED_HINT, status: 'diverged' };
};

const readHeadSync = (repoPath: string): string | null => {
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim() || null
    );
  } catch {
    return null;
  }
};

const readHeadAsync = async (repoPath: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: STALENESS_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/**
 * Check how many commits the index is behind HEAD (synchronous; uses git CLI).
 */
export function checkStaleness(repoPath: string, lastCommit: string): StalenessInfo {
  // No recorded commit is not "at HEAD": there is nothing to measure against.
  if (!lastCommit) return unknown();
  try {
    const result = execFileSync('git', ['rev-list', '--count', `${lastCommit}..HEAD`], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();

    return fromCount(parseInt(result, 10) || 0);
  } catch {
    return fromHead(readHeadSync(repoPath), lastCommit);
  }
}

/**
 * Async variant of {@link checkStaleness} — spawns git as a child process
 * instead of blocking the event loop.  Used by `listRepos()` to check many
 * repos in parallel (issue #1363: 200 repos × sync spawn ≈ 50 s).
 */
export async function checkStalenessAsync(
  repoPath: string,
  lastCommit: string,
): Promise<StalenessInfo> {
  if (!lastCommit) return unknown();
  try {
    // Note: promisified execFile captures stdout/stderr by default (no stdio option needed,
    // unlike the sync variant which requires explicit stdio: ['pipe','pipe','pipe']).
    const { stdout } = await execFileAsync('git', ['rev-list', '--count', `${lastCommit}..HEAD`], {
      cwd: repoPath,
      encoding: 'utf-8',
      windowsHide: true,
      // The catch below fails closed on every git ERROR, but a hang is not an
      // error — it is silence, and without a bound this await never settles.
      // A working tree on a disconnected network mount or behind a stuck lock
      // does exactly that, and `/api/repos` fans this out once per registered
      // repo, so one unreachable mount could hold the whole listing open
      // (#3232 review). The timeout kills the child and rejects, and the catch
      // below reports it as `unknown` — still the fail-closed `isStale: false`.
      timeout: STALENESS_TIMEOUT_MS,
    });

    return fromCount(parseInt(stdout.trim(), 10) || 0);
  } catch (err) {
    // A rev-list that timed out means the working tree is not answering. Asking
    // it again for HEAD would only double the bound #3232 put on a hung mount.
    if ((err as { killed?: boolean }).killed) return unknown();
    return fromHead(await readHeadAsync(repoPath), lastCommit);
  }
}

/**
 * Compare a sibling-clone HEAD against an indexed `lastCommit`. Returns
 * `undefined` when the indexed commit is not reachable from the sibling
 * (e.g. divergent branches, shallow clone, missing ref). The caller
 * should treat `undefined` as "drift unknown" rather than "no drift".
 */
function commitsAheadOfIndexed(siblingPath: string, indexedCommit: string): number | undefined {
  if (!indexedCommit) return undefined;
  try {
    const result = execFileSync('git', ['rev-list', '--count', `${indexedCommit}..HEAD`], {
      cwd: siblingPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a working directory against the global registry. Returns:
 *   - `match: 'path'`              when `cwd` is inside a registered entry's path
 *   - `match: 'sibling-by-remote'` when `cwd` lives in a different on-disk clone
 *                                   of the same repo (same `remoteUrl`)
 *   - `match: 'none'`              when neither match applies
 *
 * For sibling-by-remote matches, the caller's HEAD and the drift vs the
 * indexed `lastCommit` are also returned so the MCP layer can warn
 * before serving silently-stale answers (issue: silent graph drift
 * across sibling clones).
 *
 * `path` matches deliberately use the longest-prefix rule so a cwd
 * inside a sub-path of a registered repo still matches that repo, not
 * a coincidentally-aliased shorter entry.
 */
export async function checkCwdMatch(cwd: string): Promise<CwdMatch> {
  const entries = await readRegistry();
  if (entries.length === 0) return { match: 'none' };

  const isWin = process.platform === 'win32';
  const norm = (p: string) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
  const sep = path.sep;
  const cwdResolved = path.resolve(cwd);
  const cwdNorm = norm(cwdResolved);

  // 1) Path-based match (longest prefix wins, boundary-safe).
  let bestPath: RegistryEntry | undefined;
  let bestLen = -1;
  for (const e of entries) {
    const p = norm(e.path);
    if (cwdNorm === p || cwdNorm.startsWith(p.endsWith(sep) ? p : p + sep)) {
      if (p.length > bestLen) {
        bestPath = e;
        bestLen = p.length;
      }
    }
  }
  if (bestPath) return { match: 'path', entry: bestPath };

  // 2) Sibling-by-remote: locate the cwd's git root using only ancestor
  //    `.git` checks before shelling out. This keeps MCP startup from
  //    running git in an unrelated launch cwd such as $HOME (#1138).
  const cwdGitRoot = findGitRootByDotGit(cwdResolved);
  if (!cwdGitRoot) return { match: 'none' };

  const cwdRemote = getRemoteUrl(cwdGitRoot);
  if (!cwdRemote) return { match: 'none' };

  const sibling = entries.find(
    (e) => e.remoteUrl === cwdRemote && norm(e.path) !== norm(cwdGitRoot),
  );
  if (!sibling) return { match: 'none' };

  const cwdHead = getCurrentCommit(cwdGitRoot) || undefined;
  const drift = commitsAheadOfIndexed(cwdGitRoot, sibling.lastCommit);

  // Same commit on both clones → still report match=sibling-by-remote
  // (the relationship is real and useful to callers like list_repos /
  // future tooling) but leave `hint` unset: there's nothing to warn
  // about, and `maybeWarnSiblingDrift` already short-circuits this
  // case independently. Surfacing a no-op hint would force callers
  // to second-guess whether they need to display it.
  let hint: string | undefined;
  if (cwdHead && cwdHead === sibling.lastCommit) {
    hint = undefined;
  } else if (drift && drift > 0) {
    hint =
      `⚠️ Index for "${sibling.name}" was built at ${sibling.path}; ` +
      `your cwd (${cwdGitRoot}) is a sibling clone that is ${drift} commit${drift > 1 ? 's' : ''} ` +
      `ahead of the indexed commit. Results may be stale or incorrect — re-run \`gitnexus analyze\` ` +
      `to refresh the index.`;
  } else {
    hint =
      `⚠️ Index for "${sibling.name}" was built at ${sibling.path}; ` +
      `your cwd (${cwdGitRoot}) is a sibling clone whose HEAD differs from the indexed commit. ` +
      `Results may be stale or incorrect — re-run \`gitnexus analyze\` to refresh the index.`;
  }

  return {
    match: 'sibling-by-remote',
    entry: sibling,
    cwdGitRoot,
    cwdHead,
    drift,
    hint,
  };
}
