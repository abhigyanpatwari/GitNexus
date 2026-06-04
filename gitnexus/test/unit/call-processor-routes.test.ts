/**
 * Characterization tests for `processRoutesFromExtracted` — the Laravel
 * framework-route → controller-method `CALLS`-edge emitter in
 * call-processor.ts.
 *
 * RING4-2 (#943) migrates this emitter off the legacy `ResolutionContext.resolve`
 * tiered lookup and onto the scope-resolution registry / symbol table. These
 * tests pin the *current* edge-emission behavior (which had no direct coverage)
 * so the migration is provably behavior-preserving:
 *
 *   - resolvable controller + same-file method  → CALLS edge to the method node
 *   - resolvable controller + unknown method    → CALLS edge to a *guessed* Method id
 *   - unknown controller                        → no edge
 *   - ambiguous global controller (>1 match)    → no edge
 *   - one edge emitted per route
 *
 * Confidence values captured here (controller resolves at the `global` tier for
 * routes-file → controller references, so 0.5; guessed-method edges are × 0.8)
 * are the contract the migrated implementation must match.
 */

import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { processRoutesFromExtracted } from '../../src/core/ingestion/call-processor.js';
import { generateId } from '../../src/lib/utils.js';
import type { ExtractedRoute } from '../../src/core/ingestion/route-extractors/laravel.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

const ROUTES_FILE = 'routes/web.php';
const CONTROLLER_FILE = 'app/Http/Controllers/OrderController.php';

function makeRoute(overrides: Partial<ExtractedRoute> = {}): ExtractedRoute {
  return {
    filePath: ROUTES_FILE,
    httpMethod: 'get',
    routePath: '/orders',
    routeName: null,
    controllerName: 'OrderController',
    methodName: 'index',
    middleware: [],
    prefix: null,
    lineNumber: 1,
    ...overrides,
  };
}

/** A context with a single OrderController class + the given methods registered
 *  in the controller's own file (so method resolution lands at the same-file tier). */
function ctxWithController(methods: string[]) {
  const ctx = createResolutionContext();
  ctx.model.symbols.add(CONTROLLER_FILE, 'OrderController', 'class:OrderController', 'Class');
  for (const m of methods) {
    ctx.model.symbols.add(CONTROLLER_FILE, m, `method:OrderController.${m}`, 'Method', {
      ownerId: 'class:OrderController',
    });
  }
  return ctx;
}

function routeCallsEdges(graph: KnowledgeGraph) {
  return graph.relationships.filter((r) => r.type === 'CALLS' && r.reason === 'laravel-route');
}

describe('processRoutesFromExtracted — Laravel route → controller CALLS edges', () => {
  it('resolvable controller + same-file method → one CALLS edge to the method node', async () => {
    const graph = createKnowledgeGraph();
    const ctx = ctxWithController(['index']);

    await processRoutesFromExtracted(graph, [makeRoute({ methodName: 'index' })], ctx);

    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe(generateId('File', ROUTES_FILE));
    expect(edges[0].targetId).toBe('method:OrderController.index');
    // controller resolved at the 'global' tier → TIER_CONFIDENCE.global
    expect(edges[0].confidence).toBeCloseTo(0.5, 5);
  });

  it('resolvable controller + unknown method → CALLS edge to a guessed Method id at reduced confidence', async () => {
    const graph = createKnowledgeGraph();
    const ctx = ctxWithController([]); // controller class only, no methods

    await processRoutesFromExtracted(graph, [makeRoute({ methodName: 'ghost' })], ctx);

    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe(generateId('File', ROUTES_FILE));
    expect(edges[0].targetId).toBe(generateId('Method', `${CONTROLLER_FILE}:ghost`));
    // guessed-method edges are emitted at controller-confidence × 0.8
    expect(edges[0].confidence).toBeCloseTo(0.5 * 0.8, 5);
  });

  it('unknown controller → no edge emitted', async () => {
    const graph = createKnowledgeGraph();
    const ctx = ctxWithController(['index']);

    await processRoutesFromExtracted(
      graph,
      [makeRoute({ controllerName: 'GhostController', methodName: 'index' })],
      ctx,
    );

    expect(routeCallsEdges(graph)).toHaveLength(0);
  });

  it('ambiguous controller name (2+ global matches) → no edge emitted', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();
    // Two distinct classes share the controller short-name in different files →
    // global tier returns >1 candidate, which the emitter refuses.
    ctx.model.symbols.add('app/A/OrderController.php', 'OrderController', 'class:A.OrderController', 'Class');
    ctx.model.symbols.add('app/B/OrderController.php', 'OrderController', 'class:B.OrderController', 'Class');

    await processRoutesFromExtracted(graph, [makeRoute({ methodName: 'index' })], ctx);

    expect(routeCallsEdges(graph)).toHaveLength(0);
  });

  it('route missing controllerName or methodName → skipped', async () => {
    const graph = createKnowledgeGraph();
    const ctx = ctxWithController(['index']);

    await processRoutesFromExtracted(
      graph,
      [
        makeRoute({ controllerName: null }),
        makeRoute({ methodName: null }),
      ],
      ctx,
    );

    expect(routeCallsEdges(graph)).toHaveLength(0);
  });

  it('multiple routes to the same controller → one edge per route, distinct targets', async () => {
    const graph = createKnowledgeGraph();
    const ctx = ctxWithController(['index', 'store']);

    await processRoutesFromExtracted(
      graph,
      [
        makeRoute({ httpMethod: 'get', routePath: '/orders', methodName: 'index' }),
        makeRoute({ httpMethod: 'post', routePath: '/orders', methodName: 'store' }),
      ],
      ctx,
    );

    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.targetId).sort()).toEqual([
      'method:OrderController.index',
      'method:OrderController.store',
    ]);
  });
});
