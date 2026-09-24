/**
 * End-to-end coverage of NestJS `@Controller` + `@Get`/`@Post`/`@Delete` route
 * ingestion (#3009).
 *
 * The unit suite (`test/unit/nest-decorator-routes.test.ts`) pins what the
 * extractor RETURNS. Nothing there proves the return value becomes anything:
 * the reported symptom was not a wrong `ExtractedDecoratorRoute`, it was
 * `api_impact` — whose documented job is to be run BEFORE modifying a route
 * handler — reporting every live endpoint as non-existent, because the graph
 * held no `Route` nodes at all. That is the tier this file covers: the routes
 * phase performing the prefix/path join, `claim()` in call-processor resolving
 * `handlerName` to a real symbol UID, and `prefix: null` surviving both.
 *
 * The fixture lives at `test/fixtures/nest-route-app/`, mirroring
 * `spring-route-app/` — Spring solves the identical two-decorator shape and
 * `nest.ts` is modelled on it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'nest-route-app');

// Compared against POSIX-normalized graph paths (see `routes()`), so these stay
// forward-slashed rather than going through `path.join` — the Windows shard
// would otherwise compare backslashes against the graph's forward slashes.
const CONTROLLER_FILE = 'src/venues/venues.controller.ts';
const HEALTH_FILE = 'src/health/health.controller.ts';

interface RouteView {
  /** `${method} ${url}` — the `routeNodeKey` identity, as a sortable string. */
  readonly identity: string;
  /** The handler the route resolved to, or the literal `'undefined'`. */
  readonly handler: string;
  readonly handlerLabel: string;
  readonly handlerFile: string;
}

