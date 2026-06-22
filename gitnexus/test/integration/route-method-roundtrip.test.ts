/**
 * Real-LadybugDB round trip for `Route.method` (issue #2138, Part 1).
 *
 * This is the test the mocked `http-route-graph-method.test.ts` could NOT
 * provide: it persists a `Route` node carrying `method` through the actual
 * CSV generator + `COPY` path into a real LadybugDB, then runs the exact
 * production `HANDLES_ROUTE_QUERY` and asserts the verb comes back.
 *
 * Before the schema/CSV/COPY columns were added, `HANDLES_ROUTE_QUERY`'s
 * `route.method AS routeMethod` failed to bind against the real schema
 * (`Binder exception: Cannot find property method for r.`) and the
 * extractor's `catch { return [] }` silently swallowed it — so this test
 * would have failed (empty rows / throw), pinning the exact regression.
 *
 * Coverage spans all three persistence points touched by Part 1:
 *   - `ROUTE_SCHEMA` (schema.ts) — the `method` column must exist
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

withTestLbugDB('route-method-roundtrip', (handle) => {
  it('persists Route.method through CSV→COPY and HANDLES_ROUTE_QUERY returns it', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    // 1. Build a graph with a single framework Route node carrying `method`,
    //    mirroring what the routes phase now emits for a Spring controller.
    const graph = buildTestGraph([
      {
        id: 'Route:/api/orders',
        label: 'Route',
        name: '/api/orders',
        filePath: 'OrderController.java',
        extra: {
          method: 'POST',
          responseKeys: [],
          errorKeys: [],
          middleware: [],
        },
      },
    ]);

    // 2. Generate CSVs through the real generator (exercises the new
    //    `method` column in the Route CSV row).
    const csvDir = path.join(handle.tmpHandle.dbPath, 'csv-roundtrip');
    const repoDir = path.join(handle.tmpHandle.dbPath, 'repo-roundtrip');
    await fs.mkdir(repoDir, { recursive: true });
    await streamAllCSVsToDisk(graph, repoDir, csvDir);

    // Sanity: the generated route.csv header + row include the method column.
    const routeCsv = await fs.readFile(path.join(csvDir, 'route.csv'), 'utf-8');
    expect(routeCsv.split('\n')[0]).toContain('method');
    expect(routeCsv).toContain('POST');

    // 3. COPY the Route node into the real DB via the production COPY query
    //    (exercises the new `method` column in getCopyQuery('Route')).
    const routeCsvPath = path.join(csvDir, 'route.csv').replace(/\\/g, '/');
    await adapter.executeQuery(adapter.getCopyQuery('Route', routeCsvPath));

    // 4. Seed the handler File node + HANDLES_ROUTE edge via Cypher.
    await adapter.executeQuery(
      `CREATE (:File {id: 'File:OrderController.java', name: 'OrderController.java', filePath: 'OrderController.java'})`,
    );
    await adapter.executeQuery(
      `MATCH (f:File {id: 'File:OrderController.java'}), (r:Route {id: 'Route:/api/orders'})
       CREATE (f)-[:CodeRelation {type: 'HANDLES_ROUTE', confidence: 1.0, reason: 'framework-route', step: 0}]->(r)`,
    );

    // 5. Run the EXACT production query and assert the verb round-trips.
    const rows = (await adapter.executeQuery(HANDLES_ROUTE_QUERY)) as Record<string, unknown>[];
    const row = rows.find((r) => String(r.routePath) === '/api/orders');
    expect(row, 'HANDLES_ROUTE_QUERY returned no row for the seeded route').toBeTruthy();
    expect(row!.routeMethod).toBe('POST');
  });
});
