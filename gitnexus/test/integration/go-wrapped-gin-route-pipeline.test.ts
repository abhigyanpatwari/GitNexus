/**
 * Routes registered on a wrapper package's engine alias (`*core.Engine`, where
 * the dependency declares `type Engine = gin.Engine`) with handlers wrapped by
 * an application adapter (`common.Wrapper(api.CreateJob)`).
 *
 * Neither fact is provable from the repository: the dependency's source is not
 * vendored, and a call in the handler slot may be middleware. Both are user
 * configuration (`goRouterAliases`, `goHandlerWrappers`), applied on the main
 * thread — so the same parse output yields no routes without it.
 *
 * Fixture: `test/fixtures/go-wrapped-gin-route-app/`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'go-wrapped-gin-route-app');

const routeView = (result: PipelineResult): string[] => {
  const out: string[] = [];
  result.graph.forEachNode((node) => {
    if (node.label !== 'Route') return;
    const handler = result.graph.getNode(String(node.properties.handlerSymbolId));
    out.push(
      `${String(node.properties.method)} ${String(node.properties.name)} -> ${String(
        handler?.properties.name,
      )}`,
    );
  });
  return out.sort();
};

describe('wrapper-package gin route ingestion', () => {
  let configured: PipelineResult;
  let unconfigured: PipelineResult;

  beforeAll(async () => {
    [configured, unconfigured] = await Promise.all([
      runPipelineFromRepo(FIXTURE, () => {}, {
        routeFrameworkAliases: [
          { importPath: 'example.com/infra/pkg', type: 'Engine', framework: 'gin' },
        ],
        routeHandlerWrappers: ['common.Wrapper', 'common.WrapperWithSuccessCode'],
      }),
      runPipelineFromRepo(FIXTURE, () => {}, {}),
    ]);
  }, 300_000);

  it('emits prefixed routes and resolves wrapped handlers when configured', () => {
    expect(routeView(configured)).toEqual([
      'GET /console/v1/jobs/status -> JobStatus',
      'GET /console/v1/jobs/userinfo -> UserInfo',
      'POST /console/v1/jobs/create -> CreateJob',
    ]);
  });

  it('draws HANDLES_ROUTE from the wrapped method with gin provenance', () => {
    let edge: { handler: unknown; reason: unknown } | undefined;
    configured.graph.forEachRelationship((rel) => {
      if (rel.type === 'HANDLES_ROUTE' && rel.targetId === 'Route:POST /console/v1/jobs/create') {
        edge = {
          handler: configured.graph.getNode(rel.sourceId)?.properties.name,
          reason: rel.reason,
        };
      }
    });
    expect(edge).toEqual({ handler: 'CreateJob', reason: 'gin-route' });
  });

  it('emits no route without the alias configuration', () => {
    expect(routeView(unconfigured)).toEqual([]);
  });
});
