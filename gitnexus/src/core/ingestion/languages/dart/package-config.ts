import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { createWatchIgnorePredicate } from '../../../../config/ignore-service.js';
import { logger } from '../../../logger.js';
import { getMaxFileSizeBytes } from '../../utils/max-file-size.js';

export interface DartPackageConfig {
  readonly packages: ReadonlyMap<string, string>;
  readonly manifestsByName: ReadonlyMap<string, readonly string[]>;
}

/** Discover only in-repository packages; never follow dependency paths or symlinks. */
export async function loadDartPackageConfig(repoPath: string): Promise<DartPackageConfig> {
  const warn = (reason: string, relativePath = '.'): void => {
    logger.warn(
      { reason, relativePath },
      'Dart pubspec discovery could not read a valid package declaration.',
    );
  };
  const incomplete = (reason: string, relativePath = '.'): never => {
    warn(reason, relativePath);
    throw new Error(`Dart pubspec discovery failed (${reason}): ${relativePath}`);
  };
  let isIgnored;
  try {
    isIgnored = await createWatchIgnorePredicate(repoPath);
  } catch {
    return incomplete('ignore-rules');
  }
  const packages = new Map<string, string>();
  const manifestsByName = new Map<string, string[]>();
  const maxManifestSize = Math.min(1024 * 1024, getMaxFileSizeBytes());
  const ambiguous = new Set<string>();
  const pending = [''];
  let visited = 0;
  while (pending.length > 0) {
    // An incomplete scan cannot establish that package names are unique.
    if (++visited > 20_000) return incomplete('directory-limit');
    const relative = pending.pop();
    if (relative === undefined) break;
    const directory = path.join(repoPath, relative);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return incomplete('read-directory', relative || '.');
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || isIgnored(entryPath, true)) continue;
        pending.push(relative ? `${relative}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name === 'pubspec.yaml' && !isIgnored(entryPath, false)) {
        const manifestPath = relative ? `${relative}/pubspec.yaml` : 'pubspec.yaml';
        let size: number;
        try {
          size = (await stat(entryPath)).size;
        } catch {
          return incomplete('read-pubspec', manifestPath);
        }
        if (size > maxManifestSize) return incomplete('manifest-size', manifestPath);
        let content: string;
        try {
          content = await readFile(entryPath, 'utf8');
        } catch {
          return incomplete('read-pubspec', manifestPath);
        }
        try {
          const manifest: unknown = load(content, {
            schema: JSON_SCHEMA,
          });
          if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))
            continue;
          const name = (manifest as Record<string, unknown>).name;
          if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(name)) continue;
          const manifests = manifestsByName.get(name) ?? [];
          manifests.push(manifestPath);
          // Two deterministic witnesses suffice to prove ambiguity. Retaining
          // more would create unbounded duplicate-package dependency fanout.
          manifests.sort();
          if (manifests.length > 2) manifests.length = 2;
          manifestsByName.set(name, manifests);
          if (packages.has(name) || ambiguous.has(name)) {
            packages.delete(name);
            ambiguous.add(name);
          } else {
            packages.set(name, relative ? `${relative}/lib` : 'lib');
          }
        } catch {
          // Invalid YAML cannot declare a package. Other valid packages remain usable.
          warn('invalid-yaml', manifestPath);
        }
      }
    }
  }
  return { packages, manifestsByName };
}
