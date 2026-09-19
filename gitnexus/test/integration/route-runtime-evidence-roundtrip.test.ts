/**
 * Real-LadybugDB round trip for Spring Actuator Route evidence (#2418).
 * Pins the schema, CSV, COPY, and graph-read projections that must agree for
 * runtime-confirmed markers to survive beyond the in-memory ingestion graph.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getNodeQuery } from '../../src/server/api.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';
import { generateId } from '../../src/lib/utils.js';
import { buildTestGraph } from '../helpers/test-graph.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const ROUTE_ID = generateId('Route', 'GET /runtime-confirmed');

withTestLbugDB('route-runtime-evidence-roundtrip', (handle) => {
  it('persists and projects Route runtime evidence through CSV→COPY→query', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const graph = buildTestGraph([
      {
        id: ROUTE_ID,
        label: 'Route',
        name: '/runtime-confirmed',
        filePath: 'RuntimeController.java',
        extra: {
          method: 'GET',
          responseKeys: [],
          errorKeys: [],
          middleware: [],
          runtimeConfirmed: true,
          runtimeSource: 'spring-actuator',
          runtimeStatus: 'runtime-confirmed',
        },
      },
    ]);

    const csvDir = path.join(handle.tmpHandle.dbPath, 'csv-runtime-evidence');
    const repoDir = path.join(handle.tmpHandle.dbPath, 'repo-runtime-evidence');
    await fs.mkdir(repoDir, { recursive: true });
    await streamAllCSVsToDisk(graph, repoDir, csvDir);

    const routeCsv = await fs.readFile(path.join(csvDir, 'route.csv'), 'utf8');
    expect(routeCsv.split('\n')[0]).toContain('runtimeConfirmed,runtimeSource,runtimeStatus');
    expect(routeCsv).toContain('spring-actuator');

    const routeCsvPath = path.join(csvDir, 'route.csv').replace(/\\/g, '/');
    await adapter.executeQuery(adapter.getCopyQuery('Route', routeCsvPath));

    const rows = (await adapter.executeQuery(getNodeQuery('Route', false))) as Record<
      string,
      unknown
    >[];
    expect(rows).toContainEqual(
      expect.objectContaining({
        id: ROUTE_ID,
        runtimeConfirmed: true,
        runtimeSource: 'spring-actuator',
        runtimeStatus: 'runtime-confirmed',
      }),
    );
  });
});
