/**
 * Atomic file-write primitives shared across storage/ and core/group/.
 *
 * `retryRename` originated in core/group/bridge-db.ts; it lives here so
 * storage/repo-manager.ts can use it without introducing a storage/ ->
 * core/group/ import (the established direction is core/group/ -> storage/,
 * e.g. core/group/service.ts already imports loadMeta from here).
 */
import { closeSync, openSync, promises as fsp, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'crypto';

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Rename with retry on transient EBUSY/EPERM/EACCES (observed on Windows
 * when a concurrent reader holds the target file open).
 */
export async function retryRename(src: string, dst: string, attempts = 3): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fsp.rename(src, dst);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RETRY_CODES.has(code) || i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, i - 1)));
    }
  }
}

/**
 * Atomically publish `data` to `targetPath` via a private tmp file + rename.
 *
 * The tmp name carries a random suffix, so concurrent publishers to one target
 * never stage through the same path. A FIXED `<target>.tmp` is not
 * multi-process safe even though the rename itself is atomic: writer B's write
 * overwrites writer A's staged bytes and B's rename moves that inode away, so
 * A's own rename fails with `ENOENT` (#2888).
 *
 * `'wx'` (O_EXCL) closes the symlink/pre-create race, and the `0o600` mode
 * closes the permissions exposure CodeQL's `js/insecure-temporary-file` query
 * reads off the `mode` argument (it requires the low 6 bits to be zero; with
 * no mode the file lands at umask, typically group/world readable).
 *
 * A rejection anywhere after the tmp exists removes it before rethrowing: with
 * a random suffix a leaked tmp is no longer self-limiting the way a fixed name
 * was (the next writer simply overwrote it), so a recurring failure would drop
 * one more orphan beside the target every time. A hard kill between the open
 * and the rename still leaves one behind.
 *
 * `attempts` is passed through to {@link retryRename}; pass `1` when the
 * caller discards the failure anyway, so a best-effort write cannot spend the
 * retry backoff (and, under a lock, make everyone else wait for it).
 */
export async function writeFileAtomic(
  targetPath: string,
  data: string,
  attempts?: number,
): Promise<void> {
  const tmpPath = tmpBeside(targetPath);
  const handle = await fsp.open(tmpPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(data, 'utf-8');
    } finally {
      await handle.close();
    }
    await retryRename(tmpPath, targetPath, attempts);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function tmpBeside(targetPath: string): string {
  return `${targetPath}.tmp.${randomBytes(8).toString('hex')}`;
}

/**
 * Publish `src` at `dst` without ever writing through the inode currently
 * named by `dst` (#3090). Fast path is `fs.link`. Any failure (EEXIST, EXDEV,
 * EPERM, unsupported hardlinks) copies into a unique sibling and
 * {@link retryRename}s over `dst`. POSIX rename of a file over an existing
 * file unlinks the old name; it does not open or truncate that inode.
 *
 * Invariant: may replace the destination directory entry; must never modify
 * the inode that entry currently references. There is no dest unlink and no
 * in-place `copyFile(src, dst)`.
 */
export async function linkOrCopyFile(src: string, dst: string): Promise<void> {
  try {
    await fsp.link(src, dst);
    return;
  } catch {
    /* any link failure → publish a new inode via tmp + rename */
  }
  const tmp = tmpBeside(dst);
  try {
    await fsp.copyFile(src, tmp);
    await retryRename(tmp, dst);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Binary sibling of {@link writeFileAtomic}. Same random tmp + `'wx'` + `0o600`
 * + rename contract; used for optional V8 cache sidecars that cannot go through
 * a UTF-8 `writeFile`.
 */
export async function writeFileAtomicBytes(
  targetPath: string,
  data: Uint8Array,
  attempts?: number,
): Promise<void> {
  const tmpPath = tmpBeside(targetPath);
  const handle = await fsp.open(tmpPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await retryRename(tmpPath, targetPath, attempts);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Sync binary publish for parse workers. Same exclusive-tmp + mode contract as
 * {@link writeFileAtomicBytes}; rename is not retried (the worker is not the
 * Windows multi-reader case `retryRename` exists for).
 */
export function writeFileAtomicBytesSync(targetPath: string, data: Uint8Array): void {
  const tmpPath = tmpBeside(targetPath);
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    try {
      let offset = 0;
      while (offset < data.byteLength) {
        offset += writeSync(fd, data, offset);
      }
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* leftover tmp is unlinked on the next exclusive create */
    }
    throw err;
  }
}
