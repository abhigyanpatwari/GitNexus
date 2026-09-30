/**
 * End-to-end coverage of gin / echo route ingestion (#3402).
 *
 * The reported symptom was zero `Route` nodes for a gin backend, and `impact`
 * on a service method ending at the HTTP handler. The unit suites pin what the
 * extractor returns (`go-gin-echo-routes.test.ts`) and how the Go hook resolves
 * a designator against a hand-built model (`go-route-handler.test.ts`). This
 * file covers what neither can: the worker emitting routes for real Go files,
 * `go.mod` driving the import that resolves `handlers.Health`, and a method
 * whose struct is declared in a SIBLING file resolving through the parse-time
 * owner id.
 *
 * Fixture: `test/fixtures/go-gin-route-app/`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'go-gin-route-app');

interface RouteView {
  /** `${method} ${url}` — the `routeNodeKey` identity, as a sortable string. */
  readonly identity: string;
  readonly routeFile: string;
  /** The handler the route resolved to, or the literal `'undefined'`. */
  readonly handler: string;
  readonly handlerLabel: string;
  readonly handlerFile: string;
}

describe('gin / echo route ingestion pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 300_000);

  const nodes = (): readonly GraphNode[] => {
    const out: GraphNode[] = [];
    result.graph.forEachNode((node) => void out.push(node));
    return out;
  };

  const relationships = (): readonly GraphRelationship[] => {
    const out: GraphRelationship[] = [];
    result.graph.forEachRelationship((rel) => void out.push(rel));
    return out;
  };

  /**
   * Unresolved fields are stringified rather than branched on, so a route that
   * lost its handler reads as the literal `'undefined'` in the diff.
   */
  const routes = (): readonly RouteView[] =>
    nodes()
      .filter((node) => node.label === 'Route')
      .map((node) => {
        const handler = result.graph.getNode(String(node.properties.handlerSymbolId));
        return {
          identity: `${String(node.properties.method)} ${String(node.properties.name)}`,
          routeFile: String(node.properties.filePath).replaceAll('\\', '/'),
          handler: String(handler?.properties.name),
          handlerLabel: String(handler?.label),
          handlerFile: String(handler?.properties.filePath).replaceAll('\\', '/'),
        };
      })
      .sort((a, b) => a.identity.localeCompare(b.identity));

  it('joins Group prefixes and resolves every uniquely-named handler', () => {
    expect(routes()).toEqual([
      {
        // Package function, reached through a go.mod-resolved import.
        identity: 'GET /api/v1/health',
        routeFile: 'router/router.go',
        handler: 'Health',
        handlerLabel: 'Function',
        handlerFile: 'handlers/health.go',
      },
      {
        // Inline func literal: the route stands, with no handler symbol.
        identity: 'GET /api/v1/ping',
        routeFile: 'router/router.go',
        handler: 'undefined',
        handlerLabel: 'undefined',
        handlerFile: 'undefined',
      },
      {
        // A version suffix belongs to the path, not the package qualifier.
        identity: 'GET /api/v1/status',
        routeFile: 'router/router.go',
        handler: 'Status',
        handlerLabel: 'Function',
        handlerFile: 'status/v2/status.go',
      },
      {
        identity: 'GET /api/v1/version',
        routeFile: 'router/router.go',
        handler: 'Version',
        handlerLabel: 'Function',
        handlerFile: 'router/router.go',
      },
      {
        // echo: handler is the SECOND argument; trailing middleware is skipped.
        identity: 'GET /echo/users',
        routeFile: 'echoapp/routes.go',
        handler: 'List',
        handlerLabel: 'Method',
        handlerFile: 'echoapp/routes.go',
      },
      {
        // Interface-typed receiver: `Login` exists on two structs, so decline.
        identity: 'POST /api/v1/admin/login',
        routeFile: 'router/router.go',
        handler: 'undefined',
        handlerLabel: 'undefined',
        handlerFile: 'undefined',
      },
      {
        // The issue #3402 route: constructor-built receiver, struct declared in
        // types.go, method in match_handler.go. The Route stays on the file
        // that registers it.
        identity: 'POST /api/v1/admin/seasons/:seasonId/rounds/:roundId/unfinalize',
        routeFile: 'router/router.go',
        handler: 'UnfinalizeRoundHandle',
        handlerLabel: 'Method',
        handlerFile: 'router/match_handler.go',
      },
      {
        // `&AuthHandler{}` picks one of the two `Login` methods.
        identity: 'POST /api/v1/login',
        routeFile: 'router/router.go',
        handler: 'Login',
        handlerLabel: 'Method',
        handlerFile: 'router/auth_handlers.go',
      },
    ]);
  });

  it('does not mint a route from a RouterGroup handed to another function', () => {
    expect(routes().map((route) => route.identity)).not.toContain('GET /api/v1/legacy');
    expect(routes().map((route) => route.identity)).not.toContain('GET /legacy');
  });

  it('draws the symbol-level HANDLES_ROUTE edge with gin provenance', () => {
    const edge = relationships().find(
      (rel) =>
        rel.type === 'HANDLES_ROUTE' &&
        rel.targetId === 'Route:POST /api/v1/admin/seasons/:seasonId/rounds/:roundId/unfinalize' &&
        result.graph.getNode(rel.sourceId)?.label === 'Method',
    );
    expect({
      handler: result.graph.getNode(String(edge?.sourceId))?.properties.name,
      reason: edge?.reason,
    }).toEqual({ handler: 'UnfinalizeRoundHandle', reason: 'gin-route' });
  });

  it('draws HANDLES_ROUTE for an unaliased versioned handler package', () => {
    const edge = relationships().find(
      (rel) =>
        rel.type === 'HANDLES_ROUTE' &&
        rel.targetId === 'Route:GET /api/v1/status' &&
        result.graph.getNode(rel.sourceId)?.label === 'Function',
    );
    expect(result.graph.getNode(String(edge?.sourceId))?.properties.filePath).toBe(
      'status/v2/status.go',
    );
  });

  it('links the handler to the service method it calls', () => {
    const calls = relationships()
      .filter((rel) => rel.type === 'CALLS')
      .map(
        (rel) =>
          `${String(result.graph.getNode(rel.sourceId)?.properties.name)} -> ${String(
            result.graph.getNode(rel.targetId)?.properties.name,
          )}`,
      );
    expect(calls).toContain('UnfinalizeRoundHandle -> UnfinalizeRound');
  });
});
