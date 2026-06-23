/**
 * Real-LadybugDB round trip for `Route.handlerSymbolId` (issue #2138, Part 2).
 *
 * The Part-1 analogue (`route-method-roundtrip.test.ts`) pins `Route.method`;
 * this pins the second persisted Route column added in Part 2. It persists a
 * `Route` node carrying `handlerSymbolId` through the real CSV generator + the
 * production `COPY` path into a real LadybugDB, then runs the exact production
 * `HANDLES_ROUTE_QUERY` and asserts the handler UID round-trips.
 *
 * Covers the three persistence points touched by Part 2's U2:
 *   - `ROUTE_SCHEMA` (schema.ts) — the `handlerSymbolId` column must exist
 *   - the Route CSV row (csv-generator.ts) — the value must be written
 *   - `getCopyQuery('Route')` (lbug-adapter.ts) — the COPY must load it
 */
import { it, expect } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { buildTestGraph } from '../helpers/test-graph.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';
import { HANDLES_ROUTE_QUERY } from '../../src/core/group/extractors/http-route-extractor.js';

const HANDLER_UID = 'Method:OrderController.java:create';

withTestLbugDB('route-handler-symbol-roundtrip', (handle) => {
  it('persists Route.handlerSymbolId through CSV→COPY and HANDLES_ROUTE_QUERY returns it', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    // 1. Route node carrying a resolved handlerSymbolId (what the routes phase
    //    now stamps when resolveRouteHandlerSymbols resolves the handler).
    const graph = buildTestGraph([
      {
        id: 'Route:/api/orders',
        label: 'Route',
        name: '/api/orders',
        filePath: 'OrderController.java',
        extra: {
          method: 'POST',
          handlerSymbolId: HANDLER_UID,
          responseKeys: [],
          errorKeys: [],
          middleware: [],
        },
      },
    ]);

    // 2. Generate CSVs through the real generator.
    const csvDir = path.join(handle.tmpHandle.dbPath, 'csv-handler-roundtrip');
    const repoDir = path.join(handle.tmpHandle.dbPath, 'repo-handler-roundtrip');
    await fs.mkdir(repoDir, { recursive: true });
    await streamAllCSVsToDisk(graph, repoDir, csvDir);

    // Sanity: route.csv header + row include the handlerSymbolId column/value.
    const routeCsv = await fs.readFile(path.join(csvDir, 'route.csv'), 'utf-8');
    expect(routeCsv.split('\n')[0]).toContain('handlerSymbolId');
    expect(routeCsv).toContain(HANDLER_UID);

    // 3. COPY the Route node via the production COPY query.
    const routeCsvPath = path.join(csvDir, 'route.csv').replace(/\\/g, '/');
    await adapter.executeQuery(adapter.getCopyQuery('Route', routeCsvPath));

    // 4. Seed the handler File node + HANDLES_ROUTE edge.
    await adapter.executeQuery(
      `CREATE (:File {id: 'File:OrderController.java', name: 'OrderController.java', filePath: 'OrderController.java'})`,
    );
    await adapter.executeQuery(
      `MATCH (f:File {id: 'File:OrderController.java'}), (r:Route {id: 'Route:/api/orders'})
       CREATE (f)-[:CodeRelation {type: 'HANDLES_ROUTE', confidence: 1.0, reason: 'framework-route', step: 0}]->(r)`,
    );

    // 5. Run the EXACT production query and assert the handler UID round-trips.
    const rows = (await adapter.executeQuery(HANDLES_ROUTE_QUERY)) as Record<string, unknown>[];
    const row = rows.find((r) => String(r.routePath) === '/api/orders');
    expect(row, 'HANDLES_ROUTE_QUERY returned no row for the seeded route').toBeTruthy();
    expect(row!.handlerSymbolId).toBe(HANDLER_UID);
  });
});
