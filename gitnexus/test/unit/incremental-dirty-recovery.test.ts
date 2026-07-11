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
// Shared embedding-seed helper (this shipping review, FIX 8) — the KTD9
// zero-vector seeding pattern previously lived here as a divergent copy of
// incremental-orchestration.test.ts's (a helper module has no
// describe-registration problem, unlike importing a sibling test file).
import { seedEmbeddingsForFiles } from '../helpers/embedding-seed.js';

const setupMiniRepo = () => setupSharedMiniRepo('gitnexus-incr-dirty-rec-');

describe('runFullAnalysis — dirty-flag recovery sidecar parking (#2409)', () => {
  it('parks the crashed run WAL/shadow sidecars before reopening, then rebuilds clean', async () => {
    const repo = await setupMiniRepo();
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true }, { onProgress: () => {} });

      // Seed real embeddings BEFORE the tamper (tri-review 4669518496 / U5):
      // with meta.stats.embeddings = 0 the recovery run derived
      // shouldLoadCache=false and never opened the DB pre-wipe — this test
      // was vacuous about the exact open the parking protects. Seeded rows +
      // a stats stamp route the recovery (which runs force:true internally,
      // so forceRegenerate → shouldLoadCache) through the REAL
      // embedding-cache preservation open on the just-parked DB.
      const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
      const seededIdsByFile = await seedEmbeddingsForFiles(
        repo.dbPath,
        ['src/handler.ts', 'src/logger.ts'],
        1,
      );
      const seededNodeIds = [...seededIdsByFile.values()].flat();
      expect(seededNodeIds.length).toBeGreaterThan(0);

      // Simulate a crashed incremental writeback: dirty flag in meta plus
      // leftover sidecars whose bytes must never be replayed. 8KB puts the
      // WAL above the tiny-orphan threshold — the state the sidecar
      // preflight deliberately leaves in place for engine replay.
      const meta = await loadMeta(storagePath);
      const tampered: RepoMeta = {
        ...meta!,
        stats: { ...meta!.stats, embeddings: seededNodeIds.length },
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
      // embeddingsNodeLimit: 1 (KTD9): the recovery runs force:true
      // internally, and the seeded stats would otherwise route Phase 4 into
      // a real embedder in CI — the 1-node cap suppresses generation while
      // leaving the preserve/restore path fully live. On linux the
      // wipe-and-restore vector-index seam then fires for real (statically
      // linked VECTOR): a CREATE_VECTOR_INDEX over the restored rows is
      // expected and harmless here.
      const recovered = await runFullAnalysis(
        repo.dbPath,
        { skipAgentsMd: true, embeddingsNodeLimit: 1 },
        { onProgress: () => {}, onLog: (m) => logs.push(m) },
      );
      expect(recovered.alreadyUpToDate).toBeUndefined();

      // Both sidecars were parked verbatim (renamed, never deleted) before
      // any open could replay them…
      expect(Buffer.compare(await readFile(`${lbugPath}.wal.dirty-recovery`), walGarbage)).toBe(0);
      expect(
        Buffer.compare(await readFile(`${lbugPath}.shadow.dirty-recovery`), shadowGarbage),
      ).toBe(0);
      const joinedLogs = logs.join('\n');
      expect(joinedLogs).toContain('Parked lbug.wal.dirty-recovery, lbug.shadow.dirty-recovery');

      // …the run traversed the REAL pre-wipe preservation open — recovery's
      // internal force on an embedded repo upgrades to regenerate mode, whose
      // banner only prints when existingEmbeddingCount was read from the
      // seeded stats and the cache-load path engaged…
      expect(joinedLogs).toContain(
        `--force on a repo with ${seededNodeIds.length} existing embeddings`,
      );
      // …with generation itself cap-suppressed (no embedder in CI):
      expect(joinedLogs).toContain('exceeds the 1-node safety cap');

      // …and the rebuild completed into a clean index: dirty flag cleared,
      // and the seeded embeddings survived the park → open → wipe → restore
      // round-trip (the strongest signal the preservation open really ran:
      // the DB was wiped, so these rows can only come from the cache load).
      const after = await loadMeta(storagePath);
      expect(after!.incrementalInProgress).toBeUndefined();
      expect(after!.stats?.embeddings).toBe(seededNodeIds.length);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);
});
