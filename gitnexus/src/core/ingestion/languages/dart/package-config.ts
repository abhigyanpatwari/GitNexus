import type { BigIntStats } from 'node:fs';
import { constants, lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { loadIgnoreRules } from '../../../../config/ignore-service.js';
import { logger } from '../../../logger.js';
import { walkRepositoryPaths } from '../../filesystem-walker.js';
import { getMaxFileSizeBytes } from '../../utils/max-file-size.js';

export interface DartPackageConfig {
  readonly packages: ReadonlyMap<string, string>;
  readonly manifestsByName: ReadonlyMap<string, readonly string[]>;
}

const DART_PUBSPEC_MANIFEST_LIMIT = 20_000;

export interface DartPackageConfigOptions {
  /** Test seam. Production calls use the manifest-count limit. */
  readonly manifestLimit?: number;
}

function warn(reason: string, relativePath: string): void {
  logger.warn(
    { reason, relativePath },
    'Dart pubspec discovery could not read a valid package declaration.',
  );
}

function incomplete(reason: string, relativePath = '.'): never {
  warn(reason, relativePath);
  throw new Error(`Dart pubspec discovery failed (${reason}): ${relativePath}`);
}

function manifestIdentity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

type ManifestRead =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: 'manifest-size' | 'read-pubspec' };

/** Open once, validate and read that descriptor. Null excludes a symbolic link. */
async function readManifestBounded(
  absolute: string,
  maxManifestSize: number,
): Promise<ManifestRead | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    // O_NOFOLLOW rejects leaf symlinks on POSIX. Keep static links excluded,
    // including dangling links, without retrying the pathname open.
    if ((await lstat(absolute).catch(() => null))?.isSymbolicLink()) return null;
    return { ok: false, reason: 'read-pubspec' };
  }
  try {
    const before = await handle.stat({ bigint: true });
    const current = await lstat(absolute, { bigint: true });
    // Also exclude links before reading on platforms without O_NOFOLLOW.
    if (current.isSymbolicLink()) return null;
    if (!before.isFile() || manifestIdentity(before) !== manifestIdentity(current)) {
      return { ok: false, reason: 'read-pubspec' };
    }
    if (before.size > BigInt(maxManifestSize)) return { ok: false, reason: 'manifest-size' };
    const toRead = Math.min(maxManifestSize + 1, Number(before.size) + 1);
    const buffer = Buffer.allocUnsafe(toRead);
    let bytesRead = 0;
    while (bytesRead < toRead) {
      const chunk = await handle.read(buffer, bytesRead, toRead - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maxManifestSize) return { ok: false, reason: 'manifest-size' };
    const after = await handle.stat({ bigint: true });
    if (after.size > BigInt(maxManifestSize)) return { ok: false, reason: 'manifest-size' };
    if (manifestIdentity(after) !== manifestIdentity(before) || after.size !== BigInt(bytesRead)) {
      return { ok: false, reason: 'read-pubspec' };
    }
    return { ok: true, content: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, reason: 'read-pubspec' };
  } finally {
    await handle.close();
  }
}

/** Package identity is a pure function of captured manifest text. */
function packageName(content: string, manifestPath: string): string | null {
  try {
    const manifest: unknown = load(content, { schema: JSON_SCHEMA });
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    const name = (manifest as Record<string, unknown>).name;
    return typeof name === 'string' && /^[a-z_][a-z0-9_]*$/.test(name) ? name : null;
  } catch {
    warn('invalid-yaml', manifestPath);
    return null;
  }
}

/**
 * Capture declarations from the shared scan, before source stat/size filtering.
 * No directory enumeration occurs here. Every enumerated regular manifest must
 * be captured successfully before this config can be published.
 *
 * Acquisition assumes a stable, trusted workspace, like the source-file reader.
 * Static symlinks/junctions are excluded and observed file changes are rejected;
 * these checks do not provide a sandbox or an atomic view of a mutating tree.
 * Once returned, resolution uses only this compact map, on every operating system.
 */
export async function captureDartPackageConfig(
  repoPath: string,
  filePaths: readonly string[],
  options?: DartPackageConfigOptions,
): Promise<DartPackageConfig> {
  const manifests = new Set<string>();
  const limit = options?.manifestLimit ?? DART_PUBSPEC_MANIFEST_LIMIT;
  for (const filePath of filePaths) {
    if (filePath !== 'pubspec.yaml' && !filePath.endsWith('/pubspec.yaml')) continue;
    if (
      /[\\\0]/.test(filePath) ||
      /^[a-zA-Z]:/.test(filePath) ||
      filePath.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      return incomplete('manifest-path');
    }
    manifests.add(filePath);
    if (manifests.size > limit) return incomplete('manifest-limit');
  }
  try {
    await loadIgnoreRules(repoPath, { strictRepoControlFiles: true, noGlobalIgnore: true });
  } catch {
    return incomplete('scan-inputs');
  }
  const packages = new Map<string, string>();
  const manifestsByName = new Map<string, string[]>();
  if (manifests.size === 0) return { packages, manifestsByName };

  // Cache static parent checks once per directory, not once per import/file.
  // This cache belongs only to this capture and never survives another analysis.
  const directories = new Map<string, boolean>();
  const root = await lstat(repoPath).catch(() => null);
  if (root === null || !root.isDirectory() || root.isSymbolicLink()) {
    return incomplete('read-directory');
  }
  const maxManifestSize = Math.min(1024 * 1024, getMaxFileSizeBytes());
  for (const manifestPath of manifests) {
    const parts = manifestPath.split('/');
    let parent = '';
    let linked = false;
    for (const part of parts.slice(0, -1)) {
      parent = parent ? `${parent}/${part}` : part;
      let accepted = directories.get(parent);
      if (accepted === undefined) {
        const info = await lstat(path.join(repoPath, parent)).catch(() => null);
        if (info === null || (!info.isDirectory() && !info.isSymbolicLink())) {
          return incomplete('read-directory', parent);
        }
        accepted = !info.isSymbolicLink();
        directories.set(parent, accepted);
      }
      if (!accepted) {
        linked = true;
        break;
      }
    }
    if (linked) continue;

    const read = await readManifestBounded(path.join(repoPath, manifestPath), maxManifestSize);
    if (read === null) continue;
    if (read.ok === false) return incomplete(read.reason, manifestPath);
    const name = packageName(read.content, manifestPath);
    if (name === null) continue;

    const witnesses = manifestsByName.get(name) ?? [];
    witnesses.push(manifestPath);
    witnesses.sort();
    // Two deterministic witnesses prove ambiguity without duplicate fanout.
    if (witnesses.length > 2) witnesses.length = 2;
    manifestsByName.set(name, witnesses);
    if (witnesses.length > 1) packages.delete(name);
    else packages.set(name, parent ? `${parent}/lib` : 'lib');
  }
  return { packages, manifestsByName };
}

/** Standalone callers use the same scanner/capture boundary as the pipeline. */
export async function loadDartPackageConfig(
  repoPath: string,
  options?: DartPackageConfigOptions,
): Promise<DartPackageConfig> {
  let captured: DartPackageConfig | undefined;
  try {
    await walkRepositoryPaths(repoPath, undefined, {
      onPathsDiscovered: async (paths) => {
        captured = await captureDartPackageConfig(repoPath, paths, options);
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Dart pubspec discovery failed')) {
      throw error;
    }
    return incomplete('scan-inputs');
  }
  return captured ?? incomplete('scan-inputs');
}
