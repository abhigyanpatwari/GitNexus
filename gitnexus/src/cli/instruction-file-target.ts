import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve a selected instruction file to a repo-relative POSIX path.
 *
 * `--instruction-file` (and `.gitnexusrc` `instructionFile`) accepts root
 * `AGENTS.md` / `CLAUDE.md` or any other path inside the repository. Absolute
 * paths, drive-qualified paths, control characters and anything that resolves
 * outside `repoPath` are rejected.
 */
export function resolveInstructionFileTarget(
  repoPath: string,
  instructionFile: string,
): { relative: string; absolute: string } {
  const normalized = instructionFile.replace(/\\/g, '/');
  if (
    !normalized.trim() ||
    normalized !== normalized.trim() ||
    /[\x00-\x1f\x7f]/.test(normalized) ||
    path.isAbsolute(normalized) ||
    path.win32.isAbsolute(instructionFile) ||
    /^[A-Za-z]:/.test(instructionFile)
  ) {
    throw new Error('--instruction-file must be a repo-relative file path.');
  }

  const absolute = path.resolve(repoPath, normalized);
  const relative = path.relative(repoPath, absolute);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('--instruction-file must stay inside the repository.');
  }
  return { relative: relative.replace(/\\/g, '/'), absolute };
}

/** Reject a target whose existing path components include a symlink. */
export async function assertInstructionFileTargetSafe(
  repoPath: string,
  relative: string,
): Promise<void> {
  let current = repoPath;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error('--instruction-file must not use a symlinked path.');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
}
