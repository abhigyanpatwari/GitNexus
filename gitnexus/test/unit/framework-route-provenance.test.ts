import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import path from 'node:path';
import {
  typescriptProvider,
  javascriptProvider,
} from '../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { extractFrameworkRouteFacts } from '../../src/core/ingestion/route-extractors/framework-route-facts.js';
import { resolveFrameworkRouteFacts } from '../../src/core/ingestion/route-extractors/framework-route-resolver.js';
import { composeFrameworkRoutePaths } from '../../src/core/ingestion/route-extractors/framework-route-paths.js';

function facts(source: string, filePath = 'server.ts') {
  const parser = new Parser();
  parser.setLanguage(
    filePath.endsWith('.js')
      ? JavaScript
      : filePath.endsWith('.tsx')
        ? TypeScript.tsx
        : TypeScript.typescript,
  );
  const tree = parser.parse(source);
  const parsed = extractParsedFile(
    filePath.endsWith('.js') ? javascriptProvider : typescriptProvider,
    source,
    filePath,
    undefined,
    tree,
  );
  expect(parsed).toBeDefined();
  return extractFrameworkRouteFacts(tree, parsed!);
}
function resolve(sources: Record<string, string>) {
  const files = Object.entries(sources).map(([file, source]) => facts(source, file));
  const output = resolveFrameworkRouteFacts(files, (from, specifier) => {
    const base = path.posix.join(path.posix.dirname(from), specifier);
    return Object.keys(sources).filter(
      (file) =>
        file === base ||
        file === `${base}.ts` ||
        file === `${base}.js` ||
        file === `${base}/index.ts`,
    );
  });
  return output;
}
const routes = (source: string) =>
  resolve({ 'server.ts': source }).registrations.map((registration) => registration.route);
const urls = (source: string) =>
  routes(source).map((route) => `${route.httpMethod} ${route.routePath}`);

