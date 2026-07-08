/**
 * E2E Integration Tests: api_impact / route_map method round-trip (#2308)
 *
 * Proves the `n.method` column round-trips through a real LadybugDB — the
 * fetchRoutesWithConsumers query, the polymorphic api_impact shape, and the
 * method selector (including the method-agnostic '*' case) — beyond the unit
 * mocks in calltool-dispatch.test.ts.
 *
 * Self-contained seed (own routes, no FTS) so it neither perturbs the shared
 * api-impact-e2e fixture nor silently skips on an FTS-less box: api_impact and
 * route_map use graph queries, not full-text search.
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

// After #2302 a Route node is keyed by (method, url): GET/POST of the same URL
// are distinct nodes, while a method-agnostic route (Django function view)
// keys by URL alone and persists with the literal method '*'.
const METHOD_SEED_DATA = [
  `CREATE (f:File {id: 'file:app/api/orders/route.ts', name: 'route.ts', filePath: 'app/api/orders/route.ts', content: 'export async function GET() {} export async function POST() {}'})`,
  `CREATE (f:File {id: 'file:orders/views.py', name: 'views.py', filePath: 'orders/views.py', content: 'def order_view(request): ...'})`,
  `CREATE (r:Route {id: 'Route:GET /api/orders', name: '/api/orders', filePath: 'app/api/orders/route.ts', method: 'GET', responseKeys: ['data'], errorKeys: [], middleware: []})`,
  `CREATE (r:Route {id: 'Route:POST /api/orders', name: '/api/orders', filePath: 'app/api/orders/route.ts', method: 'POST', responseKeys: ['id'], errorKeys: [], middleware: []})`,
  `CREATE (r:Route {id: 'Route:/django/view', name: '/django/view', filePath: 'orders/views.py', method: '*', responseKeys: [], errorKeys: [], middleware: []})`,
];

withTestLbugDB(
  'api-impact-method-e2e',
  (handle) => {
    let backend: LocalBackend;

    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) {
        throw new Error(
          'LocalBackend not initialized — afterSetup did not attach _backend to handle',
        );
      }
      backend = ext._backend;
    });

    describe('api_impact method round-trip (live LadybugDB)', () => {
      it('returns the wrapped form for a same-URL multi-verb route, each with its method', async () => {
        const result = await backend.callTool('api_impact', { route: '/api/orders' });
        expect(result).not.toHaveProperty('error');
        expect(result.total).toBe(2);
        expect(result.routes.map((r: { method: string | null }) => r.method).sort()).toEqual([
          'GET',
          'POST',
        ]);
      });

      it('narrows a multi-verb URL to one route when method is given', async () => {
        const result = await backend.callTool('api_impact', {
          route: '/api/orders',
          method: 'POST',
        });
        expect(result.method).toBe('POST');
        expect(result.route).toBe('/api/orders');
        expect(result.routes).toBeUndefined();
      });

      it('matches a method-agnostic (*) route against a specific method selector', async () => {
        const result = await backend.callTool('api_impact', {
          route: '/django/view',
          method: 'POST',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.method).toBe('*');
        expect(result.route).toBe('/django/view');
      });
    });

    describe('route_map method round-trip (live LadybugDB)', () => {
      it('surfaces each route method', async () => {
        const result = await backend.callTool('route_map', { route: '/api/orders' });
        expect(result.routes.map((r: { method: string | null }) => r.method).sort()).toEqual([
          'GET',
          'POST',
        ]);
      });
    });
  },
  {
    seed: METHOD_SEED_DATA,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-method-repo',
          path: '/test/method-repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc789',
          stats: { files: 2, nodes: 5, communities: 0, processes: 0 },
        },
      ]);

      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
