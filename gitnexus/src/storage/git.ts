import { execSync } from 'child_process';
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
 * Get files changed between two commits (relative paths from repo root).
 * Returns an empty array if the diff fails (e.g. shallow clone, first commit).
 */
export const getChangedFiles = (repoPath: string, fromCommit: string, toCommit: string): string[] => {
  try {
    const output = execSync(
      `git diff --name-only ${fromCommit} ${toCommit}`,
      { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString().trim();
    if (!output) return [];
    return output.split('\n').map(f => f.trim()).filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Find the git repository root from any path inside the repo
 */
export const getGitRoot = (fromPath: string): string | null => {
  try {
    const raw = execSync('git rev-parse --show-toplevel', { cwd: fromPath })
      .toString()
      .trim();
    // On Windows, git returns /d/Projects/Foo — path.resolve normalizes to D:\Projects\Foo
    return path.resolve(raw);
  } catch {
    return null;
  }
};
