import { constants, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { createWatchIgnorePredicate } from '../../../../config/ignore-service.js';
import { logger } from '../../../logger.js';
import { getMaxFileSizeBytes } from '../../utils/max-file-size.js';

export interface DartPackageConfig {
  readonly packages: ReadonlyMap<string, string>;
  readonly manifestsByName: ReadonlyMap<string, readonly string[]>;
}

/** An incomplete walk cannot prove package names are unique. */
const DART_PUBSPEC_DIRECTORY_LIMIT = 20_000;

export interface DartPackageConfigOptions {
  /** Test seam. Production calls omit it and use the module directory limit. */
  readonly directoryLimit?: number;
}

type ManifestRead =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: 'manifest-size' | 'read-pubspec' };

/**
 * Read at most `maxManifestSize` bytes from the already-opened inode.
 * `O_NOFOLLOW` refuses a symlink swapped in after `readdir` said this was a file.
 */
async function readManifestBounded(
  entryPath: string,
  maxManifestSize: number,
): Promise<ManifestRead> {
  const flags =
    typeof constants.O_NOFOLLOW === 'number'
      ? constants.O_RDONLY | constants.O_NOFOLLOW
      : constants.O_RDONLY;
  let handle;
  try {
    handle = await open(entryPath, flags);
  } catch {
    return { ok: false, reason: 'read-pubspec' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: 'read-pubspec' };
    if (info.size > maxManifestSize) return { ok: false, reason: 'manifest-size' };
    const toRead = Math.min(maxManifestSize + 1, info.size + 1);
    const buffer = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    if (bytesRead > maxManifestSize) return { ok: false, reason: 'manifest-size' };
    return { ok: true, content: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, reason: 'read-pubspec' };
  } finally {
    await handle.close();
  }
}

/** Discover only in-repository packages; never follow dependency paths or symlinks. */
export async function loadDartPackageConfig(
  repoPath: string,
  options?: DartPackageConfigOptions,
): Promise<DartPackageConfig> {
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
  const directoryLimit = options?.directoryLimit ?? DART_PUBSPEC_DIRECTORY_LIMIT;
  const ambiguous = new Set<string>();
  const pending = [''];
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > directoryLimit) return incomplete('directory-limit');
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
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || isIgnored(entryPath, true)) continue;
        pending.push(relative ? `${relative}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name === 'pubspec.yaml' && !isIgnored(entryPath, false)) {
        const manifestPath = relative ? `${relative}/pubspec.yaml` : 'pubspec.yaml';
        const read = await readManifestBounded(entryPath, maxManifestSize);
        if (read.ok === false) return incomplete(read.reason, manifestPath);
        try {
          const manifest: unknown = load(read.content, {
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
