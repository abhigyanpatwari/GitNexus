/**
 * Backstop cleanup for abandoned upload staging directories.
 *
 * A crashed/killed process can leave a `.staging-*` directory under
 * UPLOAD_ROOT (the normal path removes it on success/failure/abort). This
 * sweep, run once at server startup, removes staging dirs older than a
 * threshold. Promoted upload dirs are persistent registered repos (like
 * clones) and are NOT touched here — they are removed via DELETE /api/repo.
 */

import path from 'path';
import fsp from 'fs/promises';
import { UPLOAD_ROOT, STAGING_PREFIX } from './upload-paths.js';

export interface SweepOptions {
  /** Remove staging dirs older than this (default 6h). */
  maxAgeMs?: number;
  /** Override the root to sweep (defaults to UPLOAD_ROOT; for tests). */
  root?: string;
  /** Clock injection for tests. */
  now?: number;
}

export async function sweepStaleUploads(opts: SweepOptions = {}): Promise<{ removed: string[] }> {
  const maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const root = opts.root ?? UPLOAD_ROOT;
  const now = opts.now ?? Date.now();
  const removed: string[] = [];

  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return { removed }; // root does not exist yet — nothing to sweep
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try {
      const st = await fsp.stat(full);
      if (now - st.mtimeMs <= maxAgeMs) continue; // recent — keep

      if (entry.name.startsWith(STAGING_PREFIX)) {
        // Transient staging dir orphaned by a crash — always removable.
        await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
        removed.push(full);
      } else {
        // Promoted upload dir. A successfully-analyzed (registered) repo always
        // has a `.gitnexus` index inside it; a stale promoted dir WITHOUT one is
        // an orphan from an analysis that failed before registering — remove it.
        const hasIndex = await fsp
          .access(path.join(full, '.gitnexus'))
          .then(() => true)
          .catch(() => false);
        if (!hasIndex) {
          await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
          removed.push(full);
        }
      }
    } catch {
      /* stat race — skip */
    }
  }

  return { removed };
}
