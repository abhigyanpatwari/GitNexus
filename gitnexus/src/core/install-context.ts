import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const EPHEMERAL_SEGMENTS = new Set(['_npx', '_cacache']);
const EPHEMERAL_DLX_OWNERS = new Set(['pnpm', 'yarn']);

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasEphemeralMarker(candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => EPHEMERAL_SEGMENTS.has(segment))) return true;
  // `dlx` is only ephemeral next to a package-manager owner (pnpm dlx / yarn
  // dlx). A project directory that happens to be named `dlx` is a normal install.
  if (segments.includes('dlx') && segments.some((segment) => EPHEMERAL_DLX_OWNERS.has(segment))) {
    return true;
  }
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

interface EligibilityProbes {
  realEntry: string;
  env: NodeJS.ProcessEnv;
  /** Resolved npm cache dir, when npm_config_cache is set. */
  realCache: string | null;
  /** Whether the resolved package directory carries a .git checkout marker. */
  packageDirHasGit: boolean;
  /** Resolved npm prefix, when npm_config_prefix is set. */
  realPrefix: string | null;
}

/**
 * Pure classification shared by the async and sync variants. Realpath
 * resolution deliberately makes a linked node_modules entry point at its
 * development checkout, which is therefore ineligible.
 */
function classifyEligibility(probes: EligibilityProbes): boolean {
  const { realEntry, env, realCache, packageDirHasGit, realPrefix } = probes;
  const corroboratingPaths = [
    realEntry,
    env.npm_execpath,
    env.npm_config_cache && path.resolve(env.npm_config_cache),
  ].filter((value): value is string => Boolean(value));
  if (corroboratingPaths.some(hasEphemeralMarker)) return false;

  if (realCache && isInside(realCache, realEntry)) return false;

  const packageDir = findPackageDir(realEntry);
  // Published packages do not carry .git. This also rejects unusual installs
  // copied wholesale from a checkout.
  if (!packageDir || packageDirHasGit) return false;

  if (realPrefix && isInside(realPrefix, realEntry)) return true;

  // A package rooted at node_modules/gitnexus is a persistent project-local
  // install after ephemeral/cache layouts have been excluded above.
  return true;
}

let memoizedAsync: boolean | undefined;
let memoizedSync: boolean | undefined;

/** True only for a persistent npm global or project-local installation. */
export async function updateEligibleInstall(
  entryPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const useMemo = entryPath === undefined && env === process.env;
  if (useMemo && memoizedAsync !== undefined) return memoizedAsync;
  const result = await classifyAsync(entryPath ?? process.argv[1] ?? '', env);
  if (useMemo) memoizedAsync = result;
  return result;
}

async function classifyAsync(entryPath: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!entryPath) return false;
  try {
    const realEntry = await fs.realpath(entryPath);
    const realCache = env.npm_config_cache
      ? await fs
          .realpath(env.npm_config_cache)
          .catch(() => path.resolve(env.npm_config_cache as string))
      : null;
    const packageDir = findPackageDir(realEntry);
    const packageDirHasGit = packageDir
      ? await fs
          .access(path.join(packageDir, '.git'))
          .then(() => true)
          .catch(() => false)
      : false;
    const realPrefix = env.npm_config_prefix
      ? await fs.realpath(env.npm_config_prefix).catch(() => path.resolve(env.npm_config_prefix))
      : null;
    return classifyEligibility({ realEntry, env, realCache, packageDirHasGit, realPrefix });
  } catch {
    return false;
  }
}

/** Synchronous entry-point variant for pre-Commander startup checks. */
export function updateEligibleInstallSync(
  entryPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const useMemo = entryPath === undefined && env === process.env;
  if (useMemo && memoizedSync !== undefined) return memoizedSync;
  const result = classifySync(entryPath ?? process.argv[1] ?? '', env);
  if (useMemo) memoizedSync = result;
  return result;
}

function classifySync(entryPath: string, env: NodeJS.ProcessEnv): boolean {
  if (!entryPath) return false;
  try {
    const realEntry = fsSync.realpathSync(entryPath);
    let realCache: string | null = null;
    if (env.npm_config_cache) {
      try {
        realCache = fsSync.realpathSync(env.npm_config_cache);
      } catch {
        realCache = path.resolve(env.npm_config_cache);
      }
    }
    const packageDir = findPackageDir(realEntry);
    const packageDirHasGit = packageDir ? fsSync.existsSync(path.join(packageDir, '.git')) : false;
    let realPrefix: string | null = null;
    if (env.npm_config_prefix) {
      try {
        realPrefix = fsSync.realpathSync(env.npm_config_prefix);
      } catch {
        realPrefix = path.resolve(env.npm_config_prefix);
      }
    }
    return classifyEligibility({ realEntry, env, realCache, packageDirHasGit, realPrefix });
  } catch {
    return false;
  }
}
