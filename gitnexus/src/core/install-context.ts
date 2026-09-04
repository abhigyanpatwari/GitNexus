import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const EPHEMERAL_SEGMENTS = new Set(['_npx', '_cacache', 'dlx']);

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasEphemeralMarker(candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => EPHEMERAL_SEGMENTS.has(segment))) return true;
  return normalized.includes('/.bun/install/cache/') || normalized.includes('/bun/install/cache/');
}

function findPackageDir(entryPath: string): string | null {
  let current = path.dirname(path.resolve(entryPath));
  for (;;) {
    if (
      path.basename(current) === 'gitnexus' &&
      path.basename(path.dirname(current)) === 'node_modules'
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * True only for a persistent npm global or project-local installation.
 *
 * Realpath resolution deliberately makes a linked node_modules entry point at
 * its development checkout, which is therefore ineligible.
 */
export async function updateEligibleInstall(
  entryPath = process.argv[1] ?? '',
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!entryPath) return false;
  try {
    const realEntry = await fs.realpath(entryPath);
    const corroboratingPaths = [
      realEntry,
      env.npm_execpath,
      env.npm_config_cache && path.resolve(env.npm_config_cache),
    ].filter((value): value is string => Boolean(value));
    if (corroboratingPaths.some(hasEphemeralMarker)) return false;

    if (env.npm_config_cache) {
      const realCache = await fs
        .realpath(env.npm_config_cache)
        .catch(() => path.resolve(env.npm_config_cache as string));
      if (isInside(realCache, realEntry)) return false;
    }

    const packageDir = findPackageDir(realEntry);
    if (!packageDir) return false;

    // Published packages do not carry .git. This also rejects unusual installs
    // copied wholesale from a checkout.
    if (
      await fs
        .access(path.join(packageDir, '.git'))
        .then(() => true)
        .catch(() => false)
    ) {
      return false;
    }

    const prefix = env.npm_config_prefix;
    if (prefix) {
      const realPrefix = await fs.realpath(prefix).catch(() => path.resolve(prefix));
      if (isInside(realPrefix, realEntry)) return true;
    }

    // A package rooted at node_modules/gitnexus is a persistent project-local
    // install after ephemeral/cache layouts have been excluded above.
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous entry-point variant for pre-Commander startup checks.
 *
 * It intentionally mirrors updateEligibleInstall: the CLI cannot await
 * filesystem classification before parsing every command.
 */
export function updateEligibleInstallSync(
  entryPath = process.argv[1] ?? '',
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!entryPath) return false;
  try {
    const realEntry = fsSync.realpathSync(entryPath);
    const corroboratingPaths = [
      realEntry,
      env.npm_execpath,
      env.npm_config_cache && path.resolve(env.npm_config_cache),
    ].filter((value): value is string => Boolean(value));
    if (corroboratingPaths.some(hasEphemeralMarker)) return false;

    if (env.npm_config_cache) {
      let realCache: string;
      try {
        realCache = fsSync.realpathSync(env.npm_config_cache);
      } catch {
        realCache = path.resolve(env.npm_config_cache);
      }
      if (isInside(realCache, realEntry)) return false;
    }

    const packageDir = findPackageDir(realEntry);
    if (!packageDir || fsSync.existsSync(path.join(packageDir, '.git'))) return false;

    const prefix = env.npm_config_prefix;
    if (prefix) {
      let realPrefix: string;
      try {
        realPrefix = fsSync.realpathSync(prefix);
      } catch {
        realPrefix = path.resolve(prefix);
      }
      if (isInside(realPrefix, realEntry)) return true;
    }

    return true;
  } catch {
    return false;
  }
}
