/**
 * Regression tests for shape_check false positives.
 *
 * 1. errorPathKeys exclusion: consumer accessing error-path keys (e.g. 'error')
 *    must land in errorPathKeys — NOT mismatched — and must NOT trigger MISMATCH status.
 *
 * 2. Blocklist doesn't suppress legitimate API fields: fields like 'type' and 'href'
 *    are blocklisted from DOM-method filtering in consumer extraction, but when a route
 *    actually returns them, shape_check must recognise them as valid matches.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// ─── Seed data ────────────────────────────────────────────────────────────────

const SEED: string[] = [
  // Files
  `CREATE (f:File {id: 'file:app/api/orders/route.ts', name: 'route.ts', filePath: 'app/api/orders/route.ts', content: 'GET handler'})`,
  `CREATE (f:File {id: 'file:app/api/links/route.ts', name: 'route.ts', filePath: 'app/api/links/route.ts', content: 'GET handler'})`,
  `CREATE (f:File {id: 'file:components/OrderStatus.tsx', name: 'OrderStatus.tsx', filePath: 'components/OrderStatus.tsx', content: 'consumer'})`,
  `CREATE (f:File {id: 'file:components/LinkList.tsx', name: 'LinkList.tsx', filePath: 'components/LinkList.tsx', content: 'consumer'})`,

  // ─── Route: /api/orders ──────────────────────────────────────────────────
  // Success keys: [orderId, status, items]
  // Error keys:   [error, code]
  `CREATE (r:Route {id: 'Route:/api/orders', name: '/api/orders', filePath: 'app/api/orders/route.ts', responseKeys: ['orderId', 'status', 'items'], errorKeys: ['error', 'code'], middleware: []})`,

  // ─── Route: /api/links ───────────────────────────────────────────────────
  // Returns fields that overlap with DOM property names: type, href, target
  `CREATE (r:Route {id: 'Route:/api/links', name: '/api/links', filePath: 'app/api/links/route.ts', responseKeys: ['type', 'href', 'target', 'label'], errorKeys: [], middleware: []})`,

  // ─── Consumer functions ──────────────────────────────────────────────────
  `CREATE (fn:Function {id: 'func:OrderStatus', name: 'OrderStatus', filePath: 'components/OrderStatus.tsx', startLine: 1, endLine: 10, isExported: true, content: 'export function OrderStatus()', description: 'Order status component'})`,
  `CREATE (fn:Function {id: 'func:LinkList', name: 'LinkList', filePath: 'components/LinkList.tsx', startLine: 1, endLine: 10, isExported: true, content: 'export function LinkList()', description: 'Link list component'})`,

  // ─── Handler functions ───────────────────────────────────────────────────
  `CREATE (fn:Function {id: 'func:orders-GET', name: 'GET', filePath: 'app/api/orders/route.ts', startLine: 1, endLine: 8, isExported: true, content: 'export async function GET()', description: 'Orders GET handler'})`,
  `CREATE (fn:Function {id: 'func:links-GET', name: 'GET', filePath: 'app/api/links/route.ts', startLine: 1, endLine: 8, isExported: true, content: 'export async function GET()', description: 'Links GET handler'})`,

  // ─── FETCHES edges ───────────────────────────────────────────────────────

  // OrderStatus accesses 'orderId', 'status', and 'error' — error is in errorKeys, not responseKeys.
  // This must NOT cause a MISMATCH; 'error' should appear in errorPathKeys only.
  `MATCH (a:Function), (r:Route) WHERE a.id = 'func:OrderStatus' AND r.id = 'Route:/api/orders'
   CREATE (a)-[:CodeRelation {type: 'FETCHES', confidence: 1.0, reason: 'fetch-url-match|keys:orderId,status,error', step: 0}]->(r)`,

  // LinkList accesses 'type', 'href', 'target', 'label' — all are legitimate route responseKeys.
  // These field names overlap with DOM properties but are real API fields here.
  `MATCH (a:Function), (r:Route) WHERE a.id = 'func:LinkList' AND r.id = 'Route:/api/links'
   CREATE (a)-[:CodeRelation {type: 'FETCHES', confidence: 1.0, reason: 'fetch-url-match|keys:type,href,target,label', step: 0}]->(r)`,

  // ─── HANDLES_ROUTE edges ─────────────────────────────────────────────────
  `MATCH (fn:Function), (r:Route) WHERE fn.id = 'func:orders-GET' AND r.id = 'Route:/api/orders'
   CREATE (fn)-[:CodeRelation {type: 'HANDLES_ROUTE', confidence: 1.0, reason: 'nextjs-app-router', step: 0}]->(r)`,
  `MATCH (fn:Function), (r:Route) WHERE fn.id = 'func:links-GET' AND r.id = 'Route:/api/links'
   CREATE (fn)-[:CodeRelation {type: 'HANDLES_ROUTE', confidence: 1.0, reason: 'nextjs-app-router', step: 0}]->(r)`,
];

// ─── Tests ────────────────────────────────────────────────────────────────────

withTestLbugDB(
  'shape-check-regression',
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

    // ─── Test 1: errorPathKeys exclusion from mismatched ──────────────────

    describe('errorPathKeys exclusion from mismatched', () => {
      it('error-path key appears in errorPathKeys, not mismatched', async () => {
        const result = await backend.callTool('shape_check', { route: '/api/orders' });

        expect(result.routes).toBeDefined();
        const ordersRoute = result.routes.find((r: any) => r.route === '/api/orders');
        expect(ordersRoute).toBeDefined();

        const consumer = ordersRoute!.consumers.find(
          (c: any) => c.filePath === 'components/OrderStatus.tsx',
        );
        expect(consumer).toBeDefined();

        // 'error' is in the route's errorKeys — consumer accessing it is valid
        // It must appear in errorPathKeys, NOT in mismatched
        expect(consumer!.errorPathKeys).toBeDefined();
        expect(consumer!.errorPathKeys).toContain('error');

        // 'error' must NOT appear in mismatched
        if (consumer!.mismatched) {
          expect(consumer!.mismatched).not.toContain('error');
        }
      });

      it('route with only error-path differences has no MISMATCH status', async () => {
        const result = await backend.callTool('shape_check', { route: '/api/orders' });

        const ordersRoute = result.routes.find((r: any) => r.route === '/api/orders');
        expect(ordersRoute).toBeDefined();

        // All consumer keys are known (either in responseKeys or errorKeys)
        // So the route must NOT be flagged as MISMATCH
        expect(ordersRoute!.status).toBeUndefined();
      });

      it('no global mismatches count when only error-path keys differ', async () => {
        const result = await backend.callTool('shape_check', { route: '/api/orders' });

        // Top-level mismatches count should be absent (0 mismatches)
        expect(result.mismatches).toBeUndefined();
      });
    });

    // ─── Test 2: blocklist doesn't suppress legitimate API fields ─────────

    describe('blocklist does not suppress legitimate API fields', () => {
      it('DOM-like field names in route response are valid matches', async () => {
        const result = await backend.callTool('shape_check', { route: '/api/links' });

        expect(result.routes).toBeDefined();
        const linksRoute = result.routes.find((r: any) => r.route === '/api/links');
        expect(linksRoute).toBeDefined();

        const consumer = linksRoute!.consumers.find(
          (c: any) => c.filePath === 'components/LinkList.tsx',
        );
        expect(consumer).toBeDefined();

        // All accessed keys (type, href, target, label) are in the route's responseKeys
        // None should be treated as mismatched
        if (consumer!.mismatched) {
          expect(consumer!.mismatched).not.toContain('type');
          expect(consumer!.mismatched).not.toContain('href');
          expect(consumer!.mismatched).not.toContain('target');
          expect(consumer!.mismatched).not.toContain('label');
        }
      });

      it('route with DOM-like fields has no MISMATCH status', async () => {
        const result = await backend.callTool('shape_check', { route: '/api/links' });

        const linksRoute = result.routes.find((r: any) => r.route === '/api/links');
        expect(linksRoute).toBeDefined();

        // No mismatches — all consumer keys match route responseKeys
        expect(linksRoute!.status).toBeUndefined();
      });

      it('no errorPathKeys when all accessed keys are in responseKeys', async () => {
        const result = await backend.callTool('shape_check', { route: '/api/links' });

        const linksRoute = result.routes.find((r: any) => r.route === '/api/links');
        const consumer = linksRoute!.consumers.find(
          (c: any) => c.filePath === 'components/LinkList.tsx',
        );
        expect(consumer).toBeDefined();

        // All keys are in responseKeys (not errorKeys), so no errorPathKeys
        expect(consumer!.errorPathKeys).toBeUndefined();
      });
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-shape-regression',
          path: '/test/shape-regression',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 4, nodes: 8, communities: 0, processes: 0 },
        },
      ]);

      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
