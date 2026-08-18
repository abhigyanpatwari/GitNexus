/**
 * JavaScript data-route-table handler-stability scaling benchmark.
 *
 * The scanner used to walk the complete AST once for every route handler,
 * making extraction quadratic as a route table grew. This benchmark parses
 * outside the timed region and co-scales unique handlers and route entries so
 * the measured work isolates scanDataRouteTables.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/data-route-table-benchmark.test.ts
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import { scanDataRouteTables } from '../../src/core/ingestion/route-extractors/data-route-table.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';
const parser = new Parser();
parser.setLanguage(JavaScript);

interface BenchResult {
  routes: number;
  elapsedMs: number;
}

function fixture(routeCount: number): string {
  const handlers = Array.from({ length: routeCount }, (_, i) => `function handler${i}() {}`).join(
    '\n',
  );
  const entries = Array.from(
    { length: routeCount },
    (_, i) => `  { path: '/route-${i}', method: 'GET', handler: handler${i} },`,
  ).join('\n');
  return `${handlers}
const routes = [
${entries}
];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}`;
}

function benchmark(routeCount: number): BenchResult {
  const tree = parser.parse(fixture(routeCount));
  const started = performance.now();
  const routes = scanDataRouteTables(tree);
  const elapsedMs = performance.now() - started;
  expect(routes).toHaveLength(routeCount);
  return { routes: routeCount, elapsedMs };
}

describe.skipIf(!BENCH_ENABLED)('data-route-table scanner benchmark', () => {
  it('scales sub-quadratically as handlers and route entries grow together', () => {
    benchmark(10);

    const small = benchmark(50);
    const large = benchmark(200);
    const routeRatio = large.routes / small.routes;

    console.log('\nJavaScript data-route-table scanner benchmark');
    console.log(`  routes=${small.routes} wall=${small.elapsedMs.toFixed(2)}ms`);
    console.log(`  routes=${large.routes} wall=${large.elapsedMs.toFixed(2)}ms`);

    if (small.elapsedMs >= 5) {
      expect(large.elapsedMs / small.elapsedMs).toBeLessThan(Math.pow(routeRatio, 1.5));
    }
    expect(large.elapsedMs).toBeLessThan(5_000);
  }, 120_000);
});