describe('framework receiver provenance', () => {
  it('accepts imported Express allocations and stable aliases, not receiver names', () => {
    expect(
      urls(`
      import web from 'express';
      const service = web(); const stable = service;
      stable.get('/real', handler);
      const storage = new Map(); storage.get('/not-http', 'fallback');
      app.post('/undeclared', handler); router.get('/undeclared-router', handler);
    `),
    ).toEqual(['GET /real']);
  });

  it.each([
    `import { Router as Build } from 'express'; const r = Build();`,
    `import * as web from 'express'; const r = web.Router();`,
    `const web = require('express'); const r = web.Router();`,
    `const { Router: Build } = require('express'); const r = Build();`,
    `const Build = require('express').Router; const r = new Build();`,
    `const r = require('express')();`,
    `const r = require('express').Router();`,
  ])('recognizes factory provenance: %s', (setup) => {
    expect(urls(`${setup} r.get('/ok', handler);`)).toEqual(['GET /ok']);
  });

  it('preserves builders, chains, all, handler evidence, and argument comments', () => {
    const result = routes(`import express from 'express';
const router = express.Router();
router.route('/bare');
router.get('/setting');
router.use('/middleware', middleware);
router.route('/chain').get(/* comment */ handler).post(other);
const builder = router.route('/assigned');
const alias = builder;
alias.all(handler);
builder.delete(/* no handler */);
router.get('/direct', middleware, handler).put('/continued', other);
function handler() {} function other() {}`);
    expect(result.map((route) => `${route.httpMethod} ${route.routePath}`)).toEqual([
      'POST /chain',
      'GET /chain',
      '* /assigned',
      'PUT /continued',
      'GET /direct',
    ]);
    expect(result.find((route) => route.routePath === '/assigned')).toMatchObject({
      filePath: 'server.ts',
      lineNumber: 8,
      handlerName: 'handler',
      decoratorName: 'express.all',
    });
  });

  it.each([13, 24])(
    'resolves all %i fluent registrations without exhausting the work budget',
    (count) => {
      const paths = Array.from({ length: count }, (_, index) => `/route-${index}`);
      const chain = paths.map((route) => `.get('${route}', () => {})`).join('');
      const extracted = facts(`import express from 'express'; const app = express(); app${chain};`);
      expect(extracted.calls).toHaveLength(count);
      const resolved = resolveFrameworkRouteFacts([extracted], () => []);
      expect(resolved.registrations.map(({ route }) => route.routePath).sort()).toEqual(
        [...paths].sort(),
      );
    },
  );

  it('withholds handler evidence for mutated callable bindings', () => {
    const result = routes(`import express from 'express'; const app = express();
      let handler = () => {}; handler = replacement; app.get('/real', handler);`);
    expect(result).toHaveLength(1);
    expect(result[0].handlerName).toBeUndefined();
  });

  it('respects parameter, block, catch, destructuring, and require shadows', () => {
    expect(
      urls(`
      import express from 'express'; const router = express.Router();
      function f(router) { router.get('/parameter', handler); }
      { const router = storage; router.get('/block', handler); }
      try {} catch(router) { router.get('/catch', handler); }
      function nested({ router }) { router.get('/destructured', handler); }
      function wrong(require) { const r = require('express').Router(); r.get('/require', handler); }
      router.get('/real', handler);
    `),
    ).toEqual(['GET /real']);
  });

  it.each([
    `import type express from 'express'; const r = express();`,
    `import { type Router } from 'express'; const r = Router();`,
    `import type * as express from 'express'; const r = express.Router();`,
    `import express from 'express'; let r = express.Router(); r = storage;`,
    `import express from 'express'; let r = express.Router(); function mutate() { r = storage; }`,
    `import express from 'express'; let r = express.Router(); ({ r } = storage);`,
    `import express from 'express'; const r = express.Router(); const alias = r; alias.get = other;`,
    `import express from 'express'; express.Router = custom; const r = express.Router();`,
    `import express, { Router } from 'express'; Router.custom = other; const r = express.Router();`,
    `import express from 'express'; const r = express.Router(); delete r.get;`,
    `import express from 'express'; let r = express.Router(); for (r of replacements) {}`,
  ])('declines erased or conflicting provenance: %s', (setup) => {
    expect(urls(`${setup} r.get('/unsafe', handler);`)).toEqual([]);
  });

  // GitNexus's own server registers through helpers that receive the app and,
  // for SSE progress, the path (#3487): one call-site hop, never two.
  it('forwards a proven receiver and literal path through one helper call', () => {
    const result = resolve({
      'sse.ts': `
      import type express from 'express';
      export const mountSSEProgress = (app: express.Express, routePath: string, jm: unknown) => {
        app.get(routePath, (req, res) => {});
      };`,
      'mcp.ts': `
      export async function mountMCPEndpoints(app, backend) {
        app.all('/api/mcp', handler);
        app.use('/api/mcp', auth);
        return () => {};
      }`,
      'server.ts': `
      import express from 'express';
      import { mountSSEProgress } from './sse';
      import { mountMCPEndpoints } from './mcp';
      export const registerWebUI = (app: express.Express, dir: string | null): void => {
        app.get('/', handler);
      };
      const app = express();
      const cleanup = await mountMCPEndpoints(app, backend);
      mountSSEProgress(app, '/api/analyze/:jobId/progress', jobs);
      mountSSEProgress(app, '/api/embed/:jobId/progress', jobs);
      registerWebUI(app, null);`,
    });
    expect(
      result.registrations
        .map(({ route }) => `${route.httpMethod} ${route.routePath} ${route.filePath}`)
        .sort(),
    ).toEqual([
      '* /api/mcp mcp.ts',
      'GET / server.ts',
      'GET /api/analyze/:jobId/progress sse.ts',
      'GET /api/embed/:jobId/progress sse.ts',
    ]);
  });

  it('follows a helper exported under another name', () => {
    const result = resolve({
      'routes.ts': `function mountRoutes(app) { app.get('/api/renamed', handler); }
      export { mountRoutes as setup };`,
      'server.ts': `import express from 'express';
      import { setup } from './routes';
      setup(express());`,
    });
    expect(
      result.registrations.map(
        ({ route }) => `${route.httpMethod} ${route.routePath} ${route.filePath}`,
      ),
    ).toEqual(['GET /api/renamed routes.ts']);
  });

  it('follows a helper called through an aliased import', () => {
    const result = resolve({
      'sse.ts': `export const mountSSEProgress = (app, routePath) => { app.get(routePath, handler); };`,
      'server.ts': `import express from 'express';
      import { mountSSEProgress as mountProgress } from './sse';
      const app = express();
      mountProgress(app, '/api/progress');`,
    });
    expect(
      result.registrations.map(
        ({ route }) => `${route.httpMethod} ${route.routePath} ${route.filePath}`,
      ),
    ).toEqual(['GET /api/progress sse.ts']);
  });

  it('declines forwarding through two hops, unproven arguments, and reassigned parameters', () => {
    expect(
      urls(`
      import express from 'express';
      function inner(app) { app.get('/two-hop', handler); }
      function outer(app) { inner(app); }
      outer(express());
      function unproven(app) { app.get('/unproven', handler); }
      unproven(storage);
      function reassigned(app) { app = storage; app.get('/reassigned', handler); }
      reassigned(express());
      function runtime(app, path) { app.get(path, handler); }
      runtime(express(), runtimePath);
      function direct(app, path) { app.post(path, handler); }
      direct(express(), '/direct');
    `),
    ).toEqual(['POST /direct']);
  });

  it('invalidates a module binding written by a constructor assignment in a closure', () => {
    expect(
      urls(`import express from 'express';
      let app = express(); function replace() { app = new Map(); }
      app.get('/let-closure', handler);`),
    ).toEqual([]);
  });

  it.each([
    ['a default expression', '[target = app] = values;', ['GET /retained']],
    ['a computed key', '({ [app]: target } = values);', ['GET /retained']],
    ['a destructured property write', '({ get: app.get } = values);', []],
  ])('invalidates only assignment targets in %s', (_shape, write, expected) => {
    expect(
      urls(`import express from 'express'; const app = express(); let target;
      ${write} app.get('/retained', handler);`),
    ).toEqual(expected);
  });

  it.each([
    ['parenthesized', '(app) = new Map();'],
    ['asserted', '(app as unknown) = new Map();'],
    ['angle-bracket asserted', '(<any>app) = new Map();'],
    ['non-null asserted', 'app! = new Map();'],
  ])('invalidates a wrapped assignment target: %s', (_shape, write) => {
    expect(
      urls(`import express from 'express'; let app = express();
      ${write} app.get('/not-http', handler);`),
    ).toEqual([]);
  });

  it.each([
    ['initialized var', 'app', 'var app = storage;', []],
    ['initialized var with another default', 'app, other = 1', 'var app = storage;', []],
    ['uninitialized var', 'app', 'var app;', ['GET /forwarded']],
    [
      'nested parameter write',
      'app',
      'function inner(app) { app = new Map(); }',
      ['GET /forwarded'],
    ],
    // A parameter expression gives the body its own variable environment, which
    // the scope model collapses, so inference declines a parameter that a body
    // `var` redeclares (the documented boundary); runtime would keep its value.
    ['nested destructuring default', 'app, { value = 1 }', 'var app;', []],
    ['computed pattern key', 'app, { [key]: value }', 'var app;', []],
    ['rest parameter alone', 'app, ...rest', 'var app;', ['GET /forwarded']],
    ['loop var over the parameter', 'app', 'for (var app of values) {}', []],
    ['body function overwrites parameter', 'app', 'function app() {}', []],
    ['body function with default', 'app, other = 1', 'function app() {}', []],
    [
      'nested body declaration',
      'app, other = 1',
      'function inner() { var app = storage; }',
      ['GET /forwarded'],
    ],
  ])('uses binding identity for helper forwarding: %s', (_shape, parameters, body, expected) => {
    expect(
      urls(`import express from 'express';
      function mount(${parameters}) { ${body} app.get('/forwarded', handler); }
      mount(express());`),
    ).toEqual(expected);
  });

  it.each([
    {
      shape: 'a literal mount path forwarded to a helper',
      calls: `function mountApi(prefix) { app.use(prefix, router); }
      mountApi('/api');`,
      routes: ['GET /api/users'],
    },
    {
      shape: 'a runtime mount path forwarded to a helper',
      calls: `function mountApi(prefix) { app.use(prefix, router); }
      mountApi(process.env.API_PREFIX);`,
      routes: [],
    },
    {
      shape: 'a helper whose mount path no call proves',
      calls: 'function mountApi(prefix) { app.use(prefix, router); }',
      routes: [],
    },
    {
      shape: 'a router forwarded as the mounted child',
      calls: `function mountApi(target, child) { target.use('/api', child); }
      mountApi(app, router);`,
      routes: ['GET /api/users'],
    },
    {
      shape: 'a TypeScript this parameter',
      calls: `function wire(this: void, target, prefix) { target.use(prefix, router); }
      wire(app, '/v1');`,
      routes: ['GET /v1/users'],
    },
    {
      shape: 'an argument after a spread',
      calls: `function wire(target, prefix) { target.use(prefix, router); }
      wire(...targets, '/spread');`,
      // Unproven receiver: the router keeps its standalone paths, as without
      // any helper, rather than borrowing '/spread' from the wrong position.
      routes: ['GET /users'],
    },
    {
      shape: 'a parameter reassigned in a nested closure',
      calls: `function wire(target) { const swap = () => { target = other; }; swap(); target.use('/api', router); }
      wire(app);`,
      routes: ['GET /users'],
    },
    {
      shape: 'a helper forwarding only its mounted child',
      calls: `function mountChild(child) { app.use('/api', child); }
      mountChild(router);`,
      routes: ['GET /api/users'],
    },
    {
      shape: 'a parameter reassigned by destructuring',
      calls: `function wire(target) { [target] = [other]; target.use('/api', router); }
      wire(app);`,
      routes: ['GET /users'],
    },
    {
      shape: 'a write to a same-named local in a nested block',
      calls: `function wire(target) { { let target; target = other; } target.use('/api', router); }
      wire(app);`,
      routes: ['GET /api/users'],
    },
    {
      shape: 'a property write on another function',
      calls: `function Button() {} Button.displayName = 'Button';
      function mountApi(prefix) { app.use(prefix, router); }
      mountApi('/api');`,
      routes: ['GET /api/users'],
    },
  ])('composes mounts through helper parameters: $shape', ({ calls, routes }) => {
    const result = resolve({
      'server.ts': `import express from 'express';
      const app = express(); const router = express.Router();
      router.get('/users', handler);
      ${calls}`,
    });
    expect(
      composeFrameworkRoutePaths(result).map((route) => `${route.httpMethod} ${route.routePath}`),
    ).toEqual(routes);
  });

  it('does not lend later allocations to calls in a temporal dead zone', () => {
    expect(
      urls(`
      import express from 'express';
      api.get('/before', h); const api = express();
      const router = express.Router();
      { router.get('/block-before', h); const router = storage; }
      function install() { later.get('/closure', h); }
      const later = express.Router();
      api.get('/after', h);
    `),
    ).toEqual(['GET /closure', 'GET /after']);
  });

  it('keeps directly proven Hono registrations separate from Express builders and mounts', () => {
    const result = resolve({
      'server.ts': `
      import { Hono as Web } from 'hono';
      const api = new Web();
      api.get('/hono', handler); api.route('/builder').get(handler);
      const router = api.route('/assigned'); router.post(handler);
      api.use('/mount', api);
    `,
    });
    expect(result.registrations).toMatchObject([
      { framework: 'hono', route: { routePath: '/hono', decoratorName: 'hono.get' } },
    ]);
    expect(result.registrations).toHaveLength(1);
    expect(result.mounts).toEqual([]);
  });

  it('records literal, root, middleware and unknown mounts without emitting endpoints', () => {
    const result = resolve({
      'server.ts': `
      import express from 'express';
      const app = express(); const router = express.Router();
      function auth() {}
      app.use(['/v1', '/v2'], auth, router, auth);
      app.use(router); app.use(auth, router); app.use(runtimePrefix, auth, router);
      app.use('/array', [auth, [router]]); app.use([auth, router]);
    `,
    });
    expect(result.registrations).toEqual([]);
    expect(result.mounts.map((mount) => mount.prefixes)).toEqual([
      ['/v1', '/v2'],
      [''],
      [''],
      null,
      ['/array'],
      [''],
    ]);
    expect(result.allocations.map((allocation) => allocation.kind).sort()).toEqual([
      'app',
      'router',
    ]);
  });

  it('follows explicit ESM named/default exports and transitive barrels across JS/TS/TSX', () => {
    const result = resolve({
      'router.js': `const { Router } = require('express'); const r = Router(); export { r as users }; export default r;`,
      'barrel.ts': `export { users as endpoints, default } from './router';`,
      'index.ts': `export * from './barrel'; export { default } from './barrel';`,
      'server.tsx': `import byDefault, { endpoints } from './index'; endpoints.get('/named', handler); byDefault.post('/default', handler);`,
    });
    expect(result.registrations.map((registration) => registration.route.routePath)).toEqual([
      '/named',
      '/default',
    ]);
    expect(new Set(result.registrations.map((registration) => registration.receiverId)).size).toBe(
      1,
    );
  });

  it.each([
    [`module.exports = r;`, `const api = require('./router');`],
    [`exports.api = r;`, `const {api} = require('./router');`],
    [`module.exports.api = r;`, `const api = require('./router').api;`],
    [`module.exports = { api: r };`, `const {api} = require('./router');`],
  ])('follows explicit CommonJS exports: %s', (publish, consume) => {
    const result = resolve({
      'router.js': `const express = require('express'); const r = express.Router(); ${publish}`,
      'server.js': `${consume} api.get('/ok', handler);`,
    });
    expect(result.registrations.map((registration) => registration.route.routePath)).toEqual([
      '/ok',
    ]);
  });

  it('does not infer default from a unique named export or accept conflicting stars', () => {
    const result = resolve({
      'one.ts': `import {Router} from 'express'; export const api = Router();`,
      'two.ts': `export const api = storage;`,
      'barrel.ts': `export * from './one'; export * from './two';`,
      'server.ts': `import guessed from './one'; import {api} from './barrel'; guessed.get('/default-guess', handler); api.get('/ambiguous', handler);`,
    });
    expect(result.registrations).toEqual([]);
  });

  it('declines conflicting CJS writes, shadowed module exports, and detached exports aliases', () => {
    const result = resolve({
      'conflict.js': `const r = require('express').Router(); exports.api = r; exports.api = storage;`,
      'shadow.js': `const r = require('express').Router(); function f(module) { module.exports = r; }`,
      'detached.js': `const r = require('express').Router(); module.exports = storage; exports.api = r;`,
      'replaced.js': `const r = require('express').Router(); module.exports.api = r; module.exports = storage;`,
      'computed.js': `const r = require('express').Router(); module.exports = r; module.exports[key] = other;`,
      'server.js': `const e = require('./computed'); e.get('/computed', h); const d = require('./replaced').api; d.get('/replaced', h); const a = require('./conflict').api; a.get('/conflict', h); const b = require('./shadow'); b.get('/shadow', h); const c = require('./detached').api; c.get('/detached', h);`,
    });
    expect(result.registrations).toEqual([]);
  });

  it.each([
    `exports.router = router; delete exports.router;`,
    `exports.router = router; exports.router += 1;`,
    `exports.router = router; exports.router++;`,
    `module.exports.router = router; delete module.exports.router;`,
    `module.exports.router = router; module.exports.router--;`,
    `module.exports = { router }; delete module.exports;`,
    `module.exports = { router, ...overrides };`,
    `module.exports = { router, [key]: replacement };`,
  ])('declines invalidated or dynamically overwritten CommonJS exports: %s', (publish) => {
    const result = resolve({
      'router.js': `const { Router } = require('express'); const router = Router(); ${publish}`,
      'server.js': `const { router } = require('./router'); router.get('/phantom', () => {});`,
    });
    expect(result.registrations).toEqual([]);
  });

  it.each([
    [`exports = {}; exports.router = router;`, `const { router } = require('./router');`],
    [
      `module.exports = router; module.exports.get = replacement;`,
      `const router = require('./router');`,
    ],
  ])('declines detached or mutated CommonJS export values: %s', (publish, consume) => {
    const result = resolve({
      'router.js': `const { Router } = require('express'); const router = Router(); ${publish}`,
      'server.js': `${consume} router.get('/phantom', () => {});`,
    });
    expect(result.registrations).toEqual([]);
  });

  it('declines unresolved stars that could conflict with a proven named export', () => {
    const result = resolve({
      'router.ts': `import {Router} from 'express'; export const api = Router();`,
      'barrel.ts': `export * from './router'; export * from './unavailable';`,
      'server.ts': `import {api} from './barrel'; api.get('/uncertain', h);`,
    });
    expect(result.registrations).toEqual([]);
  });

  it('terminates seedless export cycles but retains an explicit seeded export', () => {
    const result = resolve({
      'one.ts': `export * from './two'; import {Router} from 'express'; export const api = Router();`,
      'two.ts': `export * from './one'; export {missing} from './three';`,
      'three.ts': `export {missing} from './two';`,
      'server.ts': `import {api, missing} from './two'; api.get('/seed', h); missing.get('/cycle', h);`,
    });
    expect(result.registrations.map((registration) => registration.route.routePath)).toEqual([
      '/seed',
    ]);
  });

  it('invalidates imported values when another file writes through an alias', () => {
    const result = resolve({
      'router.ts': `import {Router} from 'express'; export const api = Router(); api.get('/unsafe', h);`,
      'mutation.ts': `import {api as alias} from './router'; alias.get = replacement;`,
    });
    expect(result.registrations).toEqual([]);
  });

  it.each([
    [
      `import {Router} from 'express'; export const api = Router(), other = Router();`,
      `import * as routes from './router';`,
      `import {api, other} from './router';`,
    ],
    [
      `const {Router} = require('express'); exports.api = Router(); exports.other = Router();`,
      `const routes = require('./router');`,
      `const {api, other} = require('./router');`,
    ],
  ])('invalidates Routers mutated through a module object: %#', (publish, namespace, consume) => {
    const result = resolve({
      'router.js': publish,
      'mutation.js': `${namespace} routes.api.get = () => {}; routes.other.post = () => {};`,
      'server.js': `${consume} api.get('/phantom', () => {}); other.post('/also-phantom', () => {});`,
    });
    expect(composeFrameworkRoutePaths(result)).toEqual([]);
  });

  it.each([`app.locals.title = 'demo';`, `app.use = () => {};`, `delete app.use;`])(
    'does not revive local paths when a mount parent is mutated: %s',
    (mutation) => {
      const result = resolve({
        'server.ts': `import express from 'express';
        const app = express(), router = express.Router();
        ${mutation}
        app.use('/api', [router]);
        router.get('/users', () => {});`,
      });
      expect(composeFrameworkRoutePaths(result)).toEqual([]);
    },
  );

  it('preserves an independent valid mount when another parent is mutated', () => {
    const result = resolve({
      'server.ts': `import express from 'express';
        const app = express(), safe = express(), router = express.Router();
        app.locals.title = 'demo';
        app.use('/uncertain', router); safe.use('/safe', router);
        router.get('/users', () => {});`,
    });
    expect(composeFrameworkRoutePaths(result).map((route) => route.routePath)).toEqual([
      '/safe/users',
    ]);
  });

  it.each([false, true])('retains uncertain array mounts alongside safe mount=%s', (safeMount) => {
    const result = resolve({
      'server.ts': `import express from 'express';
        const app = express(), safe = express(), router = express.Router();
        const list = [router]; list.push = other;
        app.use('/api', list);
        ${safeMount ? "safe.use('/safe', router);" : ''}
        router.get('/users', () => {});`,
    });
    expect(composeFrameworkRoutePaths(result).map((route) => route.routePath)).toEqual(
      safeMount ? ['/safe/users'] : [],
    );
  });

  it('does not suppress standalone routes for an unproven mount receiver', () => {
    const result = resolve({
      'server.ts': `import express from 'express';
        const router = express.Router(); storage.use('/unknown', router);
        router.get('/users', () => {});`,
    });
    expect(composeFrameworkRoutePaths(result).map((route) => route.routePath)).toEqual(['/users']);
  });

  it('bounds repeated star-barrel exploration while preserving unrelated routes', () => {
    const sources: Record<string, string> = {
      'base.ts': `export const other = 1;`,
      'server.ts': `import {missing} from './a24'; import express from 'express'; missing.get('/unknown', h); const app = express(); app.get('/safe', h);`,
    };
    for (let level = 0; level < 25; level++) {
      const exports =
        level === 0
          ? `export * from './base';`
          : `export * from './a${level - 1}'; export * from './b${level - 1}';`;
      sources[`a${level}.ts`] = exports;
      sources[`b${level}.ts`] = exports;
    }
    expect(
      resolve(sources).registrations.map((registration) => registration.route.routePath),
    ).toEqual(['/safe']);
  });

  it('round-trips compact facts through JSON with identical resolved output', () => {
    const file = facts(
      `import express from 'express'; const app = express(); const r = express.Router(); r.get('/x', handler); app.use('/api', r);`,
    );
    const original = resolveFrameworkRouteFacts([file], () => []);
    expect(resolveFrameworkRouteFacts(JSON.parse(JSON.stringify([file])), () => [])).toEqual(
      original,
    );
    expect(JSON.stringify(file)).not.toContain('namedChildren');
  });
});
