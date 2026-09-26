import type { BigIntStats, Dirent } from 'node:fs';
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

/**
 * Directory descriptors one walk may hold at once. The visit budget is far
 * above a process file-descriptor limit, so a deep chain is refused before
 * the next open instead of failing later with EMFILE.
 */
const DART_PUBSPEC_OPEN_DIRECTORY_LIMIT = 64;

export interface DartPackageConfigOptions {
  /** Test seam. Production calls omit it and use the module directory limit. */
  readonly directoryLimit?: number;
  /** Test seam. Production calls omit it and use the open-directory cap. */
  readonly directoryDepthLimit?: number;
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
 * Read at most `maxManifestSize` bytes from a descriptor already opened
 * with `O_NOFOLLOW`. The caller closes nothing; this function owns `handle`.
 */
async function readManifestBounded(
  handle: FileHandle,
  maxManifestSize: number,
): Promise<ManifestRead> {
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

function requireNoFollowFlag(): number {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw Object.assign(new Error('O_NOFOLLOW is unavailable'), { code: 'ENOTSUP' });
  }
  return noFollow;
}

/** Linux anchors child opens. macOS verifies them. Every other platform does neither. */
export function pubspecWalkAnchored(): boolean {
  const noFollow = constants.O_NOFOLLOW;
  return (
    (process.platform === 'linux' || process.platform === 'darwin') &&
    typeof noFollow === 'number' &&
    noFollow !== 0
  );
}

export function directoryOpenFlags(): number {
  let flags = constants.O_RDONLY | requireNoFollowFlag();
  if (typeof constants.O_DIRECTORY === 'number') flags |= constants.O_DIRECTORY;
  return flags;
}

/**
 * Read-only, no-follow, and non-blocking. `O_NONBLOCK` does not change a
 * regular-file read. Without it, a FIFO blocks inside `open` until a writer
 * connects, so the later file-type check never runs.
 */
function fileOpenFlags(): number {
  const nonBlock = constants.O_NONBLOCK;
  if (typeof nonBlock !== 'number' || nonBlock === 0) {
    throw Object.assign(new Error('O_NONBLOCK is unavailable'), { code: 'ENOTSUP' });
  }
  return constants.O_RDONLY | requireNoFollowFlag() | nonBlock;
}

function directoryIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}`;
}

/**
 * Path that lists the directory inode already open on `fd`.
 * Linux uses `/proc/self/fd/N` and macOS uses `/dev/fd/N`.
 * Other platforms have no such path; callers refuse instead of listing by name.
 */
export function descriptorDirectoryPath(fd: number): string | null {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`;
  if (process.platform === 'darwin') return `/dev/fd/${fd}`;
  return null;
}

/**
 * One entry of the directory inode open on `fd`.
 * Linux looks up `/proc/self/fd/N/<name>` in that inode. macOS `/dev/fd/N/<name>`
 * does not resolve a child, so this returns null and the walker verifies the
 * pinned parent chain instead. Every other platform returns null and is not walked.
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

interface OpenedDirectory {
  readonly handle: FileHandle;
  readonly identity: string;
}

async function openVerifiedDirectory(directory: string): Promise<OpenedDirectory> {
  const handle = await open(directory, directoryOpenFlags());
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isDirectory()) {
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    }
    return { handle, identity: directoryIdentity(info) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

interface WalkFrame {
  relative: string;
  absolute: string;
  handle: FileHandle;
  identity: string;
  entries: Dirent[];
  next: number;
}

/** Re-stat each pinned directory and its path. A replaced inode or a symlink fails the walk. */
async function assertPinnedChain(frames: readonly WalkFrame[]): Promise<void> {
  for (const frame of frames) {
    const pinned = await frame.handle.stat({ bigint: true });
    if (!pinned.isDirectory() || directoryIdentity(pinned) !== frame.identity) {
      throw Object.assign(new Error('parent descriptor changed'), { code: 'ELOOP' });
    }
    let lexical: BigIntStats;
    try {
      lexical = await lstat(frame.absolute, { bigint: true });
    } catch {
      throw Object.assign(new Error('parent path changed'), { code: 'ELOOP' });
    }
    if (
      lexical.isSymbolicLink() ||
      !lexical.isDirectory() ||
      directoryIdentity(lexical) !== frame.identity
    ) {
      throw Object.assign(new Error('parent path changed'), { code: 'ELOOP' });
    }
  }
}

/**
 * macOS has no descriptor-relative child lookup. Re-check the pinned parents,
 * open the child with O_NOFOLLOW, then re-check the parents. The opened
 * descriptor is the only child metadata consulted.
 */
