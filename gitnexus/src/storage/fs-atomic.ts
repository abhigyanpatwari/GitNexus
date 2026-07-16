/**
 * Atomic file-write primitives shared across storage/ and core/group/.
 *
 * `retryRename` originated in core/group/bridge-db.ts; it lives here so
 * storage/repo-manager.ts can use it without introducing a storage/ ->
 * core/group/ import (the established direction is core/group/ -> storage/,
 * e.g. core/group/service.ts already imports loadMeta from here).
 */
import fsp from 'fs/promises';

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