describe('NestJS decorator route ingestion pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 120_000);

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

  const routeNodes = (): readonly GraphNode[] => nodes().filter((node) => node.label === 'Route');

  /**
   * Unresolved fields are stringified rather than branched on, so a route that
   * lost its handler reads as the literal `'undefined'` in the diff instead of
   * quietly skipping an assertion.
   */
  const routes = (): readonly RouteView[] =>
    routeNodes()
      .map((node) => {
        const handler = result.graph.getNode(String(node.properties.handlerSymbolId));
        return {
          identity: `${String(node.properties.method)} ${String(node.properties.name)}`,
          handler: String(handler?.properties.name),
          handlerLabel: String(handler?.label),
          handlerFile: String(handler?.properties.filePath).replaceAll('\\', '/'),
        };
      })
      .sort((a, b) => a.identity.localeCompare(b.identity));

  const identities = (): readonly string[] => routes().map((route) => route.identity);

  it('emits Route nodes at all — the reported symptom was zero', () => {
    // Its own case because every expectation below is satisfiable by an empty
    // graph in the ways that matter least: `not.toContain` passes vacuously on
    // an empty array, and a full-table `toEqual` against `[]` reports a missing
    // element rather than "the extractor never ran".
    expect(routeNodes().length).toBeGreaterThan(0);
  });

  it('mounts a pathless @Get() at the controller prefix WITH its handler attached', () => {
    // The reason `nest.ts` emits '/' instead of '' for a pathless decorator:
    // `claim()` short-circuits on a falsy `routePath`, so '' would still create
    // this Route node and silently drop `handlerSymbolId`. The unit test can
    // only see `routePath === '/'` at the extractor boundary; the guard being
    // load-bearing is observable here and nowhere else.
    expect(routes().find((route) => route.identity === 'GET /venues')).toEqual({
      identity: 'GET /venues',
      handler: 'findAll',
      handlerLabel: 'Method',
      handlerFile: CONTROLLER_FILE,
    });
  });

  it('joins each @Controller prefix with its method paths and resolves every handler', () => {
    // Two invariants, one table, because a projection of this assertion can
    // only fail where this one already does. The join is what the extractor
    // cannot do alone — it ships `prefix` and the routes phase folds it in via
    // `normalizeExtractedRoutePath`, so these read `/venues/search`, not
    // `search`. And `claim()` is first-writer-wins per `(method, url)`, so a
    // mis-keyed route surfaces as a handler donated to the wrong URL rather
    // than as an absence.
    expect(routes()).toEqual([
      {
        identity: 'DELETE /venues/:id',
        handler: 'remove',
        handlerLabel: 'Method',
        handlerFile: CONTROLLER_FILE,
      },
      {
        identity: 'GET /health',
        handler: 'health',
        handlerLabel: 'Method',
        handlerFile: HEALTH_FILE,
      },
      {
        identity: 'GET /venues',
        handler: 'findAll',
        handlerLabel: 'Method',
        handlerFile: CONTROLLER_FILE,
      },
      {
        identity: 'GET /venues/search',
        handler: 'search',
        handlerLabel: 'Method',
        handlerFile: CONTROLLER_FILE,
      },
      {
        identity: 'POST /venues',
        handler: 'create',
        handlerLabel: 'Method',
        handlerFile: CONTROLLER_FILE,
      },
    ]);
  });

  it('splits one URL into one Route node per verb', () => {
    // `@Get()` and `@Post()` on the same controller share a URL. `routeNodeKey`
    // makes them distinct identities; collapsing them would drop a live
    // endpoint and hand its handler to the survivor.
    expect(
      routes()
        .filter((route) => route.identity.endsWith(' /venues'))
        .map((route) => `${route.identity} -> ${route.handler}`),
    ).toEqual(['GET /venues -> findAll', 'POST /venues -> create']);
  });

  it('carries a prefix-less @Controller() through to a bare URL', () => {
    // `@Controller()` maps to `prefix: null`, and null must reach the join as
    // "no prefix" rather than as the string 'null' or a leading empty segment.
    expect(identities()).toContain('GET /health');
    expect(identities().filter((id) => id.includes('//'))).toEqual([]);
  });

  it('records per-decorator provenance on the HANDLES_ROUTE edge', () => {
    // Nest routes are DECLARED by an annotation, so they take the generic
    // `decorator-<name>` source rather than a bespoke one — the same channel
    // Spring and FastAPI use, which is the point of modelling on `spring.ts`.
    const routeIds = new Set(routeNodes().map((node) => node.id));
    expect(
      [
        ...new Set(
          relationships()
            .filter((rel) => rel.type === 'HANDLES_ROUTE' && routeIds.has(rel.targetId))
            .map((rel) => String(rel.reason)),
        ),
      ].sort(),
    ).toEqual(['decorator-Delete', 'decorator-Get', 'decorator-Post']);
  });

  describe('precision — what must NOT become a route', () => {
    // Absence assertions are satisfied just as well by a file that was never
    // read, so prove ingestion first; otherwise this whole block is decoration.
    it('ingested the unreadable-prefix controller', () => {
      expect(
        nodes()
          .filter((node) => String(node.properties.filePath ?? '').endsWith('legacy.controller.ts'))
          .map((node) => String(node.properties.name)),
      ).toEqual(expect.arrayContaining(['LegacyController', 'legacyReports']));
    });

    it('drops a controller whose prefix is not a literal', () => {
      // `@Controller(ROUTE_PREFIXES.legacy)` — the URL is unknowable, and
      // `route_map` presents its output as fact. Emitting `/reports` here would
      // be a wrong route, which is worse than a missing one.
      expect(identities().filter((id) => id.includes('reports'))).toEqual([]);
      expect(identities().filter((id) => id.includes('legacy'))).toEqual([]);
    });

    it('ingested the decorated non-controller service', () => {
      expect(
        nodes()
          .filter((node) => String(node.properties.filePath ?? '').endsWith('venues.service.ts'))
          .map((node) => String(node.properties.name)),
      ).toEqual(expect.arrayContaining(['VenuesService', 'listVenues', 'searchVenues']));
    });

    it('does not mint routes from a class with no @Controller', () => {
      // Verb decorators are believed only inside a `@Controller` class; without
      // that gate any library sharing the names would mint phantom endpoints.
      expect(routes().filter((route) => route.handlerFile.endsWith('venues.service.ts'))).toEqual(
        [],
      );
    });
  });
});
