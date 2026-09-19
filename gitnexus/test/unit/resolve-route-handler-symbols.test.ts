/**
 * Direct unit tests for `resolveRouteHandlerSymbols` (#2138 Part 2).
 *
 * Pins the P2 fixes from the review:
 *   - ambiguity → fail-open: a same-name lookup returning ≠1 yields NO
 *     handlerSymbolId (never an arbitrary `[0]` guess).
 *   - first-writer-wins reservation: ordinary route declarations reserve an
 *     identity even when unresolved; unproven data-table entries do not because
 *     the routes phase suppresses them entirely.
 *   - happy path: a uniquely-resolvable handler is stamped, keyed by the route's
 *     `(method, url)` identity (`routeNodeKey`).
 *   - multi-verb identity (#2289): `GET /x` and `POST /x` are distinct keys, so
 *     each verb's handler is resolved independently.
 */
import { describe, it, expect } from 'vitest';
import { createSemanticModel } from '../../src/core/ingestion/model/index.js';
import { resolveRouteHandlerSymbols } from '../../src/core/ingestion/call-processor.js';
import { routeNodeKey } from '../../src/core/ingestion/route-extractors/route-path.js';
import type { ExtractedDecoratorRoute } from '../../src/core/ingestion/workers/parse-worker.js';
import type { ExtractedRoute } from '../../src/core/ingestion/route-extractors/laravel.js';
import { DATA_ROUTE_TABLE_SOURCE } from '../../src/core/ingestion/route-extractors/data-route-table.js';

const FILE = 'src/OrderController.java';

function decoratorRoute(overrides: Partial<ExtractedDecoratorRoute> = {}): ExtractedDecoratorRoute {
  return {
    filePath: FILE,
    routePath: '/orders',
    httpMethod: 'GET',
    decoratorName: 'GetMapping',
    lineNumber: 1,
    handlerName: 'list',
    ...overrides,
  };
}

