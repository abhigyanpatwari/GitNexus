/**
 * Direct unit tests for `resolveRouteHandlerSymbols` (#2138 Part 2).
 *
 * Pins the P2 fixes from the review:
 *   - ambiguity → fail-open: a same-name lookup returning ≠1 yields NO
 *     handlerSymbolId (never an arbitrary `[0]` guess).
 *   - first-writer-wins reservation: the first route to claim a route identity
 *     reserves it even when its handler is unresolvable, so a later same-identity
 *     route can't stamp its handler onto the (node-winning) first route's slot.
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
