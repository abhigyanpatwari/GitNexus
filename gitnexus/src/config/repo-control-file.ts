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
    fd = fs.openSync(requested, 'r');
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${filename} must be a regular file`);
    if (opened.size > MAX_REPO_CONTROL_FILE_BYTES) {
      throw new Error(`${filename} exceeds ${MAX_REPO_CONTROL_FILE_BYTES} bytes`);
    }

    const entry = fs.lstatSync(requested);
    if (entry.isSymbolicLink()) throw new Error(`${filename} must not be a symbolic link`);
    if (!entry.isFile() || entry.dev !== opened.dev || entry.ino !== opened.ino) {
      throw new Error(`${filename} moved or was replaced while being opened`);
    }
    const canonicalRoot = fs.realpathSync(requestedRoot);
    const canonicalFile = fs.realpathSync(requested);
    const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      throw new Error(`${filename} resolves outside the repository root`);
    }
    const canonical = fs.statSync(canonicalFile);
    if (canonical.dev !== opened.dev || canonical.ino !== opened.ino) {
      throw new Error(`${filename} moved or was replaced while being opened`);
    }
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
