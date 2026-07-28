/**
 * Regression test for #2508 — context()/impact() must return EXACT caller
 * identities, never counts alone.
 *
 * The #2508 failure shape: a target Function with two CALLS edges arriving
 * through two different CodeRelation sub-table pairs — a production
 * Function→Function caller and a File→Function test-file caller. On affected
 * LadybugDB versions (≤0.18.2), `r.type IN [...]` predicates could drop the
 * production caller and duplicate the test caller: the boolean-filter
 * fallback skipped writing selection buffers for single-row unflat chunks
 * (LadybugDB#692). Fixed upstream in LadybugDB#699, shipped in
 * @ladybugdb/core 0.18.3. These assertions pin the IN-predicate query paths
 * to exact caller IDs so any future predicate regression that drops or
 * duplicates a caller fails loudly here.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB, type IndexedDBHandle } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

type BackendHandle = IndexedDBHandle & { _backend?: LocalBackend };

const TARGET_ID = 'func:classifyOutcome';
const PROD_CALLER_ID = 'func:resilientFetch';
const TEST_CALLER_ID = 'file:resilient-fetch.test';

withTestLbugDB(
  'caller-identity-2508',
  (handle) => {
    describe('caller identity across CodeRelation sub-table pairs (#2508)', () => {
      let backend: LocalBackend;

      beforeAll(() => {
        const ext = handle as BackendHandle;
        if (!ext._backend) {
          throw new Error('LocalBackend not initialized — afterSetup did not attach _backend');
        }
        backend = ext._backend;
      });

      it('context() lists the Function caller and the File caller exactly once each', async () => {
        const result = await backend.callTool('context', { name: 'classifyOutcome' });
        expect(result).not.toHaveProperty('error');
        expect(result.status).toBe('found');
        const callerUids = (result.incoming?.calls ?? []).map((c: { uid: string }) => c.uid);
        expect(callerUids.sort()).toEqual([TEST_CALLER_ID, PROD_CALLER_ID].sort());
      });

      it('impact(upstream) returns the production caller by exact id with tests excluded', async () => {
        const result = await backend.callTool('impact', {
          target: 'classifyOutcome',
          direction: 'upstream',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        const directIds = (result.byDepth?.[1] ?? []).map((d: { id: string }) => d.id);
        expect(directIds).toContain(PROD_CALLER_ID);
        expect(directIds).not.toContain(TEST_CALLER_ID);
      });

      it('impact(upstream, includeTests) returns both callers by exact id', async () => {
        const result = await backend.callTool('impact', {
          target: 'classifyOutcome',
          direction: 'upstream',
          includeTests: true,
        });
        expect(result).not.toHaveProperty('error');
        const directIds = (result.byDepth?.[1] ?? []).map((d: { id: string }) => d.id);
        expect(directIds).toContain(PROD_CALLER_ID);
        expect(directIds).toContain(TEST_CALLER_ID);
        expect(directIds.filter((id: string) => id === TEST_CALLER_ID)).toHaveLength(1);
      });
    });
  },
  {
    seed: [
      `CREATE (t:Function {id: '${TARGET_ID}', name: 'classifyOutcome', filePath: 'src/integrations/resilient-fetch.ts', startLine: 10, endLine: 20, isExported: true, content: 'function classifyOutcome() {}', description: 'classifies fetch outcomes'})`,
      `CREATE (p:Function {id: '${PROD_CALLER_ID}', name: 'resilientFetch', filePath: 'src/integrations/resilient-fetch.ts', startLine: 30, endLine: 60, isExported: true, content: 'function resilientFetch() {}', description: 'production caller'})`,
      `CREATE (f:File {id: '${TEST_CALLER_ID}', name: 'resilient-fetch.test.ts', filePath: 'test/unit/resilient-fetch.test.ts', content: 'test module'})`,
      `MATCH (a:Function), (b:Function) WHERE a.id = '${PROD_CALLER_ID}' AND b.id = '${TARGET_ID}'
       CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.85, reason: 'direct', step: 0}]->(b)`,
      `MATCH (a:File), (b:Function) WHERE a.id = '${TEST_CALLER_ID}' AND b.id = '${TARGET_ID}'
       CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'direct', step: 0}]->(b)`,
    ],
    poolAdapter: true,
    afterSetup: async (h) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'caller-identity-repo',
          path: '/caller-identity/repo',
          storagePath: h.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 2, nodes: 3, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (h as BackendHandle)._backend = backend;
    },
  },
);
