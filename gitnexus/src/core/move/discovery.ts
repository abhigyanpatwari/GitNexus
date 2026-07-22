/**
 * Move project discovery utilities.
 *
 * Cross-platform: uses the `glob` package instead of shelling out to the
 * POSIX-only `find` command, so this works on native Windows.
 */

import { globIterate } from 'glob';

/**
 * Returns true when the repo contains at least one Move.toml.
 */
export async function repoHasMove(repoPath: string): Promise<boolean> {
  for await (const _match of globIterate(['**/Move.toml'], {
    cwd: repoPath,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    nodir: true,
    absolute: false,
    dot: false,
  })) {
    return true;
  }
  return false;
}
