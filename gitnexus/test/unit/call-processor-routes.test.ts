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
import { extractTrpcRoutes } from '../../src/core/ingestion/route-extractors/trpc.js';
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

function trpcCallsEdges(graph: KnowledgeGraph) {
  return graph.relationships.filter((r) => r.type === 'CALLS' && r.reason === 'trpc-route');
}

const TRPC_FILE = 'src/server/trpc/routers/user.ts';

function addFunctionNode(
  graph: KnowledgeGraph,
  id: string,
  name: string,
  filePath: string,
  startLine: number,
) {
  graph.addNode({
    id,
    label: 'Function',
    properties: { name, filePath, startLine },
  });
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

  it('route missing methodName → skipped', async () => {
    const graph = createKnowledgeGraph();
    const model = modelWithController(['index']);

    await processRoutesFromExtracted(graph, [makeRoute({ methodName: null })], model);

    expect(routeCallsEdges(graph)).toHaveLength(0);
    expect(trpcCallsEdges(graph)).toHaveLength(0);
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

describe('processRoutesFromExtracted — tRPC same-file handler CALLS edges', () => {
  it('unique same-file Function + controllerName null + methodName match → one CALLS edge reason trpc-route', async () => {
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    model.symbols.add(TRPC_FILE, 'list', 'fn:user.list', 'Function');
    addFunctionNode(graph, 'fn:user.list', 'list', TRPC_FILE, 10);

    await processRoutesFromExtracted(
      graph,
      [
        makeRoute({
          filePath: TRPC_FILE,
          controllerName: null,
          methodName: 'list',
          routePath: '/trpc/user.list',
          lineNumber: 11,
        }),
      ],
      model,
    );

    const edges = trpcCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe(generateId('File', TRPC_FILE));
    expect(edges[0].targetId).toBe('fn:user.list');
    expect(edges[0].reason).toBe('trpc-route');
    expect(edges[0].confidence).toBeCloseTo(0.5, 5);
    expect(routeCallsEdges(graph)).toHaveLength(0);
  });

  it('two multiline sibling list procedures bind both handlers when arrow starts after .mutation(', async () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      '  admin: t.router({',
      '    list: publicProcedure.mutation(',
      '      async () => {',
      '        return null;',
      '      },',
      '    ),',
      '  }),',
      '  billing: t.router({',
      '    list: publicProcedure.mutation(',
      '      async () => {',
      '        return null;',
      '      },',
      '    ),',
      '  }),',
      '});',
    ].join('\n');
    const extracted = extractTrpcRoutes(TRPC_FILE, source);
    expect(extracted.map((r) => `${r.httpMethod} ${r.routePath}`).sort()).toEqual([
      'POST /trpc/admin.list',
      'POST /trpc/billing.list',
    ]);

    const admin = extracted.find((r) => r.routePath === '/trpc/admin.list');
    const billing = extracted.find((r) => r.routePath === '/trpc/billing.list');
    expect(admin?.lineNumber).toBe(6);
    expect(billing?.lineNumber).toBe(13);

    // Graph Function startLine is 0-based on the arrow, which begins the
    // line AFTER `.mutation(` — so it cannot equal toZeroBasedLine(terminal).
    const adminStartLine = 6; // 1-based line 7
    const billingStartLine = 13; // 1-based line 14
    expect(adminStartLine).not.toBe((admin?.lineNumber ?? 0) - 1);
    expect(billingStartLine).not.toBe((billing?.lineNumber ?? 0) - 1);

    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    model.symbols.add(TRPC_FILE, 'list', 'fn:admin.list', 'Function');
    model.symbols.add(TRPC_FILE, 'list', 'fn:billing.list', 'Function');
    addFunctionNode(graph, 'fn:admin.list', 'list', TRPC_FILE, adminStartLine);
    addFunctionNode(graph, 'fn:billing.list', 'list', TRPC_FILE, billingStartLine);

    await processRoutesFromExtracted(graph, extracted, model);

    const edges = trpcCallsEdges(graph);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.targetId).sort()).toEqual(['fn:admin.list', 'fn:billing.list']);
    expect(edges.every((e) => e.reason === 'trpc-route')).toBe(true);
    expect(routeCallsEdges(graph)).toHaveLength(0);
  });

  it('two same-name Functions + matching lineNumbers → two trpc-route edges to the two node ids', async () => {
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    model.symbols.add(TRPC_FILE, 'list', 'fn:user.list#admin', 'Function');
    model.symbols.add(TRPC_FILE, 'list', 'fn:user.list#billing', 'Function');
    addFunctionNode(graph, 'fn:user.list#admin', 'list', TRPC_FILE, 10);
    addFunctionNode(graph, 'fn:user.list#billing', 'list', TRPC_FILE, 40);

    await processRoutesFromExtracted(
      graph,
      [
        makeRoute({
          filePath: TRPC_FILE,
          controllerName: null,
          methodName: 'list',
          httpMethod: 'get',
          routePath: '/trpc/admin.list',
          lineNumber: 11,
        }),
        makeRoute({
          filePath: TRPC_FILE,
          controllerName: null,
          methodName: 'list',
          httpMethod: 'get',
          routePath: '/trpc/billing.list',
          lineNumber: 41,
        }),
      ],
      model,
    );

    const edges = trpcCallsEdges(graph);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.targetId).sort()).toEqual([
      'fn:user.list#admin',
      'fn:user.list#billing',
    ]);
    expect(edges.every((e) => e.reason === 'trpc-route')).toBe(true);
  });

  it('same-name Property nearer the route line does not beat the Function handler', async () => {
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    model.symbols.add(TRPC_FILE, 'list', 'prop:user.list', 'Property');
    model.symbols.add(TRPC_FILE, 'list', 'fn:user.list', 'Function');
    graph.addNode({
      id: 'prop:user.list',
      label: 'Property',
      properties: { name: 'list', filePath: TRPC_FILE, startLine: 10 },
    });
    addFunctionNode(graph, 'fn:user.list', 'list', TRPC_FILE, 12);

    await processRoutesFromExtracted(
      graph,
      [
        makeRoute({
          filePath: TRPC_FILE,
          controllerName: null,
          methodName: 'list',
          routePath: '/trpc/user.list',
          lineNumber: 11,
        }),
      ],
      model,
    );

    const edges = trpcCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('fn:user.list');
  });

  it('two same-name Functions + routes without matching lineNumbers → zero trpc-route edges (fail-open)', async () => {
    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    model.symbols.add(TRPC_FILE, 'list', 'fn:user.list#admin', 'Function');
    model.symbols.add(TRPC_FILE, 'list', 'fn:user.list#billing', 'Function');
    addFunctionNode(graph, 'fn:user.list#admin', 'list', TRPC_FILE, 10);
    addFunctionNode(graph, 'fn:user.list#billing', 'list', TRPC_FILE, 40);

    await processRoutesFromExtracted(
      graph,
      [
        makeRoute({
          filePath: TRPC_FILE,
          controllerName: null,
          methodName: 'list',
          routePath: '/trpc/admin.list',
          lineNumber: 99,
        }),
        makeRoute({
          filePath: TRPC_FILE,
          controllerName: null,
          methodName: 'list',
          routePath: '/trpc/billing.list',
          lineNumber: 100,
        }),
      ],
      model,
    );

    expect(trpcCallsEdges(graph)).toHaveLength(0);
  });

  it('db.query inside create .input still binds POST create as trpc-route', async () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      '  create: publicProcedure.input(z.custom(async v => db.query(v))).mutation(() => null),',
      '});',
    ].join('\n');
    const extracted = extractTrpcRoutes(TRPC_FILE, source);
    expect(extracted.map((r) => `${r.httpMethod} ${r.routePath}`)).toEqual(['POST /trpc/create']);

    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    model.symbols.add(TRPC_FILE, 'create', 'fn:user.create', 'Function');
    addFunctionNode(
      graph,
      'fn:user.create',
      'create',
      TRPC_FILE,
      (extracted[0]?.lineNumber ?? 1) - 1,
    );

    await processRoutesFromExtracted(graph, extracted, model);

    const edges = trpcCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('fn:user.create');
    expect(edges[0].reason).toBe('trpc-route');
    expect(routeCallsEdges(graph)).toHaveLength(0);
  });

  it('identifier callback methodName binds the handler Function, not the procedure key', async () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      '  create: publicProcedure.mutation(handler),',
      '});',
    ].join('\n');
    const extracted = extractTrpcRoutes(TRPC_FILE, source);
    expect(extracted[0]?.methodName).toBe('handler');

    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    model.symbols.add(TRPC_FILE, 'handler', 'fn:user.handler', 'Function');
    addFunctionNode(graph, 'fn:user.handler', 'handler', TRPC_FILE, 2);

    await processRoutesFromExtracted(graph, extracted, model);

    const edges = trpcCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('fn:user.handler');
    expect(edges[0].reason).toBe('trpc-route');
  });

  it('db.transaction().query inside create .input still binds POST create as trpc-route', async () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      '  create: publicProcedure.input(v => db.transaction().query(v)).mutation(() => null),',
      '});',
    ].join('\n');
    const extracted = extractTrpcRoutes(TRPC_FILE, source);
    expect(extracted.map((r) => `${r.httpMethod} ${r.routePath}`)).toEqual(['POST /trpc/create']);

    const graph = createKnowledgeGraph();
    const model = createSemanticModel();
    model.symbols.add(TRPC_FILE, 'create', 'fn:user.create', 'Function');
    addFunctionNode(
      graph,
      'fn:user.create',
      'create',
      TRPC_FILE,
      (extracted[0]?.lineNumber ?? 1) - 1,
    );

    await processRoutesFromExtracted(graph, extracted, model);

    const edges = trpcCallsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('fn:user.create');
    expect(edges[0].reason).toBe('trpc-route');
    expect(routeCallsEdges(graph)).toHaveLength(0);
  });
});
