/**
 * Direct unit tests for `resolveRouteHandlerSymbols` (#2138 Part 2).
 *
 * Pins the P2 fixes from the review:
 *   - ambiguity → fail-open: a same-name lookup returning ≠1 yields NO
 *     handlerSymbolId (never an arbitrary `[0]` guess).
 *   - first-writer-wins reservation: the first route to claim a URL reserves it
 *     even when its handler is unresolvable, so a later same-URL route can't
 *     stamp its handler onto the (node-winning) first route's slot.
 *   - happy path: a uniquely-resolvable handler is stamped, keyed by the
 *     normalized URL.
 */
import { describe, it, expect } from 'vitest';
import { createSemanticModel } from '../../src/core/ingestion/model/index.js';
import { resolveRouteHandlerSymbols } from '../../src/core/ingestion/call-processor.js';
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
  it('uniquely-resolvable handler is stamped, keyed by normalized URL', () => {
    const model = createSemanticModel();
    model.symbols.add(FILE, 'list', 'method:OrderController.list', 'Method');

    const out = resolveRouteHandlerSymbols(model, [], [decoratorRoute()]);

    expect(out.get('/orders')).toBe('method:OrderController.list');
  });

  it('ambiguous same-name handler (overloads) → fail-open, no stamp', () => {
    const model = createSemanticModel();
    // Two same-(file,name) defs → lookupExactAll returns 2 → refuse to guess.
    model.symbols.add(FILE, 'list', 'method:OrderController.list#1', 'Method');
    model.symbols.add(FILE, 'list', 'method:OrderController.list#2', 'Method');

    const out = resolveRouteHandlerSymbols(model, [], [decoratorRoute()]);

    expect(out.has('/orders')).toBe(false);
  });

  it('unknown handler name → fail-open, no stamp', () => {
    const model = createSemanticModel(); // nothing registered

    const out = resolveRouteHandlerSymbols(model, [], [decoratorRoute({ handlerName: 'ghost' })]);

    expect(out.has('/orders')).toBe(false);
  });

  it('same-URL collision: an unresolvable first route reserves the slot so a later resolvable route cannot stamp it', () => {
    const model = createSemanticModel();
    // Only the SECOND route's handler exists in the model.
    model.symbols.add(FILE, 'second', 'method:OrderController.second', 'Method');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [
        // First route at /orders is unresolvable (no such symbol) — but it is the
        // route the routes phase makes the Route-node winner, so its slot must be
        // reserved (empty), NOT filled by the later same-URL route.
        decoratorRoute({ handlerName: 'first_missing' }),
        decoratorRoute({ handlerName: 'second' }),
      ],
    );

    // Reservation holds: the URL carries no (wrong) handler. Pre-fix this would
    // have stamped `method:OrderController.second` onto the first route's node.
    expect(out.has('/orders')).toBe(false);
  });

  it('first-writer-wins among resolvable same-URL routes', () => {
    const model = createSemanticModel();
    model.symbols.add(FILE, 'winner', 'method:OrderController.winner', 'Method');
    model.symbols.add(FILE, 'loser', 'method:OrderController.loser', 'Method');

    const out = resolveRouteHandlerSymbols(
      model,
      [],
      [decoratorRoute({ handlerName: 'winner' }), decoratorRoute({ handlerName: 'loser' })],
    );

    expect(out.get('/orders')).toBe('method:OrderController.winner');
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

    expect(out.get('/orders')).toBe('method:OrderController.index');
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

    expect(out.has('/orders')).toBe(false);
  });
});
