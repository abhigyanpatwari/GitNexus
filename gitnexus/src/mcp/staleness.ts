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

const resolveIgnoreOverride = (
  optionValue: string | null | undefined,
  envValue: string | undefined,
): string | null => {
  if (optionValue === null) {
    return null;
  }
  if (optionValue === undefined) {
    const trimmedEnv = envValue?.trim();
    return trimmedEnv || null;
  }
  const trimmedOption = optionValue.trim();
  return trimmedOption || null;
};

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

  const explicitIgnoreFile = resolveIgnoreOverride(ignoreOptions.ignoreFile, process.env.GITNEXUS_IGNORE_FILE);
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
    const normalizedLastCommit = (lastCommit || '').trim();

    if (normalizedLastCommit === 'HEAD') {
      return { isStale: false, commitsBehind: 0 };
    }

    if (!normalizedLastCommit) {
      // Indexed metadata can store an empty commit marker when analyze runs
      // before the repository's first commit. Once HEAD exists, that index is stale.
      const headCommit = execFileSync(
        'git', ['rev-parse', '--verify', 'HEAD'],
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (!headCommit) {
        return { isStale: false, commitsBehind: 0 };
      }

      const headCountResult = execFileSync(
        'git', ['rev-list', '--count', 'HEAD'],
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const commitsBehind = parseInt(headCountResult, 10) || 1;

      return {
        isStale: true,
        commitsBehind,
        hint: `⚠️ Indexed commit baseline is unknown while repository has ${commitsBehind} commit${commitsBehind > 1 ? 's' : ''}. Run analyze tool to update.`,
      };
    }

    try {
      execFileSync(
        'git', ['cat-file', '-e', `${normalizedLastCommit}^{commit}`],
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      try {
        const isRepo = execFileSync(
          'git', ['rev-parse', '--is-inside-work-tree'],
          { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        if (isRepo === 'true') {
          return {
            isStale: true,
            commitsBehind: 1,
            hint: `⚠️ Indexed commit ${normalizedLastCommit.slice(0, 12)} is no longer available in repository history. Run analyze tool to update.`,
          };
        }
      } catch {
        throw new Error('Repository validation failed');
      }
    }

    // Get count of commits between lastCommit and HEAD
    const result = execFileSync(
      'git', ['rev-list', '--count', `${normalizedLastCommit}..HEAD`],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    
    const commitsBehind = parseInt(result, 10) || 0;
    
    if (commitsBehind > 0) {
      const { allChangedFiles, relevantChangedFiles } = getRelevantChangedFilesSinceCommit(repoPath, normalizedLastCommit, ignoreOptions);
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
