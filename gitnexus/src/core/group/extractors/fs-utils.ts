import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Safely read a file inside a repo, rejecting any path that escapes
 * `repoPath` via `..` traversal or absolute segments. Returns `null` if
 * the path is outside the repo or the file can't be read.
 *
 * Used by every source-scan extractor under this directory. Kept as a
 * single shared implementation so the path-traversal guard (security-
 * sensitive) lives in exactly one place.
 */
export function readSafe(repoPath: string, rel: string): string | null {
  const abs = path.resolve(repoPath, rel);
  const base = path.resolve(repoPath);
  const relToBase = path.relative(base, abs);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) return null;
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}
