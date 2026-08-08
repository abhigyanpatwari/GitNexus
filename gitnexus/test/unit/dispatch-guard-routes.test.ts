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

    it('reads a doubly-negated VERB, not just a doubly-negated path', () => {
      // The parity rule was stated for `!` but the verb walk refused on the mere
      // PRESENCE of one, so this lost a verb the source states outright. The
      // path-position case above passed throughout and hid it.
      expect(
        extract(
          `function h(req) { if (!!(req.method === 'GET') && pathname === '/api/dn') { return 1 } }`,
        ),
      ).toMatchObject([{ routePath: '/api/dn', httpMethod: 'GET' }]);
    });
  });

  // A ternary SELECTS between its arms, so a verb inside one is not reached
  // merely because the whole condition is truthy. Reproduced against the
  // extractor before fixing: the first case emitted `GET /api/i`, the one method
  // that branch guarantees the request does NOT have — the same inversion `!`
  // produced before it was handled, one level up.
  //
  // The last three cases were ALREADY correct and are here to pin them: refusing
  // every ternary would fix the bug and silently drop three real verbs.
  describe('ternary polarity', () => {
    const guard = (cond: string, path = '/api/i') =>
      extract(`function h(req) { if (${cond} && pathname === '${path}') { return 1 } }`);

    it('drops the verb when a ternary INVERTS it', () => {
      // `c ? false : true` is `!c`: the branch runs for every method except GET.
      expect(guard(`(req.method === 'GET' ? false : true)`)).toMatchObject([
        { routePath: '/api/i', httpMethod: '' },
      ]);
    });

    it('keeps the verb when a ternary is the identity', () => {
      // `c ? true : false` is `c`. Verb-less would be safe but wrong to settle for.
      expect(guard(`(req.method === 'GET' ? true : false)`)).toMatchObject([
        { routePath: '/api/i', httpMethod: 'GET' },
      ]);
    });

    it('keeps a verb in the consequence when the alternative is `false`', () => {
      // `c ? A : false` is `c && A` — reaching the body requires BOTH.
      expect(guard(`(isAdmin ? req.method === 'GET' : false)`)).toMatchObject([
        { routePath: '/api/i', httpMethod: 'GET' },
      ]);
    });

    it('keeps a verb in the alternative when the consequence is `false`', () => {
      // `c ? false : B` is `!c && B`.
      expect(guard(`(isAdmin ? false : req.method === 'GET')`)).toMatchObject([
        { routePath: '/api/i', httpMethod: 'GET' },
      ]);
    });

    it('claims no verb when both arms are live comparisons', () => {
      // Which verb this serves depends on `isAdmin`, so naming either is a guess.
      expect(guard(`(isAdmin ? req.method === 'GET' : req.method === 'POST')`)).toMatchObject([
        { routePath: '/api/i', httpMethod: '' },
      ]);
    });

    it('claims no verb when a `true` arm makes the ternary a disjunction', () => {
      // `c ? true : B` is `c || B`: the body is also reached for any method when
      // `isAdmin` holds, so `GET` would present a broader route as a narrow one.
      expect(guard(`(req.method === 'GET' ? true : isAdmin)`)).toMatchObject([
        { routePath: '/api/i', httpMethod: '' },
      ]);
    });

    it('claims no verb when the whole ternary is negated', () => {
      // `!(c ? A : false)` is `!(c && A)`, i.e. `!c || !A` — a disjunction, which
      // guarantees nothing. Without the parity guard the conjunction rule would
      // read `GET` straight out of the consequence and invert it exactly as the
      // un-negated form did.
      expect(guard(`!(isAdmin ? req.method === 'GET' : false)`, '/api/n')).toMatchObject([
        { routePath: '/api/n', httpMethod: '' },
      ]);
    });
  });

  // One guard, several methods. Verbatim from the reporting repo:
  //   if ((req.method === 'GET' || req.method === 'POST') && bundlesMatch) { … }
  // Taking the FIRST verb reported this as GET-only, so `route_map` presented a
  // route open to two methods as restricted to one, and `impact` on the POST
  // path found nothing.
  describe('multi-method guards', () => {
    const guard = (cond: string) =>
      extract(`function h(req) { if (${cond} && pathname === '/api/i') { return 1 } }`).map(
        (r) => r.httpMethod,
      );

    it('emits one route per method in a verb disjunction', () => {
      expect(guard(`(req.method === 'GET' || req.method === 'POST')`)).toEqual(['GET', 'POST']);
    });

    it('handles more than two', () => {
      expect(
        guard(`(req.method === 'GET' || req.method === 'POST' || req.method === 'PUT')`),
      ).toEqual(['GET', 'POST', 'PUT']);
    });

    it('claims NO verb when a disjunct is not a verb test', () => {
      // `GET || isAdmin` is reached for ANY method when `isAdmin` holds. Naming
      // GET would describe a route open to everything as single-method — the
      // direction this module treats as more expensive than saying nothing.
      expect(guard(`(req.method === 'GET' || isAdmin)`)).toEqual(['']);
    });

    it('claims no verb when the disjunction is negated', () => {
      // `!(GET || POST)` excludes both rather than offering either.
      expect(guard(`!(req.method === 'GET' || req.method === 'POST')`)).toEqual(['']);
    });

    it('still distributes ONE verb across an OR of paths', () => {
      // The pre-existing rule, pinned against the disjunction change: here the
      // `||` joins PATHS, not verbs, and must not start multiplying methods.
      expect(
        extract(`
          function h(req) {
            if (req.method === 'GET' && (pathname === '/api/a' || pathname === '/api/b')) { return 1 }
          }
        `),
      ).toMatchObject([
        { routePath: '/api/a', httpMethod: 'GET' },
        { routePath: '/api/b', httpMethod: 'GET' },
      ]);
    });

    it('gives every switch arm the full method set', () => {
      expect(
        extract(`
          function h(req) {
            if (req.method === 'GET' || req.method === 'POST') {
              switch (pathname) {
                case '/api/a': return 1
                case '/api/b': return 2
              }
            }
          }
        `),
      ).toMatchObject([
        { routePath: '/api/a', httpMethod: 'GET' },
        { routePath: '/api/a', httpMethod: 'POST' },
        { routePath: '/api/b', httpMethod: 'GET' },
        { routePath: '/api/b', httpMethod: 'POST' },
      ]);
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

    // The form every real dispatcher writes, and the one this converter refused.
    // `(` fell through to the metacharacter bail, so the capturing pattern
    // translated to nothing while its non-capturing twin translated fine — which
    // is exactly why every test above passed. The reporting repo does not contain
    // a single non-capturing path wildcard: a dispatcher captures the segment
    // because it needs the id.
    it('converts a CAPTURING single-segment wildcard', () => {
      expect(regexToRoutePath('^\\/api\\/research-runs\\/([^/]+)$')).toBe(
        '/api/research-runs/{param1}',
      );
    });

    it('converts a capturing wildcard followed by more literal path', () => {
      expect(regexToRoutePath('^\\/api\\/live\\/positions\\/([^/]+)\\/replay$')).toBe(
        '/api/live/positions/{param1}/replay',
      );
    });

    it('still refuses a capture group around anything that is not one segment', () => {
      // `.+` spans slashes, so it is not a single segment and cannot be one
      // `{param}`. Accepting `(` must not mean accepting every group.
      expect(regexToRoutePath('^\\/api\\/x\\/(.+)$')).toBeNull();
      expect(regexToRoutePath('^\\/api\\/x\\/(a|b)$')).toBeNull();
    });

    it('refuses an unbalanced capture group', () => {
      // A stray `)` would otherwise be read as a literal path character.
      expect(regexToRoutePath('^\\/api\\/x\\/([^/]+$')).toBeNull();
    });
  });

  // `RE.test(pathname)` and `pathname.match(RE)` are the same test with the
  // operands swapped. Only `.test` was read, which is why 28 of the reporting
  // repo's 75 routes still named the shared route table as their handler: their
  // modules dispatch with `.match`.
  //
  // `.match` differs in one way that matters — its result is USED, so it is
  // almost always BOUND, and the verb then lives in a later `if` rather than
  // around the call.
  describe('bound .match() dispatch', () => {
    const RUNS = `/^\\/api\\/research-runs\\/([^/]+)$/`;

    it('reads the verb from where the binding is TESTED, not where it is bound', () => {
      expect(
        extract(`
          function handle(req) {
            const runMatch = pathname.match(${RUNS})
            if (req.method === 'GET' && runMatch) { return runMatch[1] }
          }
        `),
      ).toMatchObject([
        { routePath: '/api/research-runs/{param1}', httpMethod: 'GET', handlerName: 'handle' },
      ]);
    });

    it('emits a route per method for a multi-method bound match', () => {
      // Verbatim shape from researchRunRoutes.js.
      expect(
        extract(`
          function handle(req) {
            const bundlesMatch = pathname.match(/^\\/api\\/runs\\/([^/]+)\\/bundles$/)
            if ((req.method === 'GET' || req.method === 'POST') && bundlesMatch) { return 1 }
          }
        `).map((r) => r.httpMethod),
      ).toEqual(['GET', 'POST']);
    });

    it('emits once per TEST SITE, not once per capture read', () => {
      // `m[1]` is a read of the captured segment. It says nothing about
      // dispatch, and counting it would mint a duplicate route per use of the id.
      expect(
        extract(`
          function handle(req) {
            const m = pathname.match(/^\\/api\\/w\\/([^/]+)$/)
            if (req.method === 'GET' && m) { return [m[1], m[2], m[1]] }
          }
        `),
      ).toMatchObject([{ routePath: '/api/w/{param1}', httpMethod: 'GET' }]);
    });

    it('emits a route per test site when one binding is tested for two methods', () => {
      expect(
        extract(`
          function handle(req) {
            const m = pathname.match(/^\\/api\\/t\\/([^/]+)$/)
            if (req.method === 'GET' && m) { return 1 }
            if (req.method === 'PUT' && m) { return 2 }
          }
        `).map((r) => r.httpMethod),
      ).toEqual(['GET', 'PUT']);
    });

    it('does not inherit a verb across a NEGATED guard clause', () => {
      // `if (!m) return` is the early-out. The `if (method === 'GET')` after it
      // governs the rest of the function, not this binding's test.
      expect(
        extract(`
          function handle(req) {
            const m = pathname.match(/^\\/api\\/z\\/([^/]+)$/)
            if (!m) { return false }
            if (req.method === 'GET') { return 1 }
          }
        `),
      ).toMatchObject([{ routePath: '/api/z/{param1}', httpMethod: '' }]);
    });

    it('keeps the path when a binding is never tested', () => {
      // The code still computed an anchored match against the request path —
      // the same evidence an unbound `.test` carries.
      expect(
        extract(`
          function handle(req) {
            const m = pathname.match(/^\\/api\\/y\\/([^/]+)$/)
            return m[1]
          }
        `),
      ).toMatchObject([{ routePath: '/api/y/{param1}', httpMethod: '' }]);
    });

    it('reads an UNBOUND .match like a .test', () => {
      expect(
        extract(
          `function handle(req) { if (req.method === 'GET' && pathname.match(/^\\/api\\/x$/)) { return 1 } }`,
        ),
      ).toMatchObject([{ routePath: '/api/x', httpMethod: 'GET' }]);
    });

    it('resolves a regex named by a same-file const, both ways round', () => {
      // positionReplayRoutes.js declares the pattern once and uses it both ways.
      const re = `const RE = /^\\/api\\/positions\\/([^/]+)\\/replay$/`;
      expect(
        extract(`
          ${re}
          function handle(req) {
            const routeMatch = pathname.match(RE)
            if (req.method === 'DELETE' && routeMatch) { return 1 }
          }
        `),
      ).toMatchObject([{ routePath: '/api/positions/{param1}/replay', httpMethod: 'DELETE' }]);
      expect(
        extract(`
          ${re}
          function handle(req) { if (req.method === 'GET' && RE.test(pathname)) { return 1 } }
        `),
      ).toMatchObject([{ routePath: '/api/positions/{param1}/replay', httpMethod: 'GET' }]);
    });

    it('refuses .match on a receiver that is not a request path', () => {
      // The genuine route alongside it is load-bearing, NOT decoration: without
      // a path token somewhere in the file, PATH_TOKEN_HINT skips the walk
      // entirely and this assertion is satisfied by a file that was never
      // examined. It proves the file WAS processed and `userAgent` was refused
      // on its merits.
      expect(
        paths(`
          function handle(req) {
            const m = userAgent.match(/^\\/api\\/nope$/)
            if (req.method === 'GET' && m) { return 1 }
            if (req.method === 'GET' && pathname === '/api/real') { return 2 }
          }
        `),
      ).toEqual(['/api/real']);
    });

    it('claims no verb when the test site itself sits under a negation', () => {
      // `if (!(method === 'GET' && m))` runs precisely when the path did NOT
      // match, so attributing GET is backwards. `!m` alone never reaches this
      // check — a `unary_expression` parent is not a truthiness position to
      // begin with — so the wrapped conjunction is the shape that exercises it.
      expect(
        extract(`
          function handle(req) {
            const m = pathname.match(/^\\/api\\/n\\/([^/]+)$/)
            if (!(req.method === 'GET' && m)) { return false }
          }
        `),
      ).toMatchObject([{ routePath: '/api/n/{param1}', httpMethod: '' }]);
    });

    it('refuses a regex const bound twice to different patterns', () => {
      // Same ambiguity refusal the string-constant map applies: a half-right
      // regex is a wrong route.
      expect(
        paths(`
          const RE = /^\\/api\\/a\\/([^/]+)$/
          const RE = /^\\/api\\/b\\/([^/]+)$/
          function handle(req) { if (req.method === 'GET' && RE.test(pathname)) { return 1 } }
        `),
      ).toEqual([]);
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