describe('resolveRouteHandlerSymbols — decorator routes', () => {
  const GET_ORDERS = routeNodeKey('GET', '/orders');

  it('uniquely-resolvable handler is stamped, keyed by (method, url) identity', () => {
    const model = createSemanticModel();
    model.symbols.add(FILE, 'list', 'method:OrderController.list', 'Method');

    const out = resolveRouteHandlerSymbols(model, [], [decoratorRoute()]);

    expect(out.get(GET_ORDERS)).toBe('method:OrderController.list');
  });

  it('ambiguous same-name handler (overloads) → fail-open, no stamp', () => {
    const model = createSemanticModel();
    // Two same-(file,name) defs → lookupExactAll returns 2 → refuse to guess.
    model.symbols.add(FILE, 'list', 'method:OrderController.list#1', 'Method');
    model.symbols.add(FILE, 'list', 'method:OrderController.list#2', 'Method');

    const out = resolveRouteHandlerSymbols(model, [], [decoratorRoute()]);

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('unknown handler name → fail-open, no stamp', () => {
    const model = createSemanticModel(); // nothing registered

    const out = resolveRouteHandlerSymbols(model, [], [decoratorRoute({ handlerName: 'ghost' })]);

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('treats an empty routePath as a valid root route when resolving its handler', () => {
    const model = createSemanticModel();
    model.symbols.add(FILE, 'root', 'method:OrderController.root', 'Method');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [decoratorRoute({ routePath: '', handlerName: 'root' })],
    );

    expect(out.get(routeNodeKey('GET', '/'))).toBe('method:OrderController.root');
  });

  it('same-identity collision: an unresolvable first route reserves the slot so a later resolvable route cannot stamp it', () => {
    const model = createSemanticModel();
    // Only the SECOND route's handler exists in the model.
    model.symbols.add(FILE, 'second', 'method:OrderController.second', 'Method');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        // First route at GET /orders is unresolvable (no such symbol) — but it is
        // the route the routes phase makes the Route-node winner, so its slot must
        // be reserved (empty), NOT filled by the later same-identity route.
        decoratorRoute({ handlerName: 'first_missing' }),
        decoratorRoute({ handlerName: 'second' }),
      ],
    );

    // Reservation holds: the identity carries no (wrong) handler. Pre-fix this
    // would have stamped `method:OrderController.second` onto the first node.
    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('first-writer-wins among resolvable same-identity routes', () => {
    const model = createSemanticModel();
    model.symbols.add(FILE, 'winner', 'method:OrderController.winner', 'Method');
    model.symbols.add(FILE, 'loser', 'method:OrderController.loser', 'Method');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [decoratorRoute({ handlerName: 'winner' }), decoratorRoute({ handlerName: 'loser' })],
    );

    expect(out.get(GET_ORDERS)).toBe('method:OrderController.winner');
  });

  it('multi-verb same URL (#2289): GET /orders and POST /orders resolve to distinct keys', () => {
    const model = createSemanticModel();
    model.symbols.add(FILE, 'list', 'method:OrderController.list', 'Method');
    model.symbols.add(FILE, 'create', 'method:OrderController.create', 'Method');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({ httpMethod: 'GET', handlerName: 'list' }),
        decoratorRoute({ httpMethod: 'POST', decoratorName: 'PostMapping', handlerName: 'create' }),
      ],
    );

    // Two independent identities — neither evicts the other (the pre-#2289
    // URL-only key would have dropped POST /orders as a duplicate of GET /orders).
    expect(out.get(routeNodeKey('GET', '/orders'))).toBe('method:OrderController.list');
    expect(out.get(routeNodeKey('POST', '/orders'))).toBe('method:OrderController.create');
  });

  it('data-table bare handlers resolve in their lexical file', () => {
    const model = createSemanticModel();
    model.symbols.add('src/routes.js', 'list', 'function:list', 'Function');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'list',
        }),
      ],
    );

    expect(out.get(GET_ORDERS)).toBe('function:list');
  });

  it('data-table named imports resolve only exported callables', () => {
    const model = createSemanticModel();
    const exported = model.symbols.add(
      'src/handlers.js',
      'listUsers',
      'function:listUsers',
      'Function',
    );

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'handleUsers',
        }),
      ],
      {
        files: [
          {
            filePath: 'src/routes.js',
            localDefs: [],
            parsedImports: [
              {
                kind: 'named',
                localName: 'handleUsers',
                importedName: 'listUsers',
                targetRaw: './handlers.js',
              },
            ],
          },
        ],
        resolveImportTarget: () => 'src/handlers.js',
        isExportedSymbol: (nodeId) => nodeId === exported.nodeId,
      },
    );

    expect(out.get(GET_ORDERS)).toBe(exported.nodeId);
  });

  it('data-table named imports reject private callables', () => {
    const model = createSemanticModel();
    model.symbols.add('src/handlers.js', 'listUsers', 'function:listUsers', 'Function');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'handleUsers',
        }),
      ],
      {
        files: [
          {
            filePath: 'src/routes.js',
            localDefs: [],
            parsedImports: [
              {
                kind: 'named',
                localName: 'handleUsers',
                importedName: 'listUsers',
                targetRaw: './handlers.js',
              },
            ],
          },
        ],
        resolveImportTarget: () => 'src/handlers.js',
        isExportedSymbol: () => false,
      },
    );

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('data-table named-import members reject private owners', () => {
    const model = createSemanticModel();
    const owner = model.symbols.add('src/handlers.js', 'auth', 'object:auth', 'Variable');
    model.methods.register(owner.nodeId, 'getCurrentUser', {
      filePath: 'src/handlers.js',
      name: 'getCurrentUser',
      nodeId: 'method:auth.getCurrentUser',
      type: 'Method',
      ownerId: owner.nodeId,
    });

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'authService.getCurrentUser',
        }),
      ],
      {
        files: [
          {
            filePath: 'src/routes.js',
            localDefs: [],
            parsedImports: [
              {
                kind: 'named',
                localName: 'authService',
                importedName: 'auth',
                targetRaw: './handlers.js',
              },
            ],
          },
        ],
        resolveImportTarget: () => 'src/handlers.js',
        isExportedSymbol: () => false,
      },
    );

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('data-table members resolve through their proven same-file owner', () => {
    const model = createSemanticModel();
    model.symbols.add('src/routes.js', 'auth', 'object:auth', 'Variable');
    model.methods.register('object:auth', 'getCurrentUser', {
      filePath: 'src/routes.js',
      name: 'getCurrentUser',
      nodeId: 'method:auth.getCurrentUser',
      type: 'Method',
      ownerId: 'object:auth',
    });

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'auth.getCurrentUser',
        }),
      ],
    );

    expect(out.get(GET_ORDERS)).toBe('method:auth.getCurrentUser');
  });

  it('data-table members refuse an unrelated terminal-name decoy', () => {
    const model = createSemanticModel();
    model.symbols.add('src/routes.js', 'getCurrentUser', 'function:decoy', 'Function');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'externalAuth.getCurrentUser',
        }),
      ],
    );

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('data-table members suppress unsupported multi-level receiver chains', () => {
    const model = createSemanticModel();
    model.symbols.add('src/routes.js', 'services', 'object:services', 'Variable');
    model.methods.register('object:services', 'getCurrentUser', {
      filePath: 'src/routes.js',
      name: 'getCurrentUser',
      nodeId: 'method:decoy',
      type: 'Method',
      ownerId: 'object:services',
    });

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'services.auth.getCurrentUser',
        }),
      ],
    );

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('an unresolved data-table entry does not reserve a valid framework route identity', () => {
    const model = createSemanticModel();
    model.symbols.add(FILE, 'list', 'method:OrderController.list', 'Method');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'missing.handler',
        }),
        decoratorRoute({ handlerName: 'list' }),
      ],
    );

    expect(out.get(GET_ORDERS)).toBe('method:OrderController.list');
  });

  it('an unresolved data-table duplicate suppresses the route identity', () => {
    const model = createSemanticModel();
    model.symbols.add('src/routes.js', 'second', 'function:second', 'Function');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'missing',
        }),
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'second',
        }),
      ],
    );

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('different resolvable handlers for one data-table identity are suppressed', () => {
    const model = createSemanticModel();
    model.symbols.add('src/routes.js', 'first', 'function:first', 'Function');
    model.symbols.add('src/routes.js', 'second', 'function:second', 'Function');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'first',
        }),
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'second',
        }),
      ],
    );

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('fails closed for default imports even when the target file has an exported callable', () => {
    const model = createSemanticModel();
    const exported = model.symbols.add(
      'src/handlers.js',
      'listUsers',
      'function:listUsers',
      'Function',
    );
    const privateHelper = model.symbols.add(
      'src/handlers.js',
      'helper',
      'function:helper',
      'Function',
    );

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'handleUsers',
        }),
      ],
      {
        files: [
          {
            filePath: 'src/routes.js',
            localDefs: [],
            parsedImports: [
              {
                kind: 'alias',
                localName: 'handleUsers',
                importedName: 'default',
                alias: 'handleUsers',
                targetRaw: './handlers.js',
              },
            ],
          },
          {
            filePath: 'src/handlers.js',
            localDefs: [exported, privateHelper],
            parsedImports: [],
          },
        ],
        resolveImportTarget: () => 'src/handlers.js',
        isExportedSymbol: (nodeId) => nodeId === exported.nodeId,
      },
    );

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('does not infer a barrel helper as a default re-export target', () => {
    const model = createSemanticModel();
    const helper = model.symbols.add('src/barrel.js', 'helper', 'function:helper', 'Function');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        decoratorRoute({
          filePath: 'src/routes.js',
          source: DATA_ROUTE_TABLE_SOURCE,
          handlerName: 'handleUsers',
        }),
      ],
      {
        files: [
          {
            filePath: 'src/routes.js',
            localDefs: [],
            parsedImports: [
              {
                kind: 'alias',
                localName: 'handleUsers',
                importedName: 'default',
                alias: 'handleUsers',
                targetRaw: './barrel.js',
              },
            ],
          },
          {
            filePath: 'src/barrel.js',
            localDefs: [{ ...helper, nodeId: 'def:helper', qualifiedName: 'helper' }],
            parsedImports: [
              {
                kind: 'named',
                localName: 'default',
                importedName: 'default',
                targetRaw: './actual.js',
              },
            ],
          },
        ],
        resolveImportTarget: (parsedImport) =>
          parsedImport.targetRaw === './barrel.js' ? 'src/barrel.js' : 'src/actual.js',
        isExportedSymbol: (nodeId) => nodeId === helper.nodeId,
      },
    );

    expect(out.has(GET_ORDERS)).toBe(false);
  });

  it('ordinary decorator routes do not gain the repo-wide fallback', () => {
    const model = createSemanticModel();
    model.symbols.add('src/other.js', 'list', 'function:other.list', 'Function');

    const out = resolveRouteHandlerSymbols(model, [], [decoratorRoute()]);

    expect(out.has(GET_ORDERS)).toBe(false);
  });
});

describe('resolveRouteHandlerSymbols — Laravel framework routes', () => {
  const CTRL = 'app/Http/Controllers/OrderController.php';

  function laravelRoute(overrides: Partial<ExtractedRoute> = {}): ExtractedRoute {
    return {
      filePath: 'routes/web.php',
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

  it('resolvable controller + unique method → stamped', () => {
    const model = createSemanticModel();
    model.symbols.add(CTRL, 'OrderController', 'class:OrderController', 'Class');
    model.symbols.add(CTRL, 'index', 'method:OrderController.index', 'Method', {
      ownerId: 'class:OrderController',
    });

    const out = resolveRouteHandlerSymbols(model, [laravelRoute()], []);

    expect(out.get(routeNodeKey('GET', '/orders'))).toBe('method:OrderController.index');
  });

  it('ambiguous controller short-name (>1) → fail-open, no stamp', () => {
    const model = createSemanticModel();
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

    const out = resolveRouteHandlerSymbols(model, [laravelRoute()], []);

    expect(out.has(routeNodeKey('GET', '/orders'))).toBe(false);
  });
});
