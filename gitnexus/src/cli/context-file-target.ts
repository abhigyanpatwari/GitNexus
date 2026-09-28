import fs from 'node:fs/promises';
import path from 'node:path';

export function resolveContextFileTarget(
  repoPath: string,
  contextFile: string,
): { relative: string; absolute: string } {
  const normalized = contextFile.replace(/\\/g, '/');
  if (
    !normalized.trim() ||
    normalized !== normalized.trim() ||
    /[\x00-\x1f\x7f]/.test(normalized) ||
    path.isAbsolute(normalized) ||
    path.win32.isAbsolute(contextFile) ||
    /^[A-Za-z]:/.test(contextFile)
  ) {
    throw new Error('--context-file must be a repo-relative file path.');
  }

  const absolute = path.resolve(repoPath, normalized);
  const relative = path.relative(repoPath, absolute);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('--context-file must stay inside the repository.');
  }
  return { relative: relative.replace(/\\/g, '/'), absolute };
}

export async function assertContextFileTargetSafe(
  repoPath: string,
  relative: string,
): Promise<void> {
  let current = repoPath;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error('--context-file must not use a symlinked path.');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
}
