/**
 * `impact` upstream from a service method names the HTTP route its handler
 * serves (#3402), against a real LadybugDB.
 *
 * The seed is the shape `go-gin-route-pipeline.test.ts` proves the pipeline
 * emits for the issue's router: the handler CALLS the service, and
 * (handler)-[HANDLES_ROUTE]->Route. Before #3402 the walk stopped at the handler
 * and the route never appeared; the unit test mocks the database, so this is
 * the only place the enrichment query runs against the real engine.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const HANDLER = 'Method:router/match_handler.go:MatchHandler.UnfinalizeRoundHandle#1';
const SERVICE = 'Method:service/match.go:Service.UnfinalizeRound#2';
const ROUTE = 'Route:POST /api/v1/admin/seasons/:seasonId/rounds/:roundId/unfinalize';

const SEED = [
  `CREATE (m:Method {id:'${SERVICE}', name:'UnfinalizeRound', filePath:'service/match.go', startLine:4, endLine:6, isExported:true, content:'', description:''})`,
  `CREATE (m:Method {id:'${HANDLER}', name:'UnfinalizeRoundHandle', filePath:'router/match_handler.go', startLine:4, endLine:7, isExported:true, content:'', description:''})`,
  `CREATE (r:Route {id:'${ROUTE}', name:'/api/v1/admin/seasons/:seasonId/rounds/:roundId/unfinalize', filePath:'router/router.go', method:'POST', handlerSymbolId:'${HANDLER}'})`,
  `MATCH (a:Method {id:'${HANDLER}'}), (b:Method {id:'${SERVICE}'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'import-resolved', step:0}]->(b)`,
  `MATCH (a:Method {id:'${HANDLER}'}), (r:Route {id:'${ROUTE}'}) CREATE (a)-[:CodeRelation {type:'HANDLES_ROUTE', confidence:1.0, reason:'gin-route', step:0}]->(r)`,
];

withTestLbugDB(
  'impact-affected-routes',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as unknown as { _backend: LocalBackend })._backend;
    });

    describe('impact: affected_routes', () => {
      it('reaches the route through the handler that calls the service', async () => {
        const result = await backend.callTool('impact', {
          target: 'UnfinalizeRound',
          direction: 'upstream',
        });
        const handlerItem = Object.values(result.byDepth as Record<string, Array<{ id: string }>>)
          .flat()
          .find((item) => item.id === HANDLER);

        expect({
          partial: result.partial,
          affected_routes: result.affected_routes,
          handlerRoutes: (handlerItem as { routes?: unknown } | undefined)?.routes,
        }).toEqual({
          partial: undefined,
          affected_routes: [
            {
              url: '/api/v1/admin/seasons/:seasonId/rounds/:roundId/unfinalize',
              method: 'POST',
            },
          ],
          handlerRoutes: [
            {
              url: '/api/v1/admin/seasons/:seasonId/rounds/:roundId/unfinalize',
              method: 'POST',
            },
          ],
        });
      });
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
          stats: { files: 5, nodes: 3, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as unknown as { _backend: LocalBackend })._backend = backend;
    },
  },
);
