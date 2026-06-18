/**
 * Upload working-directory paths.
 *
 * Browser folder uploads are written into getGlobalDir()/uploads/{name}/ — a
 * sibling of the clone root (git-clone.ts CLONE_ROOT) — so an uploaded repo
 * persists and behaves like a cloned one (the graph UI's /api/file reads its
 * files after analysis, and DELETE /api/repo removes it). Staging happens in
 * an mkdtemp dir *under* UPLOAD_ROOT so the promote rename stays on one
 * filesystem and remains atomic (a rename from os.tmpdir() could trip EXDEV —
 * the exact Docker case this feature targets; see bridge-db.ts for the same
 * anchored-staging pattern).
 */

import path from 'path';
import { sanitizeRepoName } from '../storage/git.js';
import { REPO_NAME_PATTERN } from './git-clone.js';
import { getGlobalDir } from '../storage/repo-manager.js';

/**
 * Root directory for all uploaded repositories. Targets must resolve inside this.
 *
 * Sourced from getGlobalDir() so it honors GITNEXUS_HOME and stays a sibling of
 * the clone root on the same (in Docker, persistent) volume. Falls back to
 * ~/.gitnexus when the env var is unset.
 */
export const UPLOAD_ROOT = path.resolve(path.join(getGlobalDir(), 'uploads'));

/** Prefix for per-upload staging directories created under UPLOAD_ROOT. */
export const STAGING_PREFIX = '.staging-';

/**
 * Get the upload target directory for a repo name.
 *
 * Re-validates at the boundary (callers may derive the name from an untrusted
 * manifest). Rejects `.`, `..`, the `'unknown'` sentinel that sanitizeRepoName
 * emits for un-nameable inputs, names beginning with `.` (which would collide
 * with the `.staging-` prefix), and anything outside the safe charset.
 */
export function getUploadDir(repoName: string): string {
  if (
    !repoName ||
    repoName === '.' ||
    repoName === '..' ||
    repoName === 'unknown' ||
    repoName.startsWith('.') ||
    !REPO_NAME_PATTERN.test(repoName)
  ) {
    throw new Error('Invalid repository name');
  }
  return path.join(UPLOAD_ROOT, repoName);
}

/**
 * Derive a filesystem-safe upload directory name from the manifest's
 * top-level folder. Returns null when the name is un-nameable (so the caller
 * rejects with 400 rather than colliding everyone on `UPLOAD_ROOT/unknown`).
 */
export function deriveUploadName(topLevelName: string): string | null {
  const safe = sanitizeRepoName(topLevelName);
  if (safe === 'unknown' || safe === '.' || safe === '..' || safe.startsWith('.')) {
    return null;
  }
  return safe;
}
