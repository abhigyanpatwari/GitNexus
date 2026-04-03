import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ManifestInfo {
  packageName: string;
  dependencies: string[];
}

/**
 * Read an npm/yarn package.json and extract the package name and dependency names.
 * Returns null if no package.json exists or if it has no name field.
 */
export function readNpmManifest(repoPath: string): ManifestInfo | null {
  const pkgPath = path.join(repoPath, 'package.json');
  let content: string;
  try {
    content = fs.readFileSync(pkgPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  const packageName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!packageName) return null;

  const deps = new Set<string>();

  const depFields = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
  for (const field of depFields) {
    const section = parsed[field];
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      for (const key of Object.keys(section as Record<string, unknown>)) {
        deps.add(key);
      }
    }
  }

  return {
    packageName,
    dependencies: [...deps],
  };
}

/**
 * Build a package map from a set of repos: maps npm package name → group path.
 * Only includes repos that have a valid package.json with a name field.
 */
export function buildPackageMap(
  repos: Record<string, string>,
  resolveRepoPath: (registryName: string) => string | null,
): Map<string, string> {
  const packageMap = new Map<string, string>();

  for (const [groupPath, registryName] of Object.entries(repos)) {
    const repoPath = resolveRepoPath(registryName);
    if (!repoPath) continue;

    const manifest = readNpmManifest(repoPath);
    if (manifest) {
      packageMap.set(manifest.packageName, groupPath);
    }
  }

  return packageMap;
}

/**
 * Find which sibling packages a repo depends on.
 * Returns the subset of packageMap keys that appear in this repo's dependencies.
 */
export function findSiblingDependencies(
  repoPath: string,
  packageMap: Map<string, string>,
): string[] {
  const manifest = readNpmManifest(repoPath);
  if (!manifest) return [];

  return manifest.dependencies.filter((dep) => packageMap.has(dep));
}
