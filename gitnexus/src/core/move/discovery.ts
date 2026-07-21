/**
 * Move project discovery utilities.
 *
 * Cross-platform: uses the `glob` package instead of shelling out to the
 * POSIX-only `find` command, so this works on native Windows.
 */

import { glob } from 'glob';

/**
 * Returns true when the repo contains at least one Move.toml.
 */
export async function repoHasMove(repoPath: string): Promise<boolean> {
  try {
    const matches = await glob(['**/Move.toml'], {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      nodir: true,
      absolute: false,
      dot: false,
    });
    return matches.length > 0;
  } catch {
    return false;
  }
}
