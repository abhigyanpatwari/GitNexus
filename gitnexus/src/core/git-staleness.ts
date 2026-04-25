/**
 * Git working tree vs index commit staleness (used by MCP resources, group status, etc.).
 * Lives in core/ so application code does not depend on the MCP package layer.
 */

import { execFileSync } from 'node:child_process';
import path from 'path';
import { readRegistry, type RegistryEntry, type CwdMatch } from '../storage/repo-manager.js';
import { getGitRoot, getCurrentCommit, getRemoteUrl } from '../storage/git.js';

export interface StalenessInfo {
  isStale: boolean;
  commitsBehind: number;
  hint?: string;
}

/**
 * Check how many commits the index is behind HEAD (synchronous; uses git CLI).
 */
export function checkStaleness(repoPath: string, lastCommit: string): StalenessInfo {
  try {
    const result = execFileSync('git', ['rev-list', '--count', `${lastCommit}..HEAD`], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const commitsBehind = parseInt(result, 10) || 0;

    if (commitsBehind > 0) {
      return {
        isStale: true,
        commitsBehind,
        hint: `⚠️ Index is ${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind HEAD. Run analyze tool to update.`,
      };
    }

    return { isStale: false, commitsBehind: 0 };
  } catch {
    return { isStale: false, commitsBehind: 0 };
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
    if (cwdNorm === p || cwdNorm.startsWith(p + sep)) {
      if (p.length > bestLen) {
        bestPath = e;
        bestLen = p.length;
      }
    }
  }
  if (bestPath) return { match: 'path', entry: bestPath };

  // 2) Sibling-by-remote: locate the cwd's git root, get its remote
  //    URL, and look for any registered entry with the same fingerprint.
  const cwdGitRoot = getGitRoot(cwdResolved);
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
