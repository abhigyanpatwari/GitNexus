import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  DATA_ROUTE_TABLE_SOURCE,
  extractDataRouteTableRoutes,
  scanDataRouteTables,
} from '../../src/core/ingestion/route-extractors/data-route-table.js';
import { JAVASCRIPT_HTTP_PLUGIN } from '../../src/core/group/extractors/http-patterns/node.js';

const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const compact = (source: string) =>
  extractDataRouteTableRoutes(jsParser.parse(source), 'src/routes.js').map((route) => ({
    path: route.routePath,
    method: route.httpMethod,
    handler: route.handlerName,
    source: route.source,
  }));

const dispatch = (table: string) => `
  for (const route of ${table}) {
    if (route.path === request.path && route.method === request.method) route.handler();
  }
`;

describe('data route table extraction', () => {
  it('extracts literal entries and preserves method + URL identity', () => {
    expect(
      compact(`
        const apiRoutes = [
          { path: '/users', method: 'get', handler: listUsers },
          { path: '/users', method: 'POST', handler: users.create, auth: true },
        ];
        ${dispatch('apiRoutes')}
      `),
    ).toEqual([
      {
        path: '/users',
        method: 'GET',
        handler: 'listUsers',
        source: DATA_ROUTE_TABLE_SOURCE,
      },
      {
        path: '/users',
        method: 'POST',
        handler: 'users.create',
        source: DATA_ROUTE_TABLE_SOURCE,
      },
    ]);
  });

  it('supports quoted keys, static templates, and one-level member handlers', () => {
    expect(
      compact(`
        const ROUTE_TABLE = [{
          'path': \`/auth/me\`,
          'method': 'GET',
          'handler': auth.getCurrentUser,
        }];
        ${dispatch('ROUTE_TABLE')}
      `),
    ).toMatchObject([{ path: '/auth/me', method: 'GET', handler: 'auth.getCurrentUser' }]);
  });

  it('allows line and block comments between static route properties', () => {
    expect(
      compact(`
        const routes = [{
          path: '/comments',
          // The verb remains a direct literal.
          method: 'GET',
          /* The handler remains a direct designator. */
          handler: commented,
        }];
        ${dispatch('routes')}
      `),
    ).toMatchObject([{ path: '/comments', method: 'GET', handler: 'commented' }]);
  });

  it('has JavaScript / TypeScript grammar parity', () => {
    const source = `
      type Route = { path: string; method: string; handler: Function };
      const routes: Route[] = [{ path: '/typed', method: 'GET', handler: typedHandler }];
      ${dispatch('routes')}
    `;
    const tsParser = new Parser();
    tsParser.setLanguage(TypeScript.typescript);
    expect(scanDataRouteTables(tsParser.parse(source))).toMatchObject([
      { path: '/typed', method: 'GET', handlerName: 'typedHandler' },
    ]);
  });

  it.each([
    ['dynamic path', `const routes = [{ path: runtimePath, method: 'GET', handler: h }]`, 'routes'],
    [
      'dynamic method',
      `const routes = [{ path: '/x', method: runtimeMethod, handler: h }]`,
      'routes',
    ],
    [
      'called handler',
      `const routes = [{ path: '/x', method: 'GET', handler: makeHandler() }]`,
      'routes',
    ],
    [
      'inline handler',
      `const routes = [{ path: '/x', method: 'GET', handler: () => {} }]`,
      'routes',
    ],
    [
      'spread entry',
      `const routes = [{ ...base, path: '/x', method: 'GET', handler: h }]`,
      'routes',
    ],
    ['computed key', `const routes = [{ ['path']: '/x', method: 'GET', handler: h }]`, 'routes'],
    ['unknown verb', `const routes = [{ path: '/x', method: 'CONNECT', handler: h }]`, 'routes'],
    [
      'multi-level member',
      `const routes = [{ path: '/x', method: 'GET', handler: services.auth.h }]`,
      'routes',
    ],
    [
      'non-route binding',
      `const requests = [{ path: '/x', method: 'GET', handler: h }]`,
      'requests',
    ],
  ])('suppresses %s', (_name, source, table) => {
    expect(compact(`${source}; ${dispatch(table)}`)).toEqual([]);
  });

  it('suppresses an unconsumed route-named descriptor table', () => {
    expect(
      compact(`const mockRoutes = [{ path: '/admin', method: 'DELETE', handler: onResponse }];`),
    ).toEqual([]);
  });

  it('does not use a dispatch loop hidden in a nested function', () => {
    expect(
      compact(`
        const routes = [{ path: '/admin', method: 'DELETE', handler: removeAdmin }];
        function dispatch(path, method) {
          for (const route of routes) {
            if (route.path === request.path && route.method === request.method) route.handler();
          }
        }
      `),
    ).toEqual([]);
  });

  it('suppresses outbound client tables that pass fields to fetch and then callbacks', () => {
    expect(
      compact(`
        const routeRequests = [
          { path: '/admin', method: 'DELETE', handler: onResponse },
        ];
        for (const route of routeRequests) {
          fetch(route.path, { method: route.method }).then(route.handler);
        }
      `),
    ).toEqual([]);
  });

  it('requires path and method comparisons in the same guard as direct dispatch', () => {
    expect(
      compact(`
        const routes = [{ path: '/admin', method: 'DELETE', handler: onResponse }];
        for (const route of routes) {
          if (route.path) console.log(route.method);
          route.handler();
        }
      `),
    ).toEqual([]);
  });

  it('does not treat negated equality as a positive dispatch guard', () => {
    expect(
      compact(`
        const routes = [{ path: '/admin', method: 'DELETE', handler: removeAdmin }];
        for (const route of routes) {
          if (!(route.path === request.path && route.method === request.method)) {
            route.handler();
          }
        }
      `),
    ).toEqual([]);
  });

  it('does not treat disjunctive comparisons as a complete dispatch guard', () => {
    expect(
      compact(`
        const routes = [{ path: '/admin', method: 'DELETE', handler: removeAdmin }];
        for (const route of routes) {
          if (route.path === request.path || route.method === request.method) route.handler();
        }
      `),
    ).toEqual([]);
  });

  it.each([
    ['direct', 'route.path', 'route.method'],
    ['parenthesized', '(route.path)', '(route.method)'],
    ['computed', "route['path']", "route['method']"],
    ['unary', '+route.path', '+route.method'],
    ['self-derived', 'normalize(route.path)', 'normalize(route.method)'],
  ])(
    'does not accept %s route-field self-comparisons as dispatch evidence',
    (_name, path, method) => {
      expect(
        compact(`
        const routes = [{ path: '/admin', method: 'DELETE', handler: removeAdmin }];
        for (const route of routes) {
          if (route.path === ${path} && route.method === ${method}) route.handler();
        }
      `),
      ).toEqual([]);
    },
  );

  it('suppresses duplicate required keys but preserves route candidates for resolution', () => {
    expect(
      compact(`
        const routes = [
          { path: '/bad', path: '/other', method: 'GET', handler: bad },
          { path: '/once', method: 'GET', handler: first },
          { path: '/once', method: 'GET', handler: second },
        ];
        ${dispatch('routes')}
      `),
    ).toMatchObject([
      { path: '/once', method: 'GET', handler: 'first' },
      { path: '/once', method: 'GET', handler: 'second' },
    ]);
  });

  it('rejects literal-only guards that select only one table entry', () => {
    expect(
      compact(`
        const routes = [
          { path: '/only', method: 'GET', handler: only },
          { path: '/never', method: 'POST', handler: never },
        ];
        for (const route of routes) {
          if (route.path === '/only' && route.method === 'GET') route.handler();
        }
      `),
    ).toEqual([]);
  });

  it('rejects route-derived aliases even when their names resemble request fields', () => {
    expect(
      compact(`
        const routes = [{ path: '/copied', method: 'GET', handler: copied }];
        for (const route of routes) {
          const copiedPath = route.path;
          const copiedMethod = route.method;
          if (route.path === copiedPath && route.method === copiedMethod) route.handler();
        }
      `),
    ).toEqual([]);
  });

  it('requires request fields to come from an unshadowed ingress binding', () => {
    expect(
      compact(`
        const request = { path: '/only', method: 'GET' };
        const routes = [
          { path: '/only', method: 'GET', handler: only },
          { path: '/never', method: 'POST', handler: never },
        ];
        ${dispatch('routes')}
      `),
    ).toEqual([]);

    expect(
      compact(`
        const routes = [{ path: '/nested', method: 'GET', handler: nested }];
        for (const route of routes) {
          if (
            route.path === request.config.path &&
            route.method === request.options.method
          ) route.handler();
        }
      `),
    ).toEqual([]);

    expect(
      compact(`
        function dispatchRequest(request) {
          const routes = [{ path: '/parameter', method: 'GET', handler: parameterHandler }];
          for (const route of routes) {
            if (route.path === request.path && route.method === request.method) route.handler();
          }
        }
      `),
    ).toMatchObject([{ path: '/parameter', method: 'GET', handler: 'parameterHandler' }]);
  });

  it.each([
    ['reassigned request parameter', 'request = { path: "/x", method: "GET" };'],
    ['mutated request fields', 'request.path = "/x"; request.method = "GET";'],
    ['escaped request parameter', 'observe(request);'],
    [
      'request mutation through a called closure',
      'const overwrite = () => { request.path = "/x"; request.method = "GET"; }; overwrite();',
    ],
  ])('rejects an unstable ingress binding: %s', (_name, mutation) => {
    expect(
      compact(`
        function dispatchRequest(request) {
          const routes = [{ path: '/x', method: 'GET', handler: handler }];
          ${mutation}
          for (const route of routes) {
            if (route.path === request.path && route.method === request.method) route.handler();
          }
        }
      `),
    ).toEqual([]);
  });

  it.each([
    [
      'a route-literal narrowing conjunct',
      `route.path === request.path && route.method === request.method && route.path === '/only'`,
    ],
    [
      'a statically false conjunct',
      `route.path === request.path && route.method === request.method && false`,
    ],
    [
      'a statically false equality',
      `route.path === request.path && route.method === request.method && 1 === 2`,
    ],
  ])('rejects %s', (_name, condition) => {
    expect(
      compact(`
        const routes = [
          { path: '/only', method: 'GET', handler: only },
          { path: '/other', method: 'GET', handler: other },
        ];
        for (const route of routes) {
          if (${condition}) route.handler();
        }
      `),
    ).toEqual([]);
  });

  it('rejects a conditionally unreachable handler call in the consequence', () => {
    expect(
      compact(`
        const routes = [{ path: '/x', method: 'GET', handler: unreachable }];
        for (const route of routes) {
          if (route.path === request.path && route.method === request.method) {
            false && route.handler();
          }
        }
      `),
    ).toEqual([]);
  });

  it('rejects a handler call after a statically terminating branch', () => {
    expect(
      compact(`
        const routes = [{ path: '/x', method: 'GET', handler: unreachable }];
        for (const route of routes) {
          if (route.path === request.path && route.method === request.method) {
            if (true) return;
            route.handler();
          }
        }
      `),
    ).toEqual([]);
  });

  it.each(['return', 'throw new Error("stop")', 'break', 'continue'])(
    'rejects a handler call after an unconditional %s',
    (transfer) => {
      expect(
        compact(`
          const routes = [{ path: '/x', method: 'GET', handler: unreachable }];
          for (const route of routes) {
            if (route.path === request.path && route.method === request.method) {
              ${transfer};
              route.handler();
            }
          }
        `),
      ).toEqual([]);
    },
  );

  it.each(['return', 'throw new Error("stop")', 'break', 'continue'])(
    'rejects a dispatch guard after an unconditional %s',
    (transfer) => {
      expect(
        compact(`
          const routes = [{ path: '/x', method: 'GET', handler: unreachable }];
          for (const route of routes) {
            ${transfer};
            if (route.path === request.path && route.method === request.method) {
              route.handler();
            }
          }
        `),
      ).toEqual([]);
    },
  );

  it('rejects a dispatch guard nested in a statically false branch', () => {
    expect(
      compact(`
        const routes = [{ path: '/x', method: 'GET', handler: unreachable }];
        for (const route of routes) {
          if (false) {
            if (route.path === request.path && route.method === request.method) {
              route.handler();
            }
          }
        }
      `),
    ).toEqual([]);
  });

  it('rejects mutation of the loop entry before dispatch', () => {
    expect(
      compact(`
        const routes = [{ path: '/mutated', method: 'GET', handler: mutated }];
        for (const route of routes) {
          route.path = request.path;
          route.method = request.method;
          if (route.path === request.path && route.method === request.method) route.handler();
        }
      `),
    ).toEqual([]);

    expect(
      compact(`
        const routes = [{ path: '/reassigned', method: 'GET', handler: original }];
        for (let route of routes) {
          route = replacement;
          if (route.path === request.path && route.method === request.method) route.handler();
        }
      `),
    ).toEqual([]);
  });

  it.each([
    ['deleting an entry field', 'delete route.path;'],
    ['deleting a wrapped entry field', 'delete (route.path);'],
    ['writing through a destructuring target', '({ path: route.path } = request);'],
    ['augmenting the handler field', 'route.handler ||= replacement;'],
    ['aliasing the entry', 'const alias = route; alias.path = request.path;'],
  ])('rejects %s', (_name, mutation) => {
    expect(
      compact(`
        const routes = [{ path: '/mutated', method: 'GET', handler: original }];
        for (const route of routes) {
          ${mutation}
          if (route.path === request.path && route.method === request.method) route.handler();
        }
      `),
    ).toEqual([]);
  });

  it.each([
    [
      'a mutable declaration',
      `let routes = [{ path: '/stale', method: 'GET', handler: stale }];
       ${dispatch('routes')}`,
    ],
    [
      'a reassigned table',
      `const routes = [{ path: '/stale', method: 'GET', handler: stale }];
       routes = [];
       ${dispatch('routes')}`,
    ],
    [
      'an aliased table',
      `const routes = [{ path: '/stale', method: 'GET', handler: stale }];
       const alias = routes;
       ${dispatch('routes')}`,
    ],
    [
      'a truncated table',
      `const routes = [{ path: '/stale', method: 'GET', handler: stale }];
       routes.length = 0;
       ${dispatch('routes')}`,
    ],
  ])('rejects %s', (_name, source) => {
    expect(compact(source)).toEqual([]);
  });

  it.each([
    [
      'a reassigned bare handler',
      `function original() {}
       const routes = [{ path: '/stale', method: 'GET', handler: original }];
       original = replacement;
       ${dispatch('routes')}`,
    ],
    [
      'a reassigned member handler',
      `const auth = {};
       auth.handle = replacement;
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
    [
      'a handler owner mutated through an alias',
      `const auth = {};
       const alias = auth;
       alias.handle = replacement;
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
    [
      'a handler owner hidden by parentheses',
      `const auth = {};
       const alias = (auth);
       alias.handle = replacement;
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
    [
      'a handler owner nested in an initializer',
      `const auth = {};
       const box = { auth };
       box.auth.handle = replacement;
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
    [
      'a handler owner stored under an unrelated handler property',
      `const auth = {};
       const box = { handler: auth };
       box.handler.handle = replacement;
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
    [
      'a handler owner assigned to an alias',
      `const auth = {};
       let alias;
       alias = auth;
       alias.handle = replacement;
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
    [
      'an escaped handler owner',
      `const auth = {};
       auth.configure();
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
    [
      'a handler owner escaped through a computed member call',
      `const auth = {};
       auth['configure']();
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
    [
      'a parenthesized handler owner escaped through a member call',
      `const auth = {};
       (auth).configure();
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
    [
      'a returned handler owner',
      `const auth = {};
       function expose() { return auth; }
       expose().handle = replacement;
       const routes = [{ path: '/stale', method: 'GET', handler: auth.handle }];
       ${dispatch('routes')}`,
    ],
  ])('rejects %s', (_name, source) => {
    expect(compact(source)).toEqual([]);
  });

  it('preserves an unresolved identity tombstone for unsupported duplicate handlers', () => {
    expect(
      compact(`
        function valid() {}
        const routes = [
          { path: '/users', method: 'GET', handler: makeHandler() },
          { path: '/users', method: 'GET', handler: valid },
        ];
        ${dispatch('routes')}
      `),
    ).toEqual([]);
  });

  it('tombstones recoverable identities from entries with duplicate route keys', () => {
    expect(
      compact(`
        function first() {}
        function second() {}
        const routes = [
          { path: '/users', path: '/users', method: 'GET', handler: first },
          { path: '/users', method: 'GET', handler: second },
        ];
        ${dispatch('routes')}
      `),
    ).toEqual([]);
  });

  it('uses the final duplicate route keys when tombstoning an invalid entry', () => {
    expect(
      compact(`
        function first() {}
        function second() {}
        const routes = [
          { path: '/ignored', path: '/users', method: 'POST', method: 'GET', handler: first },
          { path: '/users', method: 'GET', handler: second },
        ];
        ${dispatch('routes')}
      `),
    ).toEqual([]);
  });

  it('suppresses later candidates when a trailing spread leaves identity unknown', () => {
    expect(
      compact(`
        function first() {}
        function second() {}
        const routes = [
          { path: '/unknown', method: 'POST', handler: first, ...dynamicRoute },
          { path: '/users', method: 'GET', handler: second },
        ];
        ${dispatch('routes')}
      `),
    ).toEqual([]);
  });

  it.each([
    ['a dynamic path', `{ path: runtimePath, method: 'GET', handler: first }`],
    [
      'a computed overwrite',
      `{ path: '/other', method: 'GET', handler: first, ['path']: '/users' }`,
    ],
  ])('suppresses later candidates after %s', (_name, firstEntry) => {
    expect(
      compact(`
        function first() {}
        function second() {}
        const routes = [
          ${firstEntry},
          { path: '/users', method: 'GET', handler: second },
        ];
        ${dispatch('routes')}
      `),
    ).toEqual([]);
  });

  it('rejects tables containing array-level spreads', () => {
    expect(
      compact(`
        function second() {}
        const routes = [
          ...baseRoutes,
          { path: '/users', method: 'GET', handler: second },
        ];
        ${dispatch('routes')}
      `),
    ).toEqual([]);
  });

  it('propagates unresolved identity tombstones across route tables', () => {
    expect(
      compact(`
        function first() {}
        function second() {}
        const primaryRoutes = [{ path: '/users', method: 'GET', handler: first }];
        const fallbackRoutes = [{ path: '/users', method: 'GET', handler: makeHandler() }];
        ${dispatch('primaryRoutes')}
        ${dispatch('fallbackRoutes')}
      `),
    ).toEqual([]);
  });

  it.each([
    [
      'an unstable duplicate handler binding',
      `function first() {}
       function second() {}
       first = replacement;
       const routes = [
         { path: '/users', method: 'GET', handler: first },
         { path: '/users', method: 'GET', handler: second },
       ];`,
    ],
    [
      'a spread-first duplicate entry',
      `function second() {}
       const routes = [
         { ...base, path: '/users', method: 'GET', handler: first },
         { path: '/users', method: 'GET', handler: second },
       ];`,
    ],
  ])('tombstones %s', (_name, table) => {
    expect(compact(`${table} ${dispatch('routes')}`)).toEqual([]);
  });

  it('rejects shadowed table and loop-entry bindings', () => {
    expect(
      compact(`
        const routes = [{ path: '/outer', method: 'GET', handler: outer }];
        {
          const routes = [{ path: '/inner', method: 'GET', handler: inner }];
          for (const route of routes) {
            if (route.path === request.path && route.method === request.method) route.handler();
          }
        }
      `),
    ).toEqual([]);

    expect(
      compact(`
        const routes = [{ path: '/outer', method: 'GET', handler: outer }];
        for (const route of routes) {
          {
            const route = fakeRoute;
            if (route.path === request.path && route.method === request.method) route.handler();
          }
        }
      `),
    ).toEqual([]);
  });

  it('suppresses a named import shadowed anywhere in the file', () => {
    const detections = JAVASCRIPT_HTTP_PLUGIN.scan(
      jsParser.parse(`
        import { listUsers } from './handlers.js';
        function wrapper(listUsers) { return listUsers; }
        const routes = [{ path: '/users', method: 'GET', handler: listUsers }];
        ${dispatch('routes')}
      `),
    );
    expect(detections).not.toContainEqual(
      expect.objectContaining({ framework: DATA_ROUTE_TABLE_SOURCE, path: '/users' }),
    );
  });

  it('feeds the Node group scanner with named-import provenance', () => {
    const detections = JAVASCRIPT_HTTP_PLUGIN.scan(
      jsParser.parse(`
        import { listUsers as handleUsers } from './handlers.js';
        const routes = [{ path: '/users', method: 'GET', handler: handleUsers }];
        ${dispatch('routes')}
      `),
    );
    expect(detections).toContainEqual({
      role: 'provider',
      framework: DATA_ROUTE_TABLE_SOURCE,
      method: 'GET',
      path: '/users',
      name: 'listUsers',
      handlerImport: { name: 'listUsers', module: './handlers.js' },
      strictHandlerResolution: true,
      line: 3,
      confidence: 0.8,
    });
  });
});
