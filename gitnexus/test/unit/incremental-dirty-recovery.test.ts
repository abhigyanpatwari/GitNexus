/**
 * #2409 defect 2 — dirty-flag recovery must park the crashed run's
 * WAL/shadow sidecars BEFORE any DB open.
 *
 * The recovery rebuild used to open the crashed DB (embedding-cache
 * preservation) before the rebuild wipe — replaying whatever WAL the
 * crashed writeback left behind. A poisoned WAL kills that open natively,
 * so recovery never ran and only a manual rename-aside of the index dir
 * escaped the loop.
 *
 * Split out of incremental-orchestration.test.ts so the cross-platform CI
 * matrix (scripts/cross-platform-tests.ts) can run it on windows-latest
 * without paying for the whole orchestration suite: the behaviors under
 * test — sidecar renames next to a live native DB, rename-onto-existing
 * (rm-first) parking, and the wipe of the sidecar family — are exactly the
 * ones with Windows-specific filesystem semantics (file-lock lag, rename
 * over existing targets), and the reporting environment for #2409 is
 * Windows.
 */

import { writeFile, readFile } from 'fs/promises';
import { describe, it, expect } from 'vitest';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { setupMiniRepo as setupSharedMiniRepo } from '../helpers/mini-repo.js';

const setupMiniRepo = () => setupSharedMiniRepo('gitnexus-incr-dirty-rec-');

describe('runFullAnalysis — dirty-flag recovery sidecar parking (#2409)', () => {
  it('parks the crashed run WAL/shadow sidecars before reopening, then rebuilds clean', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // Simulate a crashed incremental writeback: dirty flag in meta plus
      // leftover sidecars whose bytes must never be replayed. 8KB puts the
      // WAL above the tiny-orphan threshold — the state the sidecar
      // preflight deliberately leaves in place for engine replay.
      const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      const tampered: RepoMeta = {
        ...meta!,
        incrementalInProgress: {
          startedAt: Date.now() - 60_000,
          toWriteCount: 12,
          phase: 'load-graph',
        },
      };
      await saveMeta(storagePath, tampered);
      const walGarbage = Buffer.alloc(8192, 0xab);
      const shadowGarbage = Buffer.alloc(4096, 0xcd);
      await writeFile(`${lbugPath}.wal`, walGarbage);
      await writeFile(`${lbugPath}.shadow`, shadowGarbage);

      const logs: string[] = [];
      const recovered = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true },
        { onProgress: () => {}, onLog: (m) => logs.push(m) },
      );
      expect(recovered.alreadyUpToDate).toBeUndefined();

      // Both sidecars were parked verbatim (renamed, never deleted) before
      // any open could replay them…
      expect(Buffer.compare(await readFile(`${lbugPath}.wal.dirty-recovery`), walGarbage)).toBe(0);
      expect(
        Buffer.compare(await readFile(`${lbugPath}.shadow.dirty-recovery`), shadowGarbage),
      ).toBe(0);
      expect(logs.join('\n')).toContain(
        'Parked lbug.wal.dirty-recovery, lbug.shadow.dirty-recovery',
      );

      // …and the rebuild completed into a clean index: dirty flag cleared.
      const after = await loadMeta(storagePath);
      expect(after!.incrementalInProgress).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  }, 300_000);
});