async function openLexicalDirectory(
  frames: readonly WalkFrame[],
  lexicalPath: string,
): Promise<OpenedDirectory> {
  await assertPinnedChain(frames);
  const opened = await openVerifiedDirectory(lexicalPath);
  try {
    await assertPinnedChain(frames);
    return opened;
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

async function openLexicalFile(
  frames: readonly WalkFrame[],
  lexicalPath: string,
): Promise<FileHandle> {
  await assertPinnedChain(frames);
  const handle = await open(lexicalPath, fileOpenFlags());
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw Object.assign(new Error('not a file'), { code: 'ELOOP' });
    }
    await assertPinnedChain(frames);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openChildDirectory(
  frames: readonly WalkFrame[],
  parentFd: number,
  name: string,
  lexicalPath: string,
): Promise<OpenedDirectory> {
  const anchored = descriptorEntryPath(parentFd, name);
  if (anchored !== null) return openVerifiedDirectory(anchored);
  if (process.platform === 'darwin') return openLexicalDirectory(frames, lexicalPath);
  throw Object.assign(new Error('no descriptor anchor'), { code: 'ENOTSUP' });
}

async function openChildFile(
  frames: readonly WalkFrame[],
  parentFd: number,
  name: string,
  lexicalPath: string,
): Promise<FileHandle> {
  const anchored = descriptorEntryPath(parentFd, name);
  if (anchored !== null) return open(anchored, fileOpenFlags());
  if (process.platform === 'darwin') return openLexicalFile(frames, lexicalPath);
  throw Object.assign(new Error('no descriptor anchor'), { code: 'ENOTSUP' });
}

async function listOpenedDirectory(handle: FileHandle): Promise<Dirent[]> {
  const listing = descriptorDirectoryPath(handle.fd);
  if (listing === null) {
    throw Object.assign(new Error('no descriptor listing'), { code: 'ENOTSUP' });
  }
  return await readdir(listing, { withFileTypes: true });
}

/**
 * Open `directory` without following a final symlink, then list that inode.
 * A path swapped for a symlink after the parent listing fails this open
 * (`ENOTDIR` / `ELOOP`) instead of being traversed.
 */
export async function readDirectoryNoFollow(directory: string): Promise<Dirent[]> {
  const opened = await openVerifiedDirectory(directory);
  try {
    return await listOpenedDirectory(opened.handle);
  } finally {
    await opened.handle.close();
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
  if (!pubspecWalkAnchored()) {
    warn('nofollow-anchor');
    return { packages: new Map(), manifestsByName: new Map() };
  }
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
  const directoryDepthLimit = options?.directoryDepthLimit ?? DART_PUBSPEC_OPEN_DIRECTORY_LIMIT;
  const ambiguous = new Set<string>();
  const stack: WalkFrame[] = [];
  let visited = 0;

  const closeStack = async (): Promise<void> => {
    const frames = stack.splice(0);
    await Promise.all(frames.map((frame) => frame.handle.close().catch(() => undefined)));
  };

  const fillFrame = async (frame: WalkFrame): Promise<void> => {
    if (++visited > directoryLimit) return incomplete('directory-limit', frame.relative || '.');
    try {
      frame.entries = await listOpenedDirectory(frame.handle);
    } catch {
      return incomplete('read-directory', frame.relative || '.');
    }
    if (options?.beforeEntryOpen) await options.beforeEntryOpen(frame.relative);
  };

  try {
    let rootOpened: OpenedDirectory;
    try {
      rootOpened = await openVerifiedDirectory(repoPath);
    } catch {
      return incomplete('read-directory', '.');
    }
    const root: WalkFrame = {
      relative: '',
      absolute: repoPath,
      handle: rootOpened.handle,
      identity: rootOpened.identity,
      entries: [],
      next: 0,
    };
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
        if (stack.length >= directoryDepthLimit) {
          return incomplete('directory-depth', childRelative);
        }
        let childOpened: OpenedDirectory;
        try {
          childOpened = await openChildDirectory(stack, frame.handle.fd, entry.name, entryPath);
        } catch {
          return incomplete('read-directory', childRelative);
        }
        const child: WalkFrame = {
          relative: childRelative,
          absolute: entryPath,
          handle: childOpened.handle,
          identity: childOpened.identity,
          entries: [],
          next: 0,
        };
        stack.push(child);
        await fillFrame(child);
      } else if (entry.isFile() && entry.name === 'pubspec.yaml' && !isIgnored(entryPath, false)) {
        const manifestPath = frame.relative ? `${frame.relative}/pubspec.yaml` : 'pubspec.yaml';
        let manifestHandle: FileHandle;
        try {
          manifestHandle = await openChildFile(stack, frame.handle.fd, entry.name, entryPath);
        } catch {
          return incomplete('read-pubspec', manifestPath);
        }
        const read = await readManifestBounded(manifestHandle, maxManifestSize);
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
