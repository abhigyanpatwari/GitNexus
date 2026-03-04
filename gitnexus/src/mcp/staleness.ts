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
  ignoreRulesChanged?: boolean;
  hint?: string;
}

const normalizePath = (value: string): string => (
  value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/')
);

const isIgnoreRuleFile = (
  changedFile: string,
  ignoreOptions: RepoIgnoreOptions = {},
): boolean => {
  const normalized = normalizePath(changedFile);
  if (!normalized) {
    return false;
  }

  const fileName = normalized.split('/').pop()?.toLowerCase() ?? '';
  if (fileName === '.gitignore') {
    return true;
  }
  if (fileName === '.gitnexusignore' || fileName.startsWith('.gitnexusignore.')) {
    return true;
  }

  const explicitIgnoreFile = (ignoreOptions.ignoreFile ?? process.env.GITNEXUS_IGNORE_FILE)?.trim();
  if (!explicitIgnoreFile) {
    return false;
  }
  return normalized === normalizePath(explicitIgnoreFile);
};

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
      const { allChangedFiles, relevantChangedFiles } = getRelevantChangedFilesSinceCommit(repoPath, lastCommit, ignoreOptions);
      const changedIgnoreRuleFiles = allChangedFiles.filter((file) => isIgnoreRuleFile(file, ignoreOptions));
      if (relevantChangedFiles.length === 0) {
        if (changedIgnoreRuleFiles.length > 0) {
          return {
            isStale: true,
            commitsBehind,
            changedFiles: changedIgnoreRuleFiles.length,
            ignoreRulesChanged: true,
            hint: `⚠️ Index is ${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind HEAD and ignore rules changed in ${changedIgnoreRuleFiles.length} file${changedIgnoreRuleFiles.length > 1 ? 's' : ''}. Run analyze tool to update.`,
          };
        }

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
