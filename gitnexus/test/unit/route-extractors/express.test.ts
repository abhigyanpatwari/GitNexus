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
 *  1. `app.get('/x', handler)` → one route, decorator='get', path='/x'.
 *  2. `app.post('/x', h1, h2)` (multiple handlers) → one route; the
 *     extractor keys off the first string argument.
 *  3. `router.METHOD('/x', h)` → one route (the extractor is name-agnostic
 *     for the receiver — app vs. router — both produce a route).
 *  4. `app.use(middleware)` (no path string) → zero routes. The extractor
 *     records a route only when a string argument is present; `use` is
 *     treated the same as `.get`/`.post` etc. in this respect. This is
 *     the documented contract; callers that need `use`-as-route can pass
 *     `app.use('/path', mw)` to get a recorded route.
 *  5. `app.use('/path', middleware)` → one route, decorator='use'.
 *  6. `app.METHOD(handler)` with a non-string first arg (e.g. an arrow
 *     function) → zero routes.
 *
 * The first-arg-must-be-string rule is intentional: it matches how the
 * production integration test fixture (`express-route-mapping`) builds
 * Route nodes only for paths that look like real endpoints.
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

  it('emits the chained .route("/path").get().post() pattern as multiple routes (CURRENTLY: only the .route call emits — see note)', () => {
    // (#M4b) Express's `app.route(path).get(h1).post(h2)` shares one
    // path string across multiple verbs. The refactored extractor's
    // header comment (express.ts:46-50) suggests this pattern is
    // handled, but the walker keys on the FIRST argument of each
    // call_expression. For `.get(g)` and `.post(c)` the first arg is
    // an identifier, not a string, so no route is recorded.
    //
    // Current behavior: only the outer `app.route('/users')` call emits
    // a single route (with `decorator: 'route'`). The chained verb
    // registrations are missed.
    //
    // This test pins that gap. The intended fix (track the shared path
    // from the parent `route(...)` call when descending into the
    // chain) is a production-code change — tracked separately.
    const code = `app.route('/users').get(g).post(c);`;
    const tree = parseJs(code);
    const routes = extractExpressRoutes(tree, 'app.js');

    // Pin current behavior — exactly one route, keyed by 'route'.
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      filePath: 'app.js',
      decorator: 'route',
      path: '/users',
    });
  });
});
