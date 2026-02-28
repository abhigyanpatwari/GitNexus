/**
 * Staleness Check
 * 
 * Checks if the GitNexus index is behind the current git HEAD.
 * Returns a hint for the LLM to call analyze if stale.
 */

import { execFileSync } from 'child_process';
import path from 'path';

export interface StalenessInfo {
  isStale: boolean;
  commitsBehind: number;
  hint?: string;
}

/**
 * Check how many commits the index is behind HEAD
 */
export function checkStaleness(repoPath: string, lastCommit: string): StalenessInfo {
  try {
    // Validate lastCommit is a hex hash to prevent command injection
    if (!/^[0-9a-f]{7,40}$/i.test(lastCommit)) {
      return { isStale: false, commitsBehind: 0 };
    }
    // Get count of commits between lastCommit and HEAD
    const result = execFileSync(
      'git', ['rev-list', '--count', `${lastCommit}..HEAD`],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    
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
    // If git command fails, assume not stale (fail open)
    return { isStale: false, commitsBehind: 0 };
  }
}
