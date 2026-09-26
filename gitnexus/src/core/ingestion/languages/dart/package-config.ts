import type { Dirent } from 'node:fs';
import { constants, lstat, open, readdir, type FileHandle } from 'node:fs/promises';
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
  /**
   * Test seam. Production calls omit it. Invoked after the directory inode
   * is listed and before its entries are opened.
   */
  readonly beforeEntryOpen?: (relativePath: string) => void | Promise<void>;
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
    if (typeof constants.O_NOFOLLOW !== 'number' && (await lstat(entryPath)).isSymbolicLink()) {
      return { ok: false, reason: 'read-pubspec' };
    }
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

export function directoryOpenFlags(): number {
  let flags = constants.O_RDONLY;
  if (typeof constants.O_DIRECTORY === 'number') flags |= constants.O_DIRECTORY;
  if (typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW;
  return flags;
}

/**
 * Path that lists the directory inode already open on `fd`.
 * Linux and macOS can readdir that inode. Windows has no such path in Node,
 * so the caller lists the original path while the no-follow handle is held.
 */
export function descriptorDirectoryPath(fd: number): string | null {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`;
  if (process.platform === 'darwin') return `/dev/fd/${fd}`;
  return null;
}

/**
 * One entry of the directory inode open on `fd`.
 * Linux looks up `/proc/self/fd/N/<name>` in that inode. This walker has no
 * child path for macOS or Windows, so those platforms reopen the original path.
 */
export function descriptorEntryPath(fd: number, name: string): string | null {
  if (process.platform !== 'linux') return null;
  if (!isSingleDirectoryEntry(name)) return null;
  return `/proc/self/fd/${fd}/${name}`;
}

function isSingleDirectoryEntry(name: string): boolean {
  return (
    name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
  );
}

async function openVerifiedDirectory(directory: string): Promise<FileHandle> {
  // Windows has no O_NOFOLLOW; reject an existing junction before opening it.
  if (typeof constants.O_NOFOLLOW !== 'number' && (await lstat(directory)).isSymbolicLink()) {
    throw Object.assign(new Error('directory symlink'), { code: 'ELOOP' });
  }
  const handle = await open(directory, directoryOpenFlags());
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function listOpenedDirectory(handle: FileHandle, directory: string): Promise<Dirent[]> {
  const listing = descriptorDirectoryPath(handle.fd);
  if (listing !== null) return await readdir(listing, { withFileTypes: true });
  return await readdir(directory, { withFileTypes: true });
}

/**
 * Open `directory` without following a final symlink, then list that inode.
 * A path swapped for a symlink after the parent listing fails this open
 * (`ENOTDIR` / `ELOOP`) instead of being traversed.
 */
export async function readDirectoryNoFollow(directory: string): Promise<Dirent[]> {
  const handle = await openVerifiedDirectory(directory);
  try {
    return await listOpenedDirectory(handle, directory);
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
  type WalkFrame = {
    relative: string;
    handle: FileHandle;
    entries: Dirent[];
    next: number;
  };
  const stack: WalkFrame[] = [];
  let visited = 0;

  const closeStack = async (): Promise<void> => {
    const frames = stack.splice(0);
    await Promise.all(frames.map((frame) => frame.handle.close().catch(() => undefined)));
  };

  const fillFrame = async (frame: WalkFrame): Promise<void> => {
    if (++visited > directoryLimit) return incomplete('directory-limit', frame.relative || '.');
    const directory = path.join(repoPath, frame.relative);
    try {
      frame.entries = await listOpenedDirectory(frame.handle, directory);
    } catch {
      return incomplete('read-directory', frame.relative || '.');
    }
    if (options?.beforeEntryOpen) await options.beforeEntryOpen(frame.relative);
  };

  try {
    let rootHandle: FileHandle;
    try {
      rootHandle = await openVerifiedDirectory(repoPath);
    } catch {
      return incomplete('read-directory', '.');
    }
    const root: WalkFrame = { relative: '', handle: rootHandle, entries: [], next: 0 };
    stack.push(root);
    await fillFrame(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      if (frame.next >= frame.entries.length) {
        stack.pop();
        await frame.handle.close().catch(() => undefined);
        continue;
      }
      const entry = frame.entries[frame.next];
      frame.next += 1;
      if (entry === undefined || !isSingleDirectoryEntry(entry.name) || entry.isSymbolicLink()) {
        continue;
      }
      const childRelative = frame.relative ? `${frame.relative}/${entry.name}` : entry.name;
      const entryPath = path.join(repoPath, childRelative);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || isIgnored(entryPath, true)) continue;
        const openedVia = descriptorEntryPath(frame.handle.fd, entry.name);
        let childHandle: FileHandle;
        try {
          childHandle = await openVerifiedDirectory(openedVia ?? entryPath);
        } catch {
          return incomplete('read-directory', childRelative);
        }
        const child: WalkFrame = {
          relative: childRelative,
          handle: childHandle,
          entries: [],
          next: 0,
        };
        stack.push(child);
        await fillFrame(child);
      } else if (entry.isFile() && entry.name === 'pubspec.yaml' && !isIgnored(entryPath, false)) {
        const manifestPath = frame.relative ? `${frame.relative}/pubspec.yaml` : 'pubspec.yaml';
        const openedVia = descriptorEntryPath(frame.handle.fd, entry.name);
        const read = await readManifestBounded(openedVia ?? entryPath, maxManifestSize);
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
            packages.set(name, frame.relative ? `${frame.relative}/lib` : 'lib');
          }
        } catch {
          // Invalid YAML cannot declare a package. Other valid packages remain usable.
          warn('invalid-yaml', manifestPath);
        }
      }
    }
  } finally {
    await closeStack();
  }
  return { packages, manifestsByName };
}
