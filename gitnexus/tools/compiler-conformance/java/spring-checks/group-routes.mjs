import assert from 'node:assert/strict';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import {
  HANDLES_ROUTE_QUERY,
  HttpRouteExtractor,
} from '../../../../dist/core/group/extractors/http-route-extractor.js';
import { springProject, withPersistedGraph } from '../spring-support.mjs';
import { compareSpringJava } from '../spring-web-java.mjs';

/** Keep one resolved graph provider and require the group source scan to recover the rest. */
export async function verifyPartiallyIndexedRoutes() {
  for (const [project, covered, missing] of [
    ['route-array', '/covered', ['GET::/a', 'GET::/b']],
    ['route-multiverb', '/orders', ['POST::/orders']],
    ['route-inherited-fallback', '/direct', ['GET::/orders/{param}']],
  ]) {
    const root = springProject(project);
    const result = await runPipelineFromRepo(root, () => {});
    compareSpringJava(root, result);
    for (const route of [...result.graph.iterNodes()].filter((node) => node.label === 'Route')) {
      if (route.properties.name !== covered || route.properties.method !== 'GET')
        result.graph.removeNode(route.id);
    }
    await withPersistedGraph(project, root, result.graph, async (execute) => {
      const rows = await execute(HANDLES_ROUTE_QUERY);
      assert.deepEqual(
        rows.map((row) => [row.routeMethod, row.routePath]),
        [['GET', covered]],
        project,
      );
      assert.ok(rows[0].handlerSymbolId, project);
      const contracts = await new HttpRouteExtractor().extract(execute, root, {
        name: project,
        url: root,
      });
      const providers = contracts.filter((c) => c.role === 'provider');
      for (const key of [`GET::${covered}`, ...missing]) {
        assert.ok(
          providers.some((c) => `${c.meta.method}::${c.meta.path}` === key),
          `${project}: ${key}`,
        );
      }
    });
  }
}
