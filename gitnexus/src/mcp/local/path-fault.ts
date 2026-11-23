import fs from 'node:fs/promises';

/**
 * Whether `error` is a missing path under `root` while `root` itself is still
 * a directory, so the path is the caller's rather than a checkout that is gone
 * or no longer a directory.
 */
export async function missingUnderLiveRoot(error: unknown, root: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
  const stat = await fs.stat(root).catch(() => undefined);
  return stat?.isDirectory() === true;
}
