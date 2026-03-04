/**
 * Staleness Check
 * 
 * Checks if the GitNexus index is behind the current git HEAD.
 * Returns a hint for the LLM to call analyze if stale.
 */

import { execFileSync } from 'child_process';
import { getRelevantChangedFilesSinceCommit, type RepoIgnoreOptions } from '../config/ignore-service.js';

export interface StalenessInfo {
  isStale: boolean;
  commitsBehind: number;
  changedFiles?: number;
  ignoredOnlyChanges?: boolean;
  hint?: string;
}

/**
 * Check how many commits the index is behind HEAD
 */
export function checkStaleness(
  repoPath: string,
  lastCommit: string,
  ignoreOptions: RepoIgnoreOptions = {},
): StalenessInfo {
  try {
    if (!lastCommit || lastCommit === 'HEAD') {
      return { isStale: false, commitsBehind: 0 };
    }

    // Get count of commits between lastCommit and HEAD
    const result = execFileSync(
      'git', ['rev-list', '--count', `${lastCommit}..HEAD`],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    
    const commitsBehind = parseInt(result, 10) || 0;
    
    if (commitsBehind > 0) {
      const { relevantChangedFiles } = getRelevantChangedFilesSinceCommit(repoPath, lastCommit, ignoreOptions);
      if (relevantChangedFiles.length === 0) {
        return {
          isStale: false,
          commitsBehind: 0,
          ignoredOnlyChanges: true,
          hint: 'Only ignored paths changed since last index.',
        };
      }

      return {
        isStale: true,
        commitsBehind,
        changedFiles: relevantChangedFiles.length,
        hint: `⚠️ Index is ${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind HEAD with ${relevantChangedFiles.length} relevant file change${relevantChangedFiles.length > 1 ? 's' : ''}. Run analyze tool to update.`,
      };
    }
    
    return { isStale: false, commitsBehind: 0 };
  } catch {
    // If git command fails, assume not stale (fail open)
    return { isStale: false, commitsBehind: 0 };
  }
}
