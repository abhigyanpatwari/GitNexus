import fs from 'node:fs/promises';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { closeLbugConnection, openLbugConnection } from './lbug-config.js';
import { closeQueryResults } from './query-result-utils.js';
import { runCheckpointWithRetry } from './wal-checkpoint-driver.js';
import { acquireInitLock } from './lbug-adapter.js';

async function residualSidecars(dbPath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.dirname(dbPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const prefix = `${path.basename(dbPath)}.`;
  return entries.filter((name) => {
    if (!name.startsWith(prefix)) return false;
    const suffix = name.slice(prefix.length);
    // Dirty recovery deliberately retains these completed forensic archives.
    // They cannot be replayed by the engine. Incomplete `.next` parks and all
    // other recovery residues still require intervention before publication.
    if (suffix === 'wal.dirty-recovery' || suffix === 'shadow.dirty-recovery') return false;
    return /^(wal|shadow|checkpoint)(?:\.|$)/.test(suffix);
  });
}

/** A publication receipt must describe one consolidated file, including on 9p
 * where a renamed, held-open sidecar can be listed while stat returns ENOENT. */
export async function assertLbugPublicationReady(dbPath: string): Promise<void> {
  let residual = await residualSidecars(dbPath);
  for (const delay of [25, 50, 100]) {
    if (residual.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
    residual = await residualSidecars(dbPath);
  }
  if (residual.length > 0) {
    throw new Error(
      `Cannot publish index at ${dbPath}: residual recovery files require consolidation: ${residual.join(', ')}.`,
    );
  }
}

/** Recover the live family before building its replacement. Do not park or
 * unlink its delta: a later failed publication must still serve all old rows.
 * This raw handle performs recovery only, without schema or extension writes. */
export async function consolidateLbugForPublication(dbPath: string): Promise<void> {
  if ((await residualSidecars(dbPath)).length === 0) return;
  const releaseInitLock = await acquireInitLock(dbPath);
  try {
    // A missing-shadow quarantine cannot be replayed. Refuse before even a
    // read-triggered recovery/checkpoint can change the retained main file.
    const quarantinePrefix = `${path.basename(dbPath)}.wal.missing-shadow.`;
    if ((await residualSidecars(dbPath)).some((name) => name.startsWith(quarantinePrefix))) {
      throw new Error('Quarantined WAL requires recovery with its missing shadow file.');
    }
    const handle = await openLbugConnection(lbug, dbPath, { throwOnWalReplayFailure: true });
    const query = async (cypher: string): Promise<void> => {
      const result = await handle.conn.query(cypher);
      try {
        for (const cursor of Array.isArray(result) ? result : [result]) await cursor.getAll();
      } finally {
        await closeQueryResults(result);
      }
    };
    try {
      // A lazy writable open can defer WAL replay until its first graph read.
      // determinism: probe — rows are drained and discarded; only successful WAL replay matters.
      await query('MATCH (n) RETURN n LIMIT 1');
      const receipt = await runCheckpointWithRetry({
        checkpointFn: async () => {
          await query('CHECKPOINT');
          return true;
        },
      });
      if (!receipt.flushed)
        throw new Error(`Live index checkpoint could not be verified: ${dbPath}`);
    } finally {
      await closeLbugConnection(handle);
    }
    await assertLbugPublicationReady(dbPath);
  } catch (cause) {
    throw new Error(
      `Cannot consolidate the previous index at ${dbPath}; publication was stopped to preserve its recovery files. ` +
        'Inspect or back up that database family before using gitnexus clean --lbug-sidecars to discard unrecoverable deltas.',
      { cause },
    );
  } finally {
    await releaseInitLock();
  }
}
