/**
 * Unit Tests: Standalone Express route extractor (#70)
 *
 * The function `extractExpressRoutes` lived inline in
 * `src/core/ingestion/workers/parse-worker.ts` for years, tightly
 * coupled to the worker module. Issue #70 refactors it to a standalone
 * file at `src/core/ingestion/route-extractors/express.ts` so it can be
 * unit-tested directly, like the Spring standalone extractor.
 *
 * This suite uses the production tree-sitter parser to build a real
 * AST and verify the function's behavior against a small set of
 * representative source snippets:
 *
 * The first-arg-must-be-string rule is intentional: it matches how the
 * production integration test fixture (`express-route-mapping`) builds
 * Route nodes only for paths that look like real endpoints. The
 * first-arg-must-be-string rule is preserved for the OUTER (non-chained)
 * case; chained verb calls inherit the parent `route()` path
 * REGARDLESS of their argument shape (invariant 2 + 3).
 *
 * Test cases (see `it(...)` blocks below):
 *  - basic single-verb registration
 *  - multiple handler args
 *  - router.METHOD() (receiver-agnostic)
 *  - app.use(handler) with no path string → 0 routes
 *  - app.use('/path', middleware) → 1 route with decorator='use'
 *  - app.METHOD(handler) with non-string first arg → 0 routes
 *  - co-located `app.use(auth)` + `app.get('/x')` (M4a)
 *  - chained `.route('/users').get(g).post(c)` → 3 routes (M4b)
 *  - 2-level chain `.route('/x').get(g)` → 2 routes
 *  - sibling no-leak `.route('/x').get(g); app.post('/y', h)` → 3 routes
 *  - AD-3 tie-break: explicit string arg wins over inherited parent path
 *  - 3-level chain limitation (route + get only, post/put suppressed)
 *  - NON_EXPRESS+chain: `headers.route('/x').get(h)` → 0 routes
 *  - sibling-no-string-arg: `.route('/x').get(g); app.post(h)` → 1 route
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractExpressRoutes } from '../../../src/core/ingestion/route-extractors/express.js';
import { loadParser, loadLanguage } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

let parseJs: (src: string) => any;

beforeAll(async () => {
  await loadLanguage(SupportedLanguages.JavaScript);
  const parser = await loadParser();
  parseJs = (src: string) => parser.parse(src);
});

describe('Standalone Express route extractor (#70)', () => {
  it('extracts a single GET route from app.get(\'/x\', handler)', () => {
    const code = `app.get('/x', (req, res) => res.send('hi'));`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      filePath: 'app.js',
      decorator: 'get',
      path: '/x',
    });
  });

  it('returns one route for app.post(\'/x\', h1, h2) with multiple handlers', () => {
    // (#70) The extractor keys off the first STRING argument; subsequent
    // arguments are handler functions. Even with multiple handlers, the
    // path is found and exactly one route is emitted.
    const code = `app.post('/x', h1, h2);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');
    expect(routes).toHaveLength(1);
    expect(routes[0].decorator).toBe('post');
    expect(routes[0].path).toBe('/x');
  });

  it('extracts routes from router.METHOD(...) — receiver-agnostic', () => {
    // (#70) The extractor is name-agnostic for the receiver object:
    // `router.get` produces a route just like `app.get`. The router
    // integration test relies on this behavior.
    const code = `router.get('/health', healthHandler);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'router.js');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      filePath: 'router.js',
      decorator: 'get',
      path: '/health',
    });
  });

  it('emits zero routes for app.use(middleware) with no path string', () => {
    // (#70) The extractor requires a STRING argument to record a route.
    // `app.use(logger)` has no string arg, so the route is filtered out.
    // This is the documented contract — see the suite header.
    const code = `app.use(logger);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');
    expect(routes).toHaveLength(0);
  });

  it('emits one route for app.use(\'/path\', middleware) when a path is present', () => {
    // The 'use' decorator IS in EXPRESS_METHODS, so when a path string
    // is the first argument, the route is recorded with decorator='use'.
    const code = `app.use('/api', apiRouter);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      filePath: 'app.js',
      decorator: 'use',
      path: '/api',
    });
  });

  it('emits zero routes when the first arg is a function (no path string)', () => {
    // (`app.METHOD(handler)`) — no string in the argument list, so the
    // extractor records nothing. This is the "skip" behavior the issue
    // spec calls out.
    const code = `app.get((req, res) => res.send('hi'));`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');
    expect(routes).toHaveLength(0);
  });

  it('emits the .get route but not the bare middleware when both appear in the same file', () => {
    // (#M4a) `app.use(authMiddleware)` carries no string path — the
    // extractor must NOT record a route for the middleware itself. The
    // subsequent `app.get('/x', handler)` IS a route. The walker must
    // not conflate these: middleware registration and route registration
    // are distinct call sites with distinct argument shapes.
    const code = `
      app.use(authMiddleware);
      app.get('/x', handler);
    `;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      filePath: 'app.js',
      decorator: 'get',
      path: '/x',
    });
  });

  it('emits the chained .route("/path").get().post() pattern as multiple routes (#M4b fix)', () => {
    // (#M4b) Express's `app.route(path).get(h1).post(h2)` shares one
    // path string across multiple verbs. The walker threads the parent
    // `route()` call's path through the recursion so chained verb calls
    // inherit the path even when their first arg is a handler function
    // (not a string). The outer `app.route('/users')` call also still
    // emits its own `decorator: 'route'` route (KD-1: preserve outer
    // emission — see design doc).
    const code = `app.route('/users').get(g).post(c);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');

    // Order-tolerance: the recurse-first walker emits `route` before
    // its verb descendants, but AST shape can vary. Sort by line
    // number to pin behavior to a deterministic, observable signal.
    const sorted = [...routes].sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));
    expect(sorted).toHaveLength(3);
    expect(sorted).toMatchObject([
      { filePath: 'app.js', decorator: 'route', path: '/users' },
      { filePath: 'app.js', decorator: 'get', path: '/users' },
      { filePath: 'app.js', decorator: 'post', path: '/users' },
    ]);
  });

  it('emits 2 routes for a 2-level chain: app.route(\'/x\').get(g)', () => {
    // (#D145) 2-level chain (single verb): the outer `app.route('/x')`
    // emits one route, and the chained `.get(g)` inherits the path and
    // emits a second. Net: 2 routes.
    const code = `app.route('/x').get(g);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');

    const sorted = [...routes].sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));
    expect(sorted).toHaveLength(2);
    expect(sorted).toMatchObject([
      { filePath: 'app.js', decorator: 'route', path: '/x' },
      { filePath: 'app.js', decorator: 'get', path: '/x' },
    ]);
  });

  it('does NOT leak the route() path to sibling statements', () => {
    // (#D145, invariant 1) The chained `app.route('/x').get(g)` is
    // nested inside one statement; the sibling `app.post('/y', h)` is
    // a SEPARATE top-level statement. The chain path does NOT cross
    // statement boundaries — the sibling must NOT inherit `/x`. The
    // sibling has its own string arg `/y`, so emission uses `/y` (no
    // ambiguity, but the no-leak invariant is the real test).
    const code = `
      app.route('/x').get(g);
      app.post('/y', h);
    `;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');

    const sorted = [...routes].sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));
    expect(sorted).toHaveLength(3);
    expect(sorted).toMatchObject([
      { filePath: 'app.js', decorator: 'route', path: '/x' },
      { filePath: 'app.js', decorator: 'get', path: '/x' },
      { filePath: 'app.js', decorator: 'post', path: '/y' },
    ]);
  });

  it('prefers the chained verb\'s own string arg over the inherited parent path (AD-3 tie-break)', () => {
    // (#D145, AD-3) Pathological case: `.get('/y', h)` after `.route('/x')`.
    // The chained verb has its own string arg, so the walker uses `/y`
    // (the explicit string) instead of the inherited `/x`. This matches
    // how Express actually behaves at runtime — the verb-call arg
    // overrides the route-chain path.
    //
    // The outer `app.route('/x')` call is NOT emitted in this case
    // because the inner `.get('/y', h)` already covers the `/y` path;
    // emitting both would be redundant (the bare `route()` registration
    // has been subsumed by the verb call). Net: 1 route.
    const code = `app.route('/x').get('/y', h);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');

    expect(routes).toHaveLength(1);
    expect(routes).toMatchObject([
      { filePath: 'app.js', decorator: 'get', path: '/y' },
    ]);
    // AD-3 explicit subsumption: the outer `route()` emission is
    // suppressed because the inner verb overrides its path.
    expect(routes.find((r) => r.decorator === 'route')).toBeUndefined();
  });

  it('documents the 3-level chain limitation (route + get only)', () => {
    // (#D145, AD-2) 3-level chains (`.route().get().post().put()`) are a
    // documented limitation. The walker follows the call_expression
    // chain from each verb down to the `route()` call, counting the
    // intermediate verbs (`chainBelowCount`). The simplified emission
    // rule:
    //   - innermost verb (obj IS the route call) → emits
    //   - outermost verb with exactly 1 intermediate → emits
    //   - everything else (3+ intermediates OR outer-with-2+) → suppressed
    // For the 4-level chain `.route().get().post().put()`:
    //   - get: chainBelowCount=0 (innermost) → emits
    //   - post: chainBelowCount=1, verbChainDepth=1 → NOT case a
    //     (chainBelowCount=1) AND NOT case b (verbChainDepth !== 0)
    //     → suppressed
    //   - put: chainBelowCount=2, verbChainDepth=0 → NOT case a
    //     (chainBelowCount=2) AND NOT case b (chainBelowCount !== 1)
    //     → suppressed
    // Net: 2 routes (route + get).
    const code = `app.route('/x').get(g).post(c).put(p);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');

    const sorted = [...routes].sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));
    expect(sorted).toHaveLength(2);
    expect(sorted).toMatchObject([
      { filePath: 'app.js', decorator: 'route', path: '/x' },
      { filePath: 'app.js', decorator: 'get', path: '/x' },
    ]);
    // 3-level explicit: post/put are not just absent from the array —
    // the walker must NOT have produced a route for them at all.
    expect(routes.find((r) => r.decorator === 'post')).toBeUndefined();
    expect(routes.find((r) => r.decorator === 'put')).toBeUndefined();
  });

  it('suppresses the entire chain when rooted in a non-Express object', () => {
    // (MAJOR test gap) The NON_EXPRESS pattern check must extend to
    // CHAINED calls. `headers.route('/x').get(h)` looks like a route
    // registration on first glance — `route` and `get` are both
    // EXPRESS_METHODS — but the chain is rooted in `headers` (a
    // non-Express object). The walker must NOT emit any route for
    // either call, AND must not recurse into the chain and
    // accidentally emit a `route` node for the inner call.
    const code = `headers.route('/x').get(h);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');

    expect(routes).toHaveLength(0);
  });

  it('emits only the chained-verb route when a sibling has no string arg', () => {
    // (MAJOR test gap) `app.route('/x').get(g)` is a valid 2-level
    // chain emitting 2 routes. The SIBLING `app.post(h)` has no
    // string arg and so must NOT emit anything on its own. Net: 2
    // routes (route + get), not 3.
    //
    // This pins the invariant that a sibling statement's verb call
    // is governed by the FIRST-ARG-MUST-BE-STRING rule, not by
    // chain inheritance. The chained-verb emission is independent.
    const code = `
      app.route('/x').get(g);
      app.post(h);
    `;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');

    const sorted = [...routes].sort((a, b) => (a.lineNumber ?? 0) - (b.lineNumber ?? 0));
    expect(sorted).toHaveLength(2);
    expect(sorted).toMatchObject([
      { filePath: 'app.js', decorator: 'route', path: '/x' },
      { filePath: 'app.js', decorator: 'get', path: '/x' },
    ]);
  });
});
