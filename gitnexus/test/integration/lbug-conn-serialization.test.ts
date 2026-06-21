/**
 * Integration tests: every singleton-`conn` helper reachable during the
 * WAL-checkpoint-driver window must route through `withConnLock` (PR #2264
 * tri-review, P1). These helpers issued raw `conn.query` on the shared
 * connection while the driver could fire a concurrent CHECKPOINT — the same
 * native double-free this branch fixes, on the incremental `--pdg` path.
 *
 * Mirrors `lbug-core-adapter.test.ts`: one isolated temp DB via `withTestLbugDB`.
 * `withConnLock` is mocked to a call-through spy so we can assert each helper
 * acquires the lock while the real serialization still runs. Routing assertions
 * use an empty (initialized) DB — they prove the lock is taken regardless of
 * whether any rows match.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { NODE_TABLES } from '../../src/core/lbug/schema.js';

// Spy `withConnLock` while preserving its real behavior (call-through). The
// adapter imports this module, so the spy observes every lock acquisition.
vi.mock('../../src/core/lbug/conn-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/conn-lock.js')>();
  return {
    ...actual,
    withConnLock: vi.fn(actual.withConnLock) as typeof actual.withConnLock,
  };
});
import { withConnLock } from '../../src/core/lbug/conn-lock.js';
const lockSpy = vi.mocked(withConnLock);

// Spy `closeQueryResults` (call-through) to prove the deleteAll* helpers now
// drain/close their DELETE result, not just the count result (P2 #2264).
vi.mock('../../src/core/lbug/query-result-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/query-result-utils.js')>();
  return {
    ...actual,
    closeQueryResults: vi.fn(actual.closeQueryResults) as typeof actual.closeQueryResults,
  };
});
import { closeQueryResults } from '../../src/core/lbug/query-result-utils.js';
const closeSpy = vi.mocked(closeQueryResults);

withTestLbugDB('conn-serialization', () => {
  describe('singleton-conn helpers acquire withConnLock (P1 #2264)', () => {
    beforeEach(() => {
      // Setup (clear/seed/flush) already exercised the lock; reset so each
      // assertion reflects only the helper under test.
      lockSpy.mockClear();
    });

    it('U1: deleteAllCommunitiesAndProcesses routes through withConnLock', async () => {
      const { deleteAllCommunitiesAndProcesses } =
        await import('../../src/core/lbug/lbug-adapter.js');
      const result = await deleteAllCommunitiesAndProcesses();
      expect(lockSpy).toHaveBeenCalled();
      expect(result).toMatchObject({ nodesDeleted: 0 });
    });

    it('U2: queryImporters routes through withConnLock', async () => {
      const { queryImporters } = await import('../../src/core/lbug/lbug-adapter.js');
      const importers = await queryImporters('any/path.ts');
      expect(lockSpy).toHaveBeenCalled();
      expect(importers).toEqual([]);
    });

    it('U3: deleteNodesForFile (singleton) locks every per-table count query', async () => {
      const { deleteNodesForFile } = await import('../../src/core/lbug/lbug-adapter.js');
      const result = await deleteNodesForFile('any/path.ts');
      // One locked count per filePath-bearing node table (Community/Process are
      // skipped), proving the count read — not just the already-locked DELETE —
      // now serializes. Baseline (count unlocked) would show ~1 lock call.
      const filePathTables = NODE_TABLES.filter((t) => t !== 'Community' && t !== 'Process');
      expect(lockSpy.mock.calls.length).toBeGreaterThanOrEqual(filePathTables.length);
      expect(result).toMatchObject({ deletedNodes: 0 });
    });

    it('closeLbugBeforeExit() checkpoints but leaves the connection open (#2264 close-crash)', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.closeLbugBeforeExit();
      // The native conn/db are deliberately NOT torn down — that avoids LadybugDB's
      // ClientContext destructor double-free after --pdg writes. The connection
      // stays ready and queryable (the CHECKPOINT made the index durable; process
      // exit reclaims the handles on the CLI path).
      expect(adapter.isLbugReady()).toBe(true);
      const rows = await adapter.executeQuery('RETURN 1 AS one');
      expect(rows).toHaveLength(1);
    });

    it('U3: loadCachedEmbeddings routes through withConnLock', async () => {
      const { loadCachedEmbeddings } = await import('../../src/core/lbug/lbug-adapter.js');
      const cached = await loadCachedEmbeddings();
      expect(lockSpy).toHaveBeenCalled();
      expect(cached.embeddings).toEqual([]);
      expect(cached.embeddingNodeIds.size).toBe(0);
    });

    it('U4: deleteAllInterprocTaintPaths routes through withConnLock', async () => {
      const { deleteAllInterprocTaintPaths } = await import('../../src/core/lbug/lbug-adapter.js');
      const result = await deleteAllInterprocTaintPaths();
      expect(lockSpy).toHaveBeenCalled();
      expect(result).toMatchObject({ edgesDeleted: 0 });
    });

    it('U4: deleteAllCallSummaries routes through withConnLock', async () => {
      const { deleteAllCallSummaries } = await import('../../src/core/lbug/lbug-adapter.js');
      const result = await deleteAllCallSummaries();
      expect(lockSpy).toHaveBeenCalled();
      expect(result).toMatchObject({ edgesDeleted: 0 });
    });

    it('U5: deleteNodesForFile on a temp dbPath does NOT take the lock (negative gate)', async () => {
      // The targetConn === conn gate's negative branch: a per-file/temp connection
      // (dbPath provided) must NOT take the singleton lock, so temp-conn callers
      // can't contend with the singleton. Mirrors the positive U3 case above so a
      // regression that unconditionally locks is caught. (#2264)
      const { createTempDir } = await import('../helpers/test-db.js');
      const { deleteNodesForFile } = await import('../../src/core/lbug/lbug-adapter.js');
      const temp = await createTempDir('gn-negative-gate-');
      try {
        lockSpy.mockClear();
        const result = await deleteNodesForFile('any/path.ts', temp.dbPath);
        expect(lockSpy).not.toHaveBeenCalled();
        expect(result).toMatchObject({ deletedNodes: 0 });
      } finally {
        await temp.cleanup();
      }
    });
  });
});

withTestLbugDB(
  'conn-serialization-drain',
  () => {
    describe('deleteAll* drain their DELETE result (P2 #2264)', () => {
      beforeEach(() => {
        closeSpy.mockClear();
      });

      it('U4: deleteAllCommunitiesAndProcesses closes the DETACH DELETE result', async () => {
        const { deleteAllCommunitiesAndProcesses } =
          await import('../../src/core/lbug/lbug-adapter.js');
        const result = await deleteAllCommunitiesAndProcesses();
        // Seed has 1 Community, 0 Process. With the drain fix, closeQueryResults
        // fires for: Community count, Community DETACH DELETE, Process count = 3.
        // Without the fix the delete result is dropped → only 2 closes.
        expect(result).toMatchObject({ nodesDeleted: 1 });
        expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
      });
    });
  },
  {
    seed: [
      "CREATE (c:Community {id: 'comm:drain', label: 'Drain', heuristicLabel: 'Drain', keywords: ['x'], description: 'd', enrichedBy: 'heuristic', cohesion: 0.5, symbolCount: 1})",
    ],
  },
);
