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
export function readSafe(repoPath: string, rel: string, maxBytes?: number): string | null {
  const abs = path.resolve(repoPath, rel);
  const base = path.resolve(repoPath);
  const relToBase = path.relative(base, abs);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) return null;
  try {
    const canonicalBase = fs.realpathSync(base);
    const canonicalFile = fs.realpathSync(abs);
    const canonicalRelative = path.relative(canonicalBase, canonicalFile);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) return null;
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const fd = fs.openSync(canonicalFile, fs.constants.O_RDONLY | noFollow);
    try {
      if (maxBytes !== undefined && fs.fstatSync(fd).size > maxBytes) return null;
      return fs.readFileSync(fd, 'utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
