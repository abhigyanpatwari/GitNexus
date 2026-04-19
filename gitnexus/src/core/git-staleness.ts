/**
 * Git working tree vs index commit staleness (used by MCP resources, group status, etc.).
 * Lives in core/ so application code does not depend on the MCP package layer.
 */

import { execFileSync } from 'node:child_process';

export interface StalenessInfo {
  isStale: boolean;
  commitsBehind: number;
  hint?: string;
  artifactOnly?: boolean;
  changedFiles?: string[];
}

const GENERATED_INDEX_PATHS = [
  /^\.gitnexus(?:\/|$)/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^\.claude\/skills\/gitnexus(?:\/|$)/,
  /^\.claude\/skills\/generated(?:\/|$)/,
];

export function isGeneratedIndexPath(filePath: string): boolean {
  return GENERATED_INDEX_PATHS.some((pattern) => pattern.test(filePath));
}

function getChangedFiles(repoPath: string, lastCommit: string): string[] {
  const output = execFileSync('git', ['diff', '--name-only', `${lastCommit}..HEAD`], {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean);
}

/**
 * Check how many commits the index is behind HEAD (synchronous; uses git CLI).
 *
 * A common workflow commits the generated `.gitnexus/lbug`, `meta.json`, and
 * agent context files after running analyze. That creates a new commit whose
 * source code did not change, so commit-hash comparison alone would report a
 * permanently stale index. Treat those index-artifact-only commits as fresh.
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
      const changedFiles = getChangedFiles(repoPath, lastCommit);
      if (changedFiles.length > 0 && changedFiles.every(isGeneratedIndexPath)) {
        return {
          isStale: false,
          commitsBehind,
          artifactOnly: true,
          changedFiles,
        };
      }

      return {
        isStale: true,
        commitsBehind,
        changedFiles,
        hint: `⚠️ Index is ${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind HEAD. Run analyze tool to update.`,
      };
    }

    return { isStale: false, commitsBehind: 0 };
  } catch {
    return { isStale: false, commitsBehind: 0 };
  }
}
