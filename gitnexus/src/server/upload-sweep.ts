/**
 * Backstop cleanup for abandoned upload staging directories.
 *
 * A crashed/killed process can leave a `.staging-*` directory under
 * UPLOAD_ROOT (the normal path removes it on success/failure/abort). This
 * sweep, run once at server startup, removes staging dirs older than a
 * threshold. Stale promoted upload directories that are no longer registered
 * are also removed. Registered promoted dirs stay (DELETE /api/repo).
 */

import path from 'path';
import fsp from 'node:fs/promises';
import { UPLOAD_ROOT, STAGING_PREFIX } from './upload-paths.js';
import {
  canonicalizePath,
  readRegistryStrictIfPresent,
  registryPathEquals,
} from '../storage/repo-manager.js';

export interface SweepOptions {
  /** Remove staging dirs older than this (default 6h). */
  maxAgeMs?: number;
  /** Override the root to sweep (defaults to UPLOAD_ROOT; for tests). */
  root?: string;
  /** Clock injection for tests. */
  now?: number;
}

const removeSweptDir = async (full: string, removed: string[]): Promise<void> => {
  try {
    await fsp.rm(full, { recursive: true, force: true });
    removed.push(full);
  } catch {
    /* Permission or transient errors leave the path unlisted. */
  }
};

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

  const stalePromotedDirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try {
      const st = await fsp.stat(full);
      if (now - st.mtimeMs <= maxAgeMs) continue; // recent — keep

      if (entry.name.startsWith(STAGING_PREFIX)) {
        // Transient staging dir orphaned by a crash — always removable.
        await removeSweptDir(full, removed);
      } else {
        stalePromotedDirs.push(full);
      }
    } catch {
      /* stat race — skip */
    }
  }

  // Promoted upload directories are source repositories. Their persistence is
  // determined by registry membership, not by whether their index currently
  // happens to be materialized or where that index is stored. Registry failure
  // must never turn into deletion; staging cleanup above remains independent.
  //
  // A missing registry.json is first-run emptiness in readRegistryStrict.
  // That must not be treated as "nothing is registered" here — we cannot
  // prove a promoted dir is unregistered when the file is absent.
  let registeredPaths: string[];
  try {
    const entries = await readRegistryStrictIfPresent();
    if (entries === undefined) return { removed };
    registeredPaths = entries
      .filter((entry) => typeof entry.path === 'string' && entry.path.trim().length > 0)
      .map((entry) => canonicalizePath(entry.path));
  } catch {
    return { removed };
  }

  for (const full of stalePromotedDirs) {
    const canonical = canonicalizePath(full);
    const isRegistered = registeredPaths.some((registeredPath) =>
      registryPathEquals(registeredPath, canonical),
    );
    if (!isRegistered) {
      await removeSweptDir(full, removed);
    }
  }

  return { removed };
}
