/**
 * Atomic file-write primitives shared across storage/ and core/group/.
 *
 * `retryRename` originated in core/group/bridge-db.ts; it lives here so
 * storage/repo-manager.ts can use it without introducing a storage/ ->
 * core/group/ import (the established direction is core/group/ -> storage/,
 * e.g. core/group/service.ts already imports loadMeta from here).
 */
import fsp from 'fs/promises';
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
 * The tmp name carries a random suffix, so two processes publishing the same
 * target never stage through the same path. A FIXED `<target>.tmp` is not
 * multi-process safe even though the rename itself is atomic: writer B's
 * `writeFile` overwrites writer A's staged bytes and B's `rename` moves that
 * inode away, so A's own rename fails with `ENOENT` — the #2888 crash, which
 * killed the MCP server during startup because nothing catches a registry
 * write rejection there. A cross-process lock narrows that window but cannot
 * close it (`repo-manager`'s registry lock deliberately degrades to unlocked
 * on timeout); a private tmp path closes it whether or not a lock is held.
 *
 * `'wx'` (O_EXCL) closes the symlink/pre-create race, and the explicit `mode`
 * closes the permissions exposure CodeQL's `js/insecure-temporary-file` query
 * reads off the `mode` argument (it requires the low 6 bits to be zero; with
 * no mode the file lands at umask, typically group/world readable).
 * `retryRename` absorbs a transient EBUSY/EPERM/EACCES from a concurrent
 * reader on Windows.
 *
 * Any failure that rejects — a full disk, a read-only home, a rename that
 * retryRename gives up on — removes the tmp file before rethrowing. With a
 * random suffix a leaked tmp is no longer self-limiting the way a fixed name
 * was (the next writer simply overwrote it), so a recurring failure would
 * otherwise deposit one more orphan beside the target every time. A hard kill
 * between the open and the rename still leaves one behind; nothing enumerates
 * these directories, so a stale tmp is inert rather than a correctness problem.
 */
export async function writeFileAtomic(
  targetPath: string,
  data: string,
  mode = 0o600,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${randomBytes(8).toString('hex')}`;
  const handle = await fsp.open(tmpPath, 'wx', mode);
  try {
    try {
      await handle.writeFile(data, 'utf-8');
    } finally {
      await handle.close();
    }
    await retryRename(tmpPath, targetPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}
