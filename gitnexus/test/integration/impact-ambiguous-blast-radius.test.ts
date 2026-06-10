/**
 * Integration test: impact() ambiguous-resolution blast radius (#2129)
 *
 * Reproduces the issue's graph shape: a small helper name (`classifyCard`)
 * exists in two files. The "real" one is called by `syncContent` (+ another
 * caller); a coincidental same-name helper elsewhere is called by `renderCard`.
 *
 * Before fix: impact("classifyCard", upstream) resolves the ambiguous bare name
 * to `impactedCount: 0` with a flat candidate list — the real caller
 * (`syncContent`) is silently dropped because it calls the *other* same-name
 * node. After fix: the ambiguous response runs a bounded summary-only BFS per
 * candidate, surfacing each one's true count + the maximum, so no real caller
 * hides behind a bare zero. The BFS / edge storage are unchanged — disambiguation
 * by uid still returns the exact caller.
 */
import { it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const SYNC_LOGIC_ID = 'Function:src/sync-logic.ts:classifyCard';
const UI_HELPERS_ID = 'Function:src/ui-helpers.ts:classifyCard';

const SEED = [
  // Two distinct functions named `classifyCard` in different files.
  `CREATE (cc1:Function {id: '${SYNC_LOGIC_ID}', name: 'classifyCard', filePath: 'src/sync-logic.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  `CREATE (cc2:Function {id: '${UI_HELPERS_ID}', name: 'classifyCard', filePath: 'src/ui-helpers.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,

  // Real callers of the sync-logic classifyCard (the blast radius that was lost).
  `CREATE (sc:Function {id: 'Function:src/actions.ts:syncContent', name: 'syncContent', filePath: 'src/actions.ts', startLine: 10, endLine: 120, isExported: true, content: '', description: ''})`,
  `CREATE (ss:Function {id: 'Function:src/actions.ts:scheduleSync', name: 'scheduleSync', filePath: 'src/actions.ts', startLine: 130, endLine: 160, isExported: true, content: '', description: ''})`,
  // Caller of the coincidental ui-helpers classifyCard.
  `CREATE (rc:Function {id: 'Function:src/ui-helpers.ts:renderCard', name: 'renderCard', filePath: 'src/ui-helpers.ts', startLine: 20, endLine: 40, isExported: true, content: '', description: ''})`,

  `MATCH (a:Function {id:'Function:src/actions.ts:syncContent'}), (b:Function {id:'${SYNC_LOGIC_ID}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'direct', step:0}]->(b)`,
  `MATCH (a:Function {id:'Function:src/actions.ts:scheduleSync'}), (b:Function {id:'${SYNC_LOGIC_ID}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'direct', step:0}]->(b)`,
  `MATCH (a:Function {id:'Function:src/ui-helpers.ts:renderCard'}), (b:Function {id:'${UI_HELPERS_ID}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'direct', step:0}]->(b)`,
];

withTestLbugDB(
  'impact-ambiguous-blast-radius',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });

    it('surfaces per-candidate blast radius instead of a bare impactedCount:0', async () => {
      const result = await backend.callTool('impact', {
        target: 'classifyCard',
        direction: 'upstream',
      });

      expect(result.status).toBe('ambiguous');
      expect(Array.isArray(result.candidates)).toBe(true);
      expect(result.candidates).toHaveLength(2);

      // The fix: the maximum real blast radius is hoisted to the top level so
      // the response can never be misread as "safe to refactor".
      expect(result.maxImpactedCount).toBeGreaterThanOrEqual(2);

      // Each candidate carries its own true count — the dropped caller is no
      // longer hidden behind the ambiguous zero.
      const syncLogic = result.candidates.find((c: any) =>
        String(c.filePath).includes('sync-logic'),
      );
      const uiHelpers = result.candidates.find((c: any) =>
        String(c.filePath).includes('ui-helpers'),
      );
      expect(syncLogic).toBeDefined();
      expect(uiHelpers).toBeDefined();
      expect(syncLogic.impactedCount).toBeGreaterThanOrEqual(2);
      expect(uiHelpers.impactedCount).toBeGreaterThanOrEqual(1);

      // Candidates are ranked by blast radius (most-impactful interpretation
      // first) so the dangerous one leads.
      expect(result.candidates[0].impactedCount).toBeGreaterThanOrEqual(
        result.candidates[1].impactedCount,
      );
    });

    it('disambiguation by uid returns the exact dropped caller (BFS unchanged)', async () => {
      const result = await backend.callTool('impact', {
        target: 'classifyCard',
        target_uid: SYNC_LOGIC_ID,
        direction: 'upstream',
      });

      expect(result.status).not.toBe('ambiguous');
      expect(result.impactedCount).toBeGreaterThanOrEqual(2);
      const names = Object.values(result.byDepth as Record<string, any[]>)
        .flat()
        .map((d: any) => d.name);
      expect(names).toContain('syncContent');
      expect(names).toContain('scheduleSync');
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 5, nodes: 6, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
