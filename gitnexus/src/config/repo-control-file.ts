import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_REPO_CONTROL_FILE_BYTES = 1024 * 1024;

/** Read a bounded, regular control file owned by the repository root. */
export function readRepoControlFileSync(repoRoot: string, filename: string): string | null {
  const requestedRoot = path.resolve(repoRoot);
  const requested = path.resolve(requestedRoot, filename);
  const relative = path.relative(requestedRoot, requested);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${filename} resolves outside the repository root`);
  }

  let fd: number | undefined;
  try {
    const entry = fs.lstatSync(requested);
    if (entry.isSymbolicLink()) throw new Error(`${filename} must not be a symbolic link`);
    const canonicalRoot = fs.realpathSync(requestedRoot);
    const canonicalParent = fs.realpathSync(path.dirname(requested));
    const canonicalRelative = path.relative(canonicalRoot, path.join(canonicalParent, filename));
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      throw new Error(`${filename} resolves outside the repository root`);
    }
    fd = fs.openSync(requested, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${filename} must be a regular file`);
    if (stat.size > MAX_REPO_CONTROL_FILE_BYTES) {
      throw new Error(`${filename} exceeds ${MAX_REPO_CONTROL_FILE_BYTES} bytes`);
    }
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
