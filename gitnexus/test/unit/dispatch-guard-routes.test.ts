/**
 * Hand-rolled dispatch-guard route extraction.
 *
 * The gap this closes is a whole TOOL answering empty: `route_map` reported
 * "No routes found in this project" for a repo with seventeen route modules,
 * because every route extractor before this one needs a framework to declare
 * the route. A raw `node:http` server declares it by comparing the path.
 *
 * The bar here is precision, not recall — `route_map` presents its output as
 * fact, so a route that does not exist is worse than a route that is missing.
 * Roughly half of these cases are therefore assertions that something is NOT
 * extracted.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  extractDispatchGuardRoutes,
  reconcileDispatchGuardRoutes,
  regexToRoutePath,
  DISPATCH_GUARD_SOURCE,
} from '../../src/core/ingestion/route-extractors/dispatch-guard.js';

const parser = new Parser();
parser.setLanguage(JavaScript);

const extract = (source: string, filePath = 'src/server/routes.js') =>
  extractDispatchGuardRoutes(parser.parse(source), filePath).map((r) => ({
    routePath: r.routePath,
    httpMethod: r.httpMethod,
    handlerName: r.handlerName,
    source: r.source,
  }));

const paths = (source: string): string[] => extract(source).map((r) => r.routePath);

describe('dispatch-guard route extraction', () => {
  describe('the dominant idiom', () => {
    it('extracts a verb-qualified path comparison', () => {
      const routes = extract(`
        export async function handle(req, res, reqCtx) {
          const { pathname } = reqCtx
          if (req.method === 'GET' && pathname === '/api/live/portfolio') {
            return sendJson(res, await loadPortfolio())
          }
        }
      `);
      expect(routes).toEqual([
        {
          routePath: '/api/live/portfolio',
          httpMethod: 'GET',
          handlerName: 'handle',
          source: DISPATCH_GUARD_SOURCE,
        },
      ]);
    });

    it('reads the verb when the comparison order is reversed', () => {
      expect(
        extract(`
          function handle(req) {
            if ('POST' === req.method && '/api/orders' === pathname) { return 1 }
          }
        `),
      ).toMatchObject([{ routePath: '/api/orders', httpMethod: 'POST' }]);
    });

    it('distributes an outer verb across an inner OR of paths', () => {
      const routes = extract(`
        function handle(req) {
          if (req.method === 'GET' && (pathname === '/api/a' || pathname === '/api/b')) { return 1 }
        }
      `);
      expect(routes).toMatchObject([
        { routePath: '/api/a', httpMethod: 'GET' },
        { routePath: '/api/b', httpMethod: 'GET' },
      ]);
    });

    it('inherits a verb from an ENCLOSING if, not just a sibling', () => {
      expect(
        extract(`
          function handle(req) {
            if (req.method === 'DELETE') {
              if (pathname === '/api/session') { return 1 }
            }
          }
        `),
      ).toMatchObject([{ routePath: '/api/session', httpMethod: 'DELETE' }]);
    });

    // The inverted case, and the reason the ancestor walk tracks which branch it
    // came from: in the `else`, the method is precisely NOT POST, so inheriting
    // POST would label the route with the one verb it cannot have.
    it('refuses to inherit a verb from an if whose ELSE branch holds the comparison', () => {
      const routes = extract(`
        function handle(req) {
          if (req.method === 'POST') {
            save()
          } else if (pathname === '/api/report') {
            return 1
          }
        }
      `);
      expect(routes).toMatchObject([{ routePath: '/api/report', httpMethod: '' }]);
    });

    it('extracts a verb-less path guard', () => {
      expect(
        extract(`
          function match(method, pathname) {
            return pathname === '/api/health'
          }
        `),
      ).toMatchObject([{ routePath: '/api/health', httpMethod: '', handlerName: 'match' }]);
    });
  });

  describe('what must NOT become a route', () => {
    it('ignores a comparison against something that is not a request path', () => {
      // `mode` is not a path expression, so `/full` is just a string.
      expect(paths(`function f() { if (mode === '/full') { return 1 } }`)).toEqual([]);
    });

    it('ignores a path-shaped literal compared to a filesystem path variable', () => {
      // `path` is excluded on purpose — in Node it is overwhelmingly node:path
      // or a file location, never the request path.
      expect(paths(`function f() { if (path === '/tmp/cache') { return 1 } }`)).toEqual([]);
    });

    it('ignores startsWith namespace tests', () => {
      // A prefix test asks "do I own this?" — minting `/api/` would claim a
      // route nothing serves.
      expect(
        paths(`function f() { if (pathname.startsWith('/api/')) { return route(pathname) } }`),
      ).toEqual([]);
    });

    it('ignores a bare "/" normalisation with no verb', () => {
      // The static-file idiom, verbatim from the reporting repo.
      expect(
        paths(`function serve() { const file = pathname === '/' ? '/index.html' : pathname }`),
      ).toEqual([]);
    });

    it('DOES extract a bare "/" when a verb makes the intent unambiguous', () => {
      expect(
        extract(
          `function handle(req) { if (req.method === 'GET' && pathname === '/') { return 1 } }`,
        ),
      ).toMatchObject([{ routePath: '/', httpMethod: 'GET' }]);
    });

    it('ignores a non-equality comparison', () => {
      expect(paths(`function f() { if (pathname !== '/api/health') { return 1 } }`)).toEqual([]);
    });

    it('ignores an absolute URL', () => {
      expect(
        paths(`function f() { if (pathname === 'https://x.test/api/a') { return 1 } }`),
      ).toEqual([]);
    });

    it('ignores a template string whose substitution is not a known constant', () => {
      expect(paths('function f() { if (pathname === `/api/${id}`) { return 1 } }')).toEqual([]);
    });

    it('ignores a verb literal that is not an HTTP verb', () => {
      const routes = extract(`
        function handle(req) {
          if (req.method === 'SUBSCRIBE' && pathname === '/api/feed') { return 1 }
        }
      `);
      expect(routes).toMatchObject([{ routePath: '/api/feed', httpMethod: '' }]);
    });
  });

  // BOOLEAN POLARITY. The module refuses to inherit a verb from an `if` whose
  // `else` branch holds the comparison, because that branch runs precisely when
  // the condition did NOT hold. `!` is the same fact written as an operator, and
  // it was not handled — a stated invariant with half an implementation, which
  // is worse than an absent one because the doc comment reads as covered.
  //
  // Every case below was reproduced against the unguarded extractor before the
  // fix: `!(path)` INVENTED a route, and `!(verb) && path` emitted the one verb
  // the branch guarantees the request does not have.
  describe('negated conditions', () => {
    it('claims nothing when the path comparison is negated', () => {
      expect(paths(`function h(req) { if (!(pathname === '/api/admin')) { return 1 } }`)).toEqual(
        [],
      );
    });

    it('claims nothing when the whole guard is negated', () => {
      expect(
        paths(
          `function h(req) { if (!(req.method === 'POST' && pathname === '/api/w')) { return 1 } }`,
        ),
      ).toEqual([]);
    });

    it('keeps the path but drops a NEGATED verb rather than inverting it', () => {
      // The path is still evidence — this branch is reached for `/api/x`. The
      // verb is not: `!(method === 'GET')` says every method EXCEPT GET, which
      // no single value can express, so the honest answer is verb-less.
      expect(
        extract(
          `function h(req) { if (!(req.method === 'GET') && pathname === '/api/x') { return 1 } }`,
        ),
      ).toMatchObject([{ routePath: '/api/x', httpMethod: '' }]);
    });

    it('treats double negation as positive', () => {
      // PARITY, not presence. A rule keyed on "is there a `!` above me" would
      // refuse this, which is a real route.
      expect(paths(`function h(req) { if (!!(pathname === '/api/z')) { return 1 } }`)).toEqual([
        '/api/z',
      ]);
    });

    it('does not let an outer negation leak into the branch BODY', () => {
      // Polarity is a property of the expression, not of the statements a branch
      // contains: the inner comparison is positive where it is written.
      expect(
        paths(`
          function h(req) {
            if (!(req.method === 'GET')) {
              if (pathname === '/api/inner') { return 1 }
            }
          }
        `),
      ).toEqual(['/api/inner']);
    });

    it('negates a regex path test too', () => {
      expect(
        paths(`function h(req) { if (!/^\\/api\\/runs\\/[^/]+$/.test(pathname)) { return 1 } }`),
      ).toEqual([]);
    });
  });

  // Not in any report — the same dispatch written with different syntax. A
  // graph that waits for a bug report per shape stays permanently one idiom
  // behind the code it indexes.
  describe('switch dispatch', () => {
    it('extracts every string-literal case of a switch on the path', () => {
      expect(
        extract(`
          function handle(req, pathname) {
            switch (pathname) {
              case '/api/health': return ok()
              case '/api/version': return version()
              default: return notFound()
            }
          }
        `),
      ).toMatchObject([
        { routePath: '/api/health', httpMethod: '', handlerName: 'handle' },
        { routePath: '/api/version', httpMethod: '', handlerName: 'handle' },
      ]);
    });

    it('applies a verb governing the whole switch to every arm', () => {
      expect(
        extract(`
          function handle(req, pathname) {
            if (req.method === 'POST') {
              switch (pathname) {
                case '/api/a': return a()
                case '/api/b': return b()
              }
            }
          }
        `),
      ).toMatchObject([
        { routePath: '/api/a', httpMethod: 'POST' },
        { routePath: '/api/b', httpMethod: 'POST' },
      ]);
    });

    it('ignores a switch on something that is not a request path', () => {
      // The file must mention a path token, or PATH_TOKEN_HINT skips it before
      // the discriminant rule is ever consulted and this asserts nothing. The
      // real route below is the proof the walk ran.
      expect(
        paths(`
          function f(kind, pathname) {
            switch (kind) { case '/full': return 1 }
            if (pathname === '/api/real') { return 2 }
          }
        `),
      ).toEqual(['/api/real']);
    });

    it('ignores non-path cases in a switch that is on the path', () => {
      expect(
        paths(`
          function handle(pathname) {
            switch (pathname) {
              case '/api/a': return 1
              case 'unknown': return 2
            }
          }
        `),
      ).toEqual(['/api/a']);
    });
  });

  // A composed path is not an exotic shape — one of the reporting repo's
  // seventeen route modules writes every one of its ~20 routes this way, and
  // without folding that file contributes NOTHING while looking exactly like a
  // file that has no routes.
  describe('paths composed from same-file constants', () => {
    it('folds a template substitution naming a module-level constant', () => {
      expect(
        extract(
          'const BASE = "/api/live/auto-trade"\n' +
            'function handle(req) {\n' +
            '  if (req.method === "GET" && pathname === `${BASE}/rules`) { return 1 }\n' +
            '}',
        ),
      ).toMatchObject([{ routePath: '/api/live/auto-trade/rules', httpMethod: 'GET' }]);
    });

    it('follows an alias hop, which is how the reporting repo writes it', () => {
      // `const autoTradeBasePath = AUTO_TRADE_BASE_PATH` inside the handler,
      // with the literal at module scope.
      expect(
        paths(
          'const AUTO_TRADE_BASE_PATH = "/api/live/auto-trade"\n' +
            'function handle(req) {\n' +
            '  const autoTradeBasePath = AUTO_TRADE_BASE_PATH\n' +
            '  if (pathname === `${autoTradeBasePath}/positions`) { return 1 }\n' +
            '}',
        ),
      ).toEqual(['/api/live/auto-trade/positions']);
    });

    it('folds + concatenation', () => {
      expect(
        paths(
          'const BASE = "/api/v2"\n' +
            'function handle() { if (pathname === BASE + "/orders") { return 1 } }',
        ),
      ).toEqual(['/api/v2/orders']);
    });

    it('folds a bare constant with no suffix', () => {
      expect(
        paths(
          'const HEALTH = "/api/health"\nfunction handle() { if (pathname === HEALTH) { return 1 } }',
        ),
      ).toEqual(['/api/health']);
    });

    // The refusals. A partially-folded path is a WRONG route, and a wrong route
    // is worse than a missing one — the whole premise of this module.
    it('refuses a name declared twice with different values', () => {
      expect(
        paths(
          'const BASE = "/api/a"\n' +
            'function other() { const BASE = "/api/b"; return BASE }\n' +
            'function handle() { if (pathname === `${BASE}/x`) { return 1 } }',
        ),
      ).toEqual([]);
    });

    it('refuses when only part of the template resolves', () => {
      expect(
        paths(
          'const BASE = "/api"\n' +
            'function handle(id) { if (pathname === `${BASE}/x/${id}`) { return 1 } }',
        ),
      ).toEqual([]);
    });

    it('refuses a constant bound to a call result', () => {
      expect(
        paths(
          'const BASE = buildBase()\nfunction handle() { if (pathname === `${BASE}/x`) { return 1 } }',
        ),
      ).toEqual([]);
    });

    it('still rejects a folded value that is not path-shaped', () => {
      expect(
        paths(
          'const MODE = "full"\nfunction handle() { if (pathname === `${MODE}/x`) { return 1 } }',
        ),
      ).toEqual([]);
    });
  });

  describe('parameterised routes from anchored regexes', () => {
    it('converts a single-segment wildcard to a named parameter', () => {
      expect(
        extract(`
          function handle(req) {
            if (req.method === 'GET' && /^\\/api\\/research-runs\\/[^/]+$/.test(pathname)) { return 1 }
          }
        `),
      ).toMatchObject([{ routePath: '/api/research-runs/{param1}', httpMethod: 'GET' }]);
    });

    it('numbers multiple parameters in order', () => {
      expect(regexToRoutePath('^\\/api\\/runs\\/[^/]+\\/experiments\\/[^/]+$')).toBe(
        '/api/runs/{param1}/experiments/{param2}',
      );
    });

    it('accepts an escaped slash inside the wildcard class', () => {
      expect(regexToRoutePath('^\\/api\\/x\\/[^\\/]+$')).toBe('/api/x/{param1}');
    });

    // Bail cases. A route path is a claim about what the server serves, so a
    // pattern that cannot be translated exactly is dropped, not approximated.
    it('refuses an unanchored pattern', () => {
      expect(regexToRoutePath('\\/api\\/x')).toBeNull();
      expect(regexToRoutePath('^\\/api\\/x')).toBeNull();
    });

    it('refuses an optional group', () => {
      expect(regexToRoutePath('^\\/api\\/runs\\/[^/]+\\/artifacts(?:\\/.*)?$')).toBeNull();
    });

    it('refuses an alternation and a bare wildcard', () => {
      expect(regexToRoutePath('^\\/api\\/(a|b)$')).toBeNull();
      expect(regexToRoutePath('^\\/api\\/.*$')).toBeNull();
    });

    it('refuses a character-class escape', () => {
      expect(regexToRoutePath('^\\/api\\/runs\\/\\d+$')).toBeNull();
    });

    it('ignores a regex tested against something that is not a request path', () => {
      expect(paths(`function f() { if (/^\\/api\\/x$/.test(filename)) { return 1 } }`)).toEqual([]);
    });
  });

  describe('handler attribution', () => {
    it('names an object-literal method handler', () => {
      // The route-module shape the reporting repo uses throughout.
      expect(
        extract(`
          export function createRoutes(ctx) {
            return {
              async handle(req, res, reqCtx) {
                const { pathname } = reqCtx
                if (req.method === 'GET' && pathname === '/api/live/events') { return 1 }
              },
            }
          }
        `),
      ).toMatchObject([{ routePath: '/api/live/events', handlerName: 'handle' }]);
    });

    it('names an arrow function bound to a const', () => {
      expect(
        extract(`
          const dispatch = (req) => {
            if (req.method === 'GET' && pathname === '/api/ping') { return 1 }
          }
        `),
      ).toMatchObject([{ routePath: '/api/ping', handlerName: 'dispatch' }]);
    });

    it('reports no handler for a top-level comparison', () => {
      expect(extract(`if (pathname === '/api/top') { go() }`)).toMatchObject([
        { routePath: '/api/top', handlerName: undefined },
      ]);
    });
  });

  describe('per-file dedup', () => {
    it('collapses a repeated (url, verb) pair', () => {
      const routes = extract(`
        function handle(req) {
          if (req.method === 'GET' && pathname === '/api/a') { return 1 }
          if (req.method === 'GET' && pathname === '/api/a') { return 2 }
        }
      `);
      expect(routes).toHaveLength(1);
    });

    it('keeps distinct verbs on the same URL as separate routes', () => {
      expect(
        extract(`
          function handle(req) {
            if (req.method === 'GET' && pathname === '/api/a') { return 1 }
            if (req.method === 'DELETE' && pathname === '/api/a') { return 2 }
          }
        `),
      ).toHaveLength(2);
    });
  });

  // Whole-repo reconciliation. Deliberately NOT per-file: the reporting repo
  // keeps its path table (`isKnownApiPath`) in one module and its handlers in
  // sixteen others, so a per-file rule sees each half separately and the map
  // ends up listing every route twice — once verb-less with the table as its
  // "handler", once properly. Measured there: 94 routes, 34 of them shadows.
  describe('cross-file reconciliation', () => {
    const route = (routePath: string, httpMethod: string, source = DISPATCH_GUARD_SOURCE) => ({
      routePath,
      httpMethod,
      source,
    });

    it('drops a verb-less guard route when another file claims the URL with a verb', () => {
      expect(
        reconcileDispatchGuardRoutes([
          route('/api/live/health', ''), // the table
          route('/api/live/health', 'GET'), // the handler
        ]),
      ).toEqual([route('/api/live/health', 'GET')]);
    });

    it('keeps a verb-less guard route no verb claims', () => {
      const only = [route('/api/plans/examples/{param1}', ''), route('/api/other', 'GET')];
      expect(reconcileDispatchGuardRoutes(only)).toEqual(only);
    });

    it('keeps every verb on a multi-verb URL', () => {
      const multi = [route('/api/x', 'GET'), route('/api/x', 'POST'), route('/api/x', '')];
      expect(reconcileDispatchGuardRoutes(multi)).toEqual([
        route('/api/x', 'GET'),
        route('/api/x', 'POST'),
      ]);
    });

    // A framework route without a verb is method-agnostic BY DECLARATION — a
    // Django function view, a Laravel resource. That is a fact, not a weaker
    // observation of the same thing, so the rule must not reach it.
    it('never drops a non-dispatch-guard route', () => {
      const mixed = [
        { routePath: '/api/x', httpMethod: '', source: undefined },
        route('/api/x', 'GET'),
      ];
      expect(reconcileDispatchGuardRoutes(mixed)).toEqual(mixed);
    });

    it('does not let a framework verb suppress a guard route', () => {
      const mixed = [
        route('/api/x', ''),
        { routePath: '/api/x', httpMethod: 'GET', source: undefined },
      ];
      expect(reconcileDispatchGuardRoutes(mixed)).toEqual(mixed);
    });
  });

  // Both providers are wired to this extractor, and TypeScript is where the
  // grammar can differ — an annotated parameter, a non-null assertion, an `as`
  // cast all wrap nodes the rules read. Asserted rather than assumed.
  describe('TypeScript', () => {
    const tsParser = new Parser();
    tsParser.setLanguage(TypeScript.typescript);

    const tsPaths = (source: string): string[] =>
      extractDispatchGuardRoutes(tsParser.parse(source), 'src/server/routes.ts').map(
        (r) => r.routePath,
      );

    it('extracts through annotated parameters', () => {
      expect(
        tsPaths(`
          export async function handle(req: IncomingMessage, pathname: string): Promise<void> {
            if (req.method === 'GET' && pathname === '/api/live/portfolio') { return }
          }
        `),
      ).toEqual(['/api/live/portfolio']);
    });

    it('extracts a switch on a typed discriminant', () => {
      expect(
        tsPaths(`
          function handle(pathname: string): number {
            switch (pathname) {
              case '/api/health': return 1
              default: return 0
            }
          }
        `),
      ).toEqual(['/api/health']);
    });

    it('folds a typed constant', () => {
      expect(
        tsPaths(
          'const BASE: string = "/api/v1"\n' +
            'function handle(pathname: string) { if (pathname === `${BASE}/orders`) { return 1 } }',
        ),
      ).toEqual(['/api/v1/orders']);
    });
  });

  describe('path expressions the rule accepts', () => {
    it('accepts a member access ending in .pathname', () => {
      expect(
        paths(`function f(req) { if (new URL(req.url, base).pathname === '/api/x') { return 1 } }`),
      ).toEqual(['/api/x']);
    });

    it('accepts raw req.url', () => {
      expect(paths(`function f(req) { if (req.url === '/api/x') { return 1 } }`)).toEqual([
        '/api/x',
      ]);
    });

    it('rejects a bare .url on an unrelated receiver', () => {
      // `link.url` is not a request path; only req/request carry the raw form.
      expect(paths(`function f(link) { if (link.url === '/api/x') { return 1 } }`)).toEqual([]);
    });
  });
});
