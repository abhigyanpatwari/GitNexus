import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ManifestInfo {
  packageName: string;
}

/**
 * Read an npm/yarn package.json and extract the package name.
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

  return { packageName };
}
