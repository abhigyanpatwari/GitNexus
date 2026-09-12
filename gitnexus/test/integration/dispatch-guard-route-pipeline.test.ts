/**
 * End-to-end coverage of hand-rolled dispatch-guard route ingestion (R3-7).
 *
 * The reported symptom was a whole tool answering empty: `route_map` returned
 * `{"routes": [], "total": 0, "message": "No routes found in this project."}`
 * for a repo with seventeen route modules and 113 path comparisons. Every route
 * extractor before this one requires a FRAMEWORK to declare the route, and a
 * raw `node:http` server has none — it declares routes by comparing the path.
 *
 * The unit suite (`test/unit/dispatch-guard-routes.test.ts`) pins the
 * extraction rules. This one pins the parts only the pipeline can prove: that
 * the routes reach the graph as `Route` nodes, that they carry the verb and the
 * dispatch-guard provenance, and that the handler resolves to a real symbol.
 *
 * The fixture also carries a static file server whose path comparisons must NOT
 * become routes — precision is the property that matters most here, since
 * `route_map` presents its output as fact.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';
import { DISPATCH_GUARD_SOURCE } from '../../src/core/ingestion/route-extractors/dispatch-guard.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'dispatch-guard-app');

describe('hand-rolled dispatch-guard route ingestion pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  interface RouteView {
    readonly name: string;
    readonly method: string | undefined;
    readonly handlerSymbolId: string | undefined;
  }

  const routes = (): RouteView[] => {
    const out: RouteView[] = [];
    result.graph.forEachNode((n) => {
      if (n.label !== 'Route') return;
      out.push({
        name: String(n.properties.name),
        method: n.properties.method as string | undefined,
        handlerSymbolId: n.properties.handlerSymbolId as string | undefined,
      });
    });
    return out.sort((a, b) => `${a.method} ${a.name}`.localeCompare(`${b.method} ${b.name}`));
  };

  const routeNames = (): string[] => routes().map((r) => r.name);

  it('detects routes at all — the reported symptom was zero', () => {
    // Asserted as its own case because every expectation below is vacuous if
    // the pipeline emits no Route nodes; `toContain` on an empty array fails
    // with a message about the missing element, not about the empty set.
    expect(routes().length).toBeGreaterThan(0);
  });

  it('emits one Route per verb on a path dispatched by verb', () => {
    const portfolio = routes().filter((r) => r.name === '/api/live/portfolio');
    expect(portfolio.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
  });

  it('converts an anchored regex guard into a parameterised route', () => {
    expect(routeNames()).toContain('/api/live/runs/{param1}');
  });

  it('resolves the enclosing function as the route handler', () => {
    const portfolioGet = routes().find(
      (r) => r.name === '/api/live/portfolio' && r.method === 'GET',
    );
    expect(portfolioGet).toBeDefined();
    // `handle` is the object-literal method that performs the dispatch. The id
    // is asserted by shape rather than pinned, so a change to id formatting
    // does not read as a resolution failure.
    expect(portfolioGet?.handlerSymbolId).toMatch(/handle/);
  });

  // A whole route module built from a base constant. Before folding it produced
  // nothing and looked identical to a module with no routes at all.
  describe('paths composed from a same-file constant', () => {
    it('folds a template substitution through an alias into a real route', () => {
      const rules = routes().filter((r) => r.name === '/api/live/auto-trade/rules');
      expect(rules.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    });

    it('folds + concatenation of the base constant', () => {
      expect(routeNames()).toContain('/api/live/auto-trade/positions');
    });

    it('claims nothing when a substitution is a runtime value', () => {
      expect(routeNames().some((n) => n.includes('auto-trade/rules/'))).toBe(false);
    });

    it('attributes them to the composing handler', () => {
      const rule = routes().find((r) => r.name === '/api/live/auto-trade/rules');
      expect(rule?.handlerSymbolId).toMatch(/handleAutoTrade/);
    });
  });

  it('records dispatch-guard provenance on the HANDLES_ROUTE edge', () => {
    const reasons: string[] = [];
    result.graph.forEachRelationship((r) => {
      if (r.type === 'HANDLES_ROUTE') reasons.push(String(r.reason));
    });
    expect(reasons.length).toBeGreaterThan(0);
    // Not `decorator-…`: the route is INFERRED from a comparison, not DECLARED
    // by an annotation, and the map should say which.
    expect(reasons).toContain(DISPATCH_GUARD_SOURCE);
  });

  describe('precision — what the static server must NOT contribute', () => {
    // Every assertion in this block is an absence, and an absence is satisfied
    // just as well by a file that was never read. Prove it WAS read first,
    // otherwise the whole block is decoration.
    it('ingested the static server at all', () => {
      const symbols: string[] = [];
      result.graph.forEachNode((n) => {
        if (String(n.properties.filePath ?? '').endsWith('staticServer.js')) {
          symbols.push(String(n.properties.name));
        }
      });
      expect(symbols).toContain('serveStatic');
      expect(symbols).toContain('resolveCacheDir');
    });

    it('does not mint a route for the bare-"/" normalisation branch', () => {
      expect(routeNames()).not.toContain('/');
      expect(routeNames()).not.toContain('/index.html');
    });

    it('does not mint a route for a filesystem path comparison', () => {
      expect(routeNames()).not.toContain('/tmp/gitnexus-cache');
    });

    it('does not mint a route for a startsWith namespace test', () => {
      expect(routeNames()).not.toContain('/api/');
      expect(routeNames()).not.toContain('/api');
    });

    it('does not mint a route for an inequality comparison', () => {
      expect(routeNames()).not.toContain('/api/live/health');
    });
  });

  // The reconciliation that per-file logic cannot do. `apiRouteTable.js` is a
  // membership test in a SEPARATE file from the handlers, so from inside either
  // file alone both halves look like routes; only the whole registry can tell
  // that `/api/live/events` is one route, not two.
  describe('cross-file reconciliation of the split route table', () => {
    const byName = (name: string) => routes().filter((r) => r.name === name);

    it('drops the table entry when a handler file claims the URL with a verb', () => {
      expect(byName('/api/live/events').map((r) => r.method)).toEqual(['GET']);
      expect(
        byName('/api/live/portfolio')
          .map((r) => r.method)
          .sort(),
      ).toEqual(['GET', 'POST']);
    });

    it('keeps a table entry no handler claims with a verb', () => {
      // `/api/live/config` exists only in the table. Dropping it would trade a
      // duplicate for a missing route.
      expect(byName('/api/live/config').map((r) => r.method)).toEqual([undefined]);
    });

    it('attributes the surviving route to the handler file, not the table', () => {
      const events = byName('/api/live/events')[0];
      expect(events?.handlerSymbolId).toMatch(/handle/);
    });
  });
});
