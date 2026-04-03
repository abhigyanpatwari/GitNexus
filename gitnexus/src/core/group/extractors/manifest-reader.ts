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
