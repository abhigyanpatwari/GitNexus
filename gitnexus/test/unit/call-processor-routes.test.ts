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
import { createSemanticModel } from '../../src/core/ingestion/model/index.js';
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

/** A semantic model with a single OrderController class + the given methods
 *  registered in the controller's own file (so method resolution finds them
 *  via the same-file symbol-table lookup). */
function modelWithController(methods: string[]) {
  const model = createSemanticModel();
  model.symbols.add(CONTROLLER_FILE, 'OrderController', 'class:OrderController', 'Class');
  for (const m of methods) {
    model.symbols.add(CONTROLLER_FILE, m, `method:OrderController.${m}`, 'Method', {
      ownerId: 'class:OrderController',
    });
  }
  return model;
}

function routeCallsEdges(graph: KnowledgeGraph) {
  return graph.relationships.filter((r) => r.type === 'CALLS' && r.reason === 'laravel-route');
}

describe('processRoutesFromExtracted — Laravel route → controller CALLS edges', () => {
  it('resolvable controller + same-file method → one CALLS edge to the method node', async () => {
    const graph = createKnowledgeGraph();
    const model = modelWithController(['index']);

    await processRoutesFromExtracted(graph, [makeRoute({ methodName: 'index' })], model);

    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe(generateId('File', ROUTES_FILE));
    expect(edges[0].targetId).toBe('method:OrderController.index');
    // controller resolved by global class name → ROUTE_EDGE_CONFIDENCE (0.5)
    expect(edges[0].confidence).toBeCloseTo(0.5, 5);
  });

  it('resolvable controller + unknown method → CALLS edge to a guessed Method id at reduced confidence', async () => {
    const graph = createKnowledgeGraph();
    const model = modelWithController([]); // controller class only, no methods

    await processRoutesFromExtracted(graph, [makeRoute({ methodName: 'ghost' })], model);

    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe(generateId('File', ROUTES_FILE));
    expect(edges[0].targetId).toBe(generateId('Method', `${CONTROLLER_FILE}:ghost`));
    // guessed-method edges are emitted at controller-confidence × 0.8
    expect(edges[0].confidence).toBeCloseTo(0.5 * 0.8, 5);
  });

  it('unknown controller → no edge emitted', async () => {
    const graph = createKnowledgeGraph();
    const model = modelWithController(['index']);

    await processRoutesFromExtracted(
      graph,
      [makeRoute({ controllerName: 'GhostController', methodName: 'index' })],
      model,
    );

    expect(routeCallsEdges(graph)).toHaveLength(0);
  });

  it('ambiguous controller name (2+ global matches) → no edge emitted', async () => {
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    // Two distinct classes share the controller short-name in different files →
    // lookupClassByName returns >1 candidate, which the emitter refuses.
    model.symbols.add(
      'app/A/OrderController.php',
      'OrderController',
      'class:A.OrderController',
      'Class',
    );
    model.symbols.add(
      'app/B/OrderController.php',
      'OrderController',
      'class:B.OrderController',
      'Class',
    );

    await processRoutesFromExtracted(graph, [makeRoute({ methodName: 'index' })], model);

    expect(routeCallsEdges(graph)).toHaveLength(0);
  });

  it('route missing controllerName or methodName → skipped', async () => {
    const graph = createKnowledgeGraph();
    const model = modelWithController(['index']);

    await processRoutesFromExtracted(
      graph,
      [makeRoute({ controllerName: null }), makeRoute({ methodName: null })],
      model,
    );

    expect(routeCallsEdges(graph)).toHaveLength(0);
  });

  it('multiple routes to the same controller → one edge per route, distinct targets', async () => {
    const graph = createKnowledgeGraph();
    const model = modelWithController(['index', 'store']);

    await processRoutesFromExtracted(
      graph,
      [
        makeRoute({ httpMethod: 'get', routePath: '/orders', methodName: 'index' }),
        makeRoute({ httpMethod: 'post', routePath: '/orders', methodName: 'store' }),
      ],
      model,
    );

    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.targetId).sort()).toEqual([
      'method:OrderController.index',
      'method:OrderController.store',
    ]);
  });

  it('overloaded controller method → edge targets the first-registered definition', async () => {
    // Two same-name method definitions in the controller file (overloads).
    // The emitter takes lookupExactAll(...)[0] — first-registered wins, parity
    // with the legacy same-file tier which returned candidates[0]. Pins the
    // selection policy so it can't silently drift.
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    model.symbols.add(CONTROLLER_FILE, 'OrderController', 'class:OrderController', 'Class');
    model.symbols.add(CONTROLLER_FILE, 'index', 'method:OrderController.index#1', 'Method', {
      ownerId: 'class:OrderController',
    });
    model.symbols.add(CONTROLLER_FILE, 'index', 'method:OrderController.index#2', 'Method', {
      ownerId: 'class:OrderController',
    });

    await processRoutesFromExtracted(graph, [makeRoute({ methodName: 'index' })], model);

    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('method:OrderController.index#1');
  });

  it('aliased controller resolves via controllerQualifiedName → edge emitted', async () => {
    // An aliased import `use App\\Http\\Controllers\\OrderController as Orders;`
    // + `[Orders::class, 'index']` yields controllerName='Orders' but the extractor
    // also threads controllerQualifiedName='App.Http.Controllers.OrderController'
    // (the alias resolved to its FQN). The class is registered under that FQN, so
    // lookupClassByQualifiedName resolves it → edge — restoring what the legacy
    // import-scoped tier emitted (RING4-2 follow-up).
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    const FQN = 'App.Http.Controllers.OrderController';
    model.symbols.add(CONTROLLER_FILE, 'OrderController', 'class:OrderController', 'Class', {
      qualifiedName: FQN,
    });
    model.symbols.add(CONTROLLER_FILE, 'index', 'method:OrderController.index', 'Method', {
      ownerId: 'class:OrderController',
    });

    await processRoutesFromExtracted(
      graph,
      [makeRoute({ controllerName: 'Orders', controllerQualifiedName: FQN, methodName: 'index' })],
      model,
    );

    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('method:OrderController.index');
    expect(edges[0].confidence).toBeCloseTo(0.5, 5);
  });

  it('globally-duplicated short name disambiguated by controllerQualifiedName → edge to the specific controller', async () => {
    // Two OrderControllers in different namespaces share the short name. The route
    // carries the FQN of the one its `use` import selected, so the edge targets
    // that specific class's method — not the other, and not a skip.
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    const ADMIN_FQN = 'App.Admin.OrderController';
    const PUBLIC_FQN = 'App.Http.Controllers.OrderController';
    model.symbols.add(
      'app/Admin/OrderController.php',
      'OrderController',
      'class:Admin.OrderController',
      'Class',
      {
        qualifiedName: ADMIN_FQN,
      },
    );
    model.symbols.add(
      'app/Admin/OrderController.php',
      'index',
      'method:Admin.OrderController.index',
      'Method',
      {
        ownerId: 'class:Admin.OrderController',
      },
    );
    model.symbols.add(
      'app/Http/Controllers/OrderController.php',
      'OrderController',
      'class:Public.OrderController',
      'Class',
      {
        qualifiedName: PUBLIC_FQN,
      },
    );
    model.symbols.add(
      'app/Http/Controllers/OrderController.php',
      'index',
      'method:Public.OrderController.index',
      'Method',
      {
        ownerId: 'class:Public.OrderController',
      },
    );

    await processRoutesFromExtracted(
      graph,
      [
        makeRoute({
          controllerName: 'OrderController',
          controllerQualifiedName: ADMIN_FQN,
          methodName: 'index',
        }),
      ],
      model,
    );

    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('method:Admin.OrderController.index');
  });

  it('controllerQualifiedName set but no class matches → falls back to short-name resolution', async () => {
    // A stale/unmatched FQN must not block the short-name fallback when that is unique.
    const graph = createKnowledgeGraph();
    const model = modelWithController(['index']); // 'OrderController' registered, no FQN
    await processRoutesFromExtracted(
      graph,
      [
        makeRoute({
          controllerName: 'OrderController',
          controllerQualifiedName: 'App.Nonexistent.OrderController',
          methodName: 'index',
        }),
      ],
      model,
    );
    const edges = routeCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('method:OrderController.index');
  });
});
