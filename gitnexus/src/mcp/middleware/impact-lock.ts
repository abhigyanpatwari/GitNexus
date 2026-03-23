/**
 * Impact-Lock Middleware (T028)
 *
 * Automatically acquires swarm-lock on all files within the Blast Radius
 * before dispatching agents. Prevents write conflicts in swarm operations.
 *
 * Usage:
 *   import { lockBlastRadius, unlockBlastRadius, listLocks } from './middleware/impact-lock.js';
 *
 *   const result = await lockBlastRadius(['src/foo.ts', 'src/bar.ts'], 'Agent-A', '/repo');
 *   // ... edit files ...
 *   await unlockBlastRadius(result.lockedFiles, 'Agent-A', '/repo');
 */

import { execSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Resolve the swarm-lock script path relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SWARM_LOCK_SCRIPT = path.resolve(
  __dirname,
  '../../../../scripts/swarm-lock'
);

export interface ImpactLockResult {
  /** Files that were successfully locked */
  lockedFiles: string[];
  /** Files that could not be locked (already held by another agent) */
  failedFiles: string[];
  /** The agent ID that owns these locks */
  agentId: string;
}

export interface LockStatus {
  file: string;
  owner: string;
}

/**
 * Lock all files within the blast radius of a symbol.
 *
 * Iterates over the given file list and calls swarm-lock for each entry.
 * Files that are already locked by another agent are recorded in `failedFiles`
 * rather than throwing — the caller decides whether to proceed or abort.
 *
 * @param files    List of file paths to lock (relative to `repoPath`)
 * @param agentId  Unique identifier for the agent acquiring the lock
 * @param repoPath Absolute path to the repository root
 * @returns        Breakdown of locked vs failed files
 */
export async function lockBlastRadius(
  files: string[],
  agentId: string,
  repoPath: string
): Promise<ImpactLockResult> {
  const lockedFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const file of files) {
    // Normalise to repo-relative path so the lock key is consistent
    const relPath = path.isAbsolute(file) ? path.relative(repoPath, file) : file;

    try {
      const output = execSync(
        `node "${SWARM_LOCK_SCRIPT}" lock "${relPath}" "${agentId}"`,
        { cwd: repoPath, encoding: 'utf-8' }
      ).trim();

      if (output.startsWith('SUCCESS')) {
        lockedFiles.push(relPath);
      } else {
        failedFiles.push(relPath);
      }
    } catch {
      // swarm-lock exits with code 1 when the file is already locked
      failedFiles.push(relPath);
    }
  }

  return { lockedFiles, failedFiles, agentId };
}

/**
 * Release all swarm-locks acquired by an agent.
 *
 * Uses best-effort semantics: individual unlock failures are silently ignored
 * so that a partial lock list doesn't leave the system in a broken state.
 *
 * @param files    File paths to unlock (relative to `repoPath`)
 * @param agentId  Agent identifier that owns the locks
 * @param repoPath Absolute path to the repository root
 */
export async function unlockBlastRadius(
  files: string[],
  agentId: string,
  repoPath: string
): Promise<void> {
  for (const file of files) {
    const relPath = path.isAbsolute(file) ? path.relative(repoPath, file) : file;

    try {
      execSync(
        `node "${SWARM_LOCK_SCRIPT}" unlock "${relPath}" "${agentId}"`,
        { cwd: repoPath, encoding: 'utf-8' }
      );
    } catch {
      // Best-effort: ignore errors during unlock
    }
  }
}

/**
 * Return a list of all currently locked files in the repository.
 *
 * Each entry is the file path as stored by swarm-lock (repo-relative with
 * slashes, normalised from the `__`-separated lock file name).
 *
 * @param repoPath Absolute path to the repository root
 * @returns        Array of locked file paths, empty array on error
 */
export function listLocks(repoPath: string): string[] {
  try {
    const output = execSync(
      `node "${SWARM_LOCK_SCRIPT}" list`,
      { cwd: repoPath, encoding: 'utf-8' }
    ).trim();

    return JSON.parse(output) as string[];
  } catch {
    return [];
  }
}
