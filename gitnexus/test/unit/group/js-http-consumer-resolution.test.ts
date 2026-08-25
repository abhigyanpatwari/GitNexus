import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  TYPESCRIPT_HTTP_PLUGIN,
  JAVASCRIPT_HTTP_PLUGIN,
} from '../../../src/core/group/extractors/http-patterns/node.js';
import { resolveJsImport } from '../../../src/core/ingestion/route-extractors/js-const-resolver.js';
import type { HttpDetection } from '../../../src/core/group/extractors/http-patterns/types.js';

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

// Compiled tree-sitter queries are grammar-bound, so a plugin must be driven
// with a tree parsed by ITS grammar.
const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

/**
 * Drive the plugin the way the orchestrator does: a `prepareRepo` pre-pass over
 * a virtual repo, then a per-file `scan` with the resulting context.
 */
function scanRepo(files: Record<string, string>, target: string): HttpDetection[] {
  const paths = Object.keys(files);
  const repoContext = TYPESCRIPT_HTTP_PLUGIN.prepareRepo?.({
    repoPath: '/repo',
    files: paths,
    parser: tsParser,
    readFile: (rel) => files[rel] ?? null,
    parseSource: (parser, src) => parser.parse(src),
  });
  return TYPESCRIPT_HTTP_PLUGIN.scan(tsParser.parse(files[target]), repoContext, target);
}

const consumers = (detections: HttpDetection[]) => detections.filter((d) => d.role === 'consumer');

/** `scanRepo`, but the pre-pass may fail on chosen files. */
function scanRepoWithParse(
  files: Record<string, string>,
  target: string,
  parseSource: (parser: Parser, src: string) => Parser.Tree | null,
): HttpDetection[] {
  const repoContext = TYPESCRIPT_HTTP_PLUGIN.prepareRepo?.({
    repoPath: '/repo',
    files: Object.keys(files),
    parser: tsParser,
    readFile: (rel) => files[rel] ?? null,
    parseSource,
  });
  return TYPESCRIPT_HTTP_PLUGIN.scan(tsParser.parse(files[target]), repoContext, target);
}

// The shape the finding was reported against: a configured client in one file,
// a frozen route table in another, and call sites that reference both by name.
const AXIOS_CONFIG = `
  import axios from 'axios';
  const axiosInstance = axios.create({ baseURL: process.env.API_URL });
  const routeApiClient = axiosInstance;
  export default routeApiClient;
`;

const API_ROUTES = `
  export const API_ROUTE_PATH = {
    LINKS: "/links",
    EVENTS: "/events",
    CURATOR_LISTS: "/curator-lists",
  } as const;
`;

describe('JS/TS HTTP consumer resolution', () => {
  it('resolves a configured client and a table path imported from other files', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api-modules/shared/api-routes.ts': API_ROUTES,
        'src/api-modules/curators/curators.api.ts': `
          import routeApiClient from '@/lib/axios.config';
          import { API_ROUTE_PATH } from '@/api-modules/shared/api-routes';
          export async function getLists() {
            return routeApiClient.get(API_ROUTE_PATH.CURATOR_LISTS, {});
          }
        `,
      },
      'src/api-modules/curators/curators.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ role: 'consumer', method: 'GET', path: '/curator-lists' }),
    );
  });

  it('resolves relative imports for the client and the route table', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/routes.ts': API_ROUTES,
        'src/api/links.api.ts': `
          import client from '../lib/axios.config';
          import { API_ROUTE_PATH } from './routes';
          export const load = () => client.post(API_ROUTE_PATH.LINKS);
        `,
      },
      'src/api/links.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/links' }),
    );
  });

  it('folds a template partially, keeping the resolved prefix', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/routes.ts': API_ROUTES,
        'src/api/curators.api.ts': `
          import client from '../lib/axios.config';
          import { API_ROUTE_PATH } from './routes';
          export const add = (eventId: string) =>
            client.post(\`\${API_ROUTE_PATH.CURATOR_LISTS}/\${eventId}/add-to-list\`);
        `,
      },
      'src/api/curators.api.ts',
    );

    // The unresolvable `${eventId}` stays a placeholder for consumer-side
    // normalization to read as {param}; the known prefix is no longer lost.
    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ path: '/curator-lists/${eventId}/add-to-list' }),
    );
  });

  it('resolves a `+` concatenation against an imported base constant', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/base.ts': `export const BASE = "/api/v1";`,
        'src/api/users.api.ts': `
          import client from '../lib/axios.config';
          import { BASE } from './base';
          export const list = () => client.get(BASE + "/users");
        `,
      },
      'src/api/users.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/api/v1/users' }),
    );
  });

  it('follows a barrel re-export to the defining module', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/routes.ts': API_ROUTES,
        'src/api/index.ts': `export { API_ROUTE_PATH } from './routes';`,
        'src/api/events.api.ts': `
          import client from '../lib/axios.config';
          import { API_ROUTE_PATH } from './index';
          export const list = () => client.get(API_ROUTE_PATH.EVENTS);
        `,
      },
      'src/api/events.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/events' }),
    );
  });

  // ─── Shapes real applications actually ship ────────────────────────

  it('proves a client built by a factory wrapper, not just a bare axios.create', () => {
    const detections = scanRepo(
      {
        // The shape Sourcerer-fe ships: the instance is an argument to a
        // decorator that returns the configured client.
        'src/lib/axios.config.ts': `
          import axios from 'axios';
          const routeApiClient = setupClientInterceptors({
            axiosInstance: axios.create({ baseURL: API_URL }),
            onError: (e) => e,
          });
          export default routeApiClient;
        `,
        'src/api/routes.ts': API_ROUTES,
        'src/api/links.api.ts': `
          import routeApiClient from '@/lib/axios.config';
          import { API_ROUTE_PATH } from '@/api/routes';
          export const load = () => routeApiClient.get(API_ROUTE_PATH.LINKS);
        `,
      },
      'src/api/links.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/links' }),
    );
  });

  it('follows `export *` through a directory barrel', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api-modules/shared/api-routes.ts': API_ROUTES,
        'src/api-modules/shared/index.ts': `
          export * from "./api-routes";
          export * from "./query-keys";
        `,
        'src/api-modules/shared/query-keys.ts': `export const QUERY_KEYS = { A: "a" };`,
        'src/api-modules/curators/curators.api.ts': `
          import client from '@/lib/axios.config';
          import { API_ROUTE_PATH } from '@/api-modules/shared';
          export const get = () => client.get(API_ROUTE_PATH.CURATOR_LISTS);
        `,
      },
      'src/api-modules/curators/curators.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/curator-lists' }),
    );
  });

  it('recognizes an aliased axios import', () => {
    const detections = scanRepo(
      {
        'src/lib/client.ts': `
          import ax from 'axios';
          export default ax.create({ baseURL: '/' });
        `,
        'src/api/routes.ts': API_ROUTES,
        'src/api/events.api.ts': `
          import client from '../lib/client';
          import { API_ROUTE_PATH } from './routes';
          export const list = () => client.get(API_ROUTE_PATH.EVENTS);
        `,
      },
      'src/api/events.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/events' }),
    );
  });

  it('keeps literal segments of a template nested inside a substitution', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/routes.ts': API_ROUTES,
        'src/api/events.api.ts': `
          import client from '../lib/axios.config';
          import { API_ROUTE_PATH } from './routes';
          export const unlike = (id: string) =>
            client.delete(\`\${API_ROUTE_PATH.EVENTS}\${\`/\${id}/unlike\`}\`);
        `,
      },
      'src/api/events.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ path: '/events/${id}/unlike' }),
    );
  });

  it('does not let a client built inside a callback vouch for the outer name', () => {
    const detections = scanRepo(
      {
        'src/thing.ts': `
          const thing = configure(() => axios.create({ baseURL: '/' }));
          export const read = () => thing.get('/users');
        `,
      },
      'src/thing.ts',
    );

    expect(consumers(detections)).toEqual([]);
  });

  // ─── Precision guards ──────────────────────────────────────────────

  it('does NOT emit an Express provider route as a consumer of itself', () => {
    const detections = scanRepo(
      {
        'src/server.ts': `
          import express from 'express';
          const router = express.Router();
          router.get('/users', listUsers);
          app.post('/orders', createOrder);
        `,
      },
      'src/server.ts',
    );

    expect(consumers(detections)).toEqual([]);
    // …while still being seen as providers.
    expect(detections.filter((d) => d.role === 'provider').map((d) => d.path)).toEqual(
      expect.arrayContaining(['/users', '/orders']),
    );
  });

  it('does NOT claim an unproven receiver that merely has a .get method', () => {
    const detections = scanRepo(
      {
        'src/cache.ts': `
          const cache = new Map<string, string>();
          const store = { get: (k: string) => k };
          export const read = () => cache.get('/users') ?? store.get('/orders');
        `,
      },
      'src/cache.ts',
    );

    expect(consumers(detections)).toEqual([]);
  });

  it('refuses to resolve an import whose specifier matches two files', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'a/shared/routes.ts': API_ROUTES,
        'b/shared/routes.ts': `export const API_ROUTE_PATH = { LINKS: "/other-links" } as const;`,
        'src/api/links.api.ts': `
          import client from '../lib/axios.config';
          import { API_ROUTE_PATH } from 'shared/routes';
          export const load = () => client.get(API_ROUTE_PATH.LINKS);
        `,
      },
      'src/api/links.api.ts',
    );

    // Two candidates for `shared/routes` — an unresolved path is correct here;
    // guessing either one would invent a cross-repo link.
    expect(consumers(detections)).toEqual([]);
  });

  // ─── Backward compatibility ────────────────────────────────────────

  it('still detects a bare axios call with a literal path and no repo context', () => {
    const detections = JAVASCRIPT_HTTP_PLUGIN.scan(
      jsParser.parse(`axios.get('/legacy'); axios.post('/legacy', body);`),
    );

    expect(consumers(detections)).toEqual([
      expect.objectContaining({ method: 'GET', path: '/legacy' }),
      expect.objectContaining({ method: 'POST', path: '/legacy' }),
    ]);
  });

  it('preserves the raw template when there is no repo context to fold against', () => {
    const detections = JAVASCRIPT_HTTP_PLUGIN.scan(jsParser.parse('axios.get(`/users/${id}`);'));

    expect(consumers(detections)).toContainEqual(expect.objectContaining({ path: '/users/${id}' }));
  });

  it('drops a non-literal path it cannot resolve rather than emitting its text', () => {
    const detections = JAVASCRIPT_HTTP_PLUGIN.scan(
      jsParser.parse(`axios.get(API_ROUTE_PATH.LINKS);`),
    );

    expect(consumers(detections)).toEqual([]);
  });

  // ─── Review findings: precision, termination and keying ────────────

  it('keys the fact map the same way on a platform that hands it backslashes', () => {
    // glob v13 is called without `posix: true` and its walker joins with the
    // platform separator, so on Windows every path here arrives backslashed.
    const files = {
      'src\\lib\\axios.config.ts': AXIOS_CONFIG,
      'src\\api\\routes.ts': API_ROUTES,
      'src\\api\\links.api.ts': `
        import client from '../lib/axios.config';
        import { API_ROUTE_PATH } from './routes';
        export const load = () => client.get(API_ROUTE_PATH.LINKS);
      `,
    };

    expect(consumers(scanRepo(files, 'src\\api\\links.api.ts'))).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/links' }),
    );
  });

  it('does NOT treat a container that merely HOLDS an axios instance as a client', () => {
    const detections = scanRepo(
      {
        'src/stores.ts': `
          import axios from 'axios';
          const registry = { http: axios.create({ baseURL: '/' }), version: 'v1' };
          const picked = MOCK ? memoryStore : axios.create({ baseURL: '/' });
          const pool = new Map([['api', axios.create({ baseURL: '/' })]]);
          export const read = () => [
            registry.get('/settings'),
            picked.get('/feature-flags'),
            pool.get('/tenant'),
          ];
        `,
      },
      'src/stores.ts',
    );

    expect(consumers(detections)).toEqual([]);
  });

  it('still proves the factory shape the containment rule existed for', () => {
    const detections = scanRepo(
      {
        'src/lib/client.ts': `
          import axios from 'axios';
          export default withRetries(setupInterceptors(axios.create({ baseURL: '/' })));
        `,
        'src/api/routes.ts': API_ROUTES,
        'src/api/links.api.ts': `
          import client from '../lib/client';
          import { API_ROUTE_PATH } from './routes';
          export const load = () => client.get(API_ROUTE_PATH.LINKS);
        `,
      },
      'src/api/links.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/links' }),
    );
  });

  it('refuses a resolved constant that is not path-shaped', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/strings.ts': `
          export const CONFIG = { TIMEOUT: "5000" } as const;
          export const MSG = { ERROR: "Could not reach the server" } as const;
        `,
        'src/api/calls.api.ts': `
          import api from '../lib/axios.config';
          import { CONFIG, MSG } from './strings';
          export const a = () => api.get(CONFIG.TIMEOUT);
          export const b = () => api.post(MSG.ERROR);
        `,
      },
      'src/api/calls.api.ts',
    );

    // "5000" normalizes to /{param} and matches every one-segment provider
    // route in the group; the message normalizes to a path with spaces in it.
    expect(consumers(detections)).toEqual([]);
  });

  it('refuses a path whose leading term never resolved', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/unanchored.api.ts': `
          import client from '../lib/axios.config';
          const BASE = process.env.NEXT_PUBLIC_API_URL;
          export const a = (x, y) => client.get(\`\${x}\${y}\`);
          export const b = () => client.get(BASE + '/users');
        `,
      },
      'src/api/unanchored.api.ts',
    );

    // `${x}${y}` squashes to /{param}{param} and `${BASE}/users` to
    // /{param}/users — both exact-match real provider routes.
    expect(consumers(detections)).toEqual([]);
  });

  it('caps the folded output instead of building a path of unbounded length', () => {
    const pad = 'a'.repeat(4000);
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/big.api.ts': `
          import client from '../lib/axios.config';
          const PAD = "/${pad}";
          export const load = () => client.get(PAD + PAD + PAD);
        `,
      },
      'src/api/big.api.ts',
    );

    // Each term is under the core's 8 192-char cap; their concatenation is not,
    // and the result is persisted into contractId / meta.path.
    expect(consumers(detections)).toEqual([]);
  });

  it('terminates on expressions deep enough to overflow the stack', () => {
    // `scan` is contractually non-throwing: `sync.ts` turns a throw here into an
    // unexplained "missing repo" that silently drops every contract of every
    // kind for that repo. Both shapes recursed once per term before this.
    // 3 000 is near this tree-sitter build's own parse ceiling for a `+` chain;
    // nested templates parse to ~6 000, and at 4 000 the unbounded fold threw
    // `RangeError: Maximum call stack size exceeded` straight out of `scan`.
    const chain = Array.from({ length: 3000 }, (_, i) => `"/s${i}"`).join(' + ');
    let nested = '`/x`';
    for (let i = 0; i < 4000; i++) nested = '`${' + nested + '}`';

    expect(() => scanRepo({ 'src/a.ts': `axios.get(${chain});` }, 'src/a.ts')).not.toThrow();
    expect(() => scanRepo({ 'src/b.ts': `axios.get(${nested});` }, 'src/b.ts')).not.toThrow();
  });

  it('survives a file whose parse throws, and still resolves the rest of the repo', () => {
    const detections = scanRepoWithParse(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/routes.ts': API_ROUTES,
        'src/api/poison.ts': `export const X = "/x";`,
        'src/api/links.api.ts': `
          import client from '../lib/axios.config';
          import { API_ROUTE_PATH } from './routes';
          export const load = () => client.get(API_ROUTE_PATH.LINKS);
        `,
      },
      'src/api/links.api.ts',
      (parser, src) => {
        if (src.includes('"/x"')) throw new Error('ParseTimeoutError');
        return parser.parse(src);
      },
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/links' }),
    );
  });

  it('sees an axios import declared below the binding that uses it', () => {
    const detections = scanRepo(
      {
        // ES module bindings are hoisted, so this is legal and binds the same `ax`.
        'src/lib/late.ts': `
          const client = ax.create({ baseURL: '/' });
          import ax from 'axios';
          export default client;
        `,
        'src/api/routes.ts': API_ROUTES,
        'src/api/links.api.ts': `
          import client from '../lib/late';
          import { API_ROUTE_PATH } from './routes';
          export const load = () => client.get(API_ROUTE_PATH.LINKS);
        `,
      },
      'src/api/links.api.ts',
    );

    expect(consumers(detections)).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/links' }),
    );
  });

  it('keeps a partially folded path whose unresolved term contains spaces', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/routes.ts': API_ROUTES,
        'src/api/events.api.ts': `
          import client from '../lib/axios.config';
          import { API_ROUTE_PATH } from './routes';
          export const list = (draft: boolean, page?: number) => [
            client.get(\`\${API_ROUTE_PATH.EVENTS}/\${draft ? 'draft' : 'live'}\`),
            client.get(\`\${API_ROUTE_PATH.LINKS}/\${page ?? 1}\`),
          ];
        `,
      },
      'src/api/events.api.ts',
    );

    // The placeholder is a runtime value that consumer normalization reads as
    // {param}; its source text is not part of the path shape.
    expect(consumers(detections).map((d) => d.path)).toEqual(
      expect.arrayContaining([
        "/events/${draft ? 'draft' : 'live'}",
        '/links/${page ?? 1}',
      ]),
    );
  });

  it('does not remove a detection the literal axios receiver already produced', () => {
    // Before the query was widened this shape matched and normalized to
    // /{param}/users. Anchoring applies to what the widening newly admits, not
    // to output that already shipped.
    const detections = JAVASCRIPT_HTTP_PLUGIN.scan(
      jsParser.parse('axios.get(`${API_BASE}/users`); axios.get(`${a}${b}`);'),
    );

    expect(consumers(detections).map((d) => d.path)).toEqual([
      '${API_BASE}/users',
      '${a}${b}',
    ]);
  });

  it('caps the literal fallback of an oversized template too', () => {
    const pad = 'a'.repeat(9000);
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/big.api.ts': `
          import client from '../lib/axios.config';
          export const load = (id: string) => client.get(\`/${pad}\${id}\`);
        `,
      },
      'src/api/big.api.ts',
    );

    expect(consumers(detections)).toEqual([]);
  });

  it('proves a client handed to a factory inside a nested options object', () => {
    const detections = scanRepo(
      {
        'src/lib/client.ts': `
          import axios from 'axios';
          export default createClient({ transport: { instance: axios.create({}) } });
        `,
        'src/lib/composed.ts': `
          import axios from 'axios';
          export default compose([axios.create({}), withAuth]);
        `,
        'src/api/routes.ts': API_ROUTES,
        'src/api/links.api.ts': `
          import nested from '../lib/client';
          import composed from '../lib/composed';
          import { API_ROUTE_PATH } from './routes';
          export const a = () => nested.get(API_ROUTE_PATH.LINKS);
          export const b = () => composed.get(API_ROUTE_PATH.EVENTS);
        `,
      },
      'src/api/links.api.ts',
    );

    expect(consumers(detections).map((d) => d.path)).toEqual(
      expect.arrayContaining(['/links', '/events']),
    );
  });

  it('refuses a name two `export *` barrels both provide', () => {
    const detections = scanRepo(
      {
        'src/lib/axios.config.ts': AXIOS_CONFIG,
        'src/api/a.ts': `export const API_ROUTE_PATH = { LINKS: "/links-a" } as const;`,
        'src/api/b.ts': `export const API_ROUTE_PATH = { LINKS: "/links-b" } as const;`,
        'src/api/index.ts': `
          export * from './a';
          export * from './b';
        `,
        'src/api/links.api.ts': `
          import client from '../lib/axios.config';
          import { API_ROUTE_PATH } from './index';
          export const load = () => client.get(API_ROUTE_PATH.LINKS);
        `,
      },
      'src/api/links.api.ts',
    );

    expect(consumers(detections)).toEqual([]);
  });

  it('does NOT bind a Node builtin specifier to a same-named repo file', () => {
    const detections = scanRepo(
      {
        'src/lib/http.ts': `
          import axios from 'axios';
          export default axios.create({ baseURL: '/' });
        `,
        'src/api/health.ts': `
          import http from 'http';
          export const ping = () => http.get('http://example.com/health');
        `,
      },
      'src/api/health.ts',
    );

    expect(consumers(detections)).toEqual([]);
  });

  it('measures the pre-pass ceiling in bytes, not UTF-16 code units', () => {
    // Under 512 Ki code units, over 512 KiB of UTF-8 — the ceiling mirrors the
    // analyzer's byte-size limit, so this file must be skipped.
    const detections = scanRepo(
      {
        'src/lib/huge.ts': `
          import axios from 'axios';
          // ${'á'.repeat(300_000)}
          export default axios.create({ baseURL: '/' });
        `,
        'src/api/links.api.ts': `
          import client from '../lib/huge';
          export const load = () => client.get('/links');
        `,
      },
      'src/api/links.api.ts',
    );

    expect(consumers(detections)).toEqual([]);
  });
});

describe('resolveJsImport', () => {
  const keys = (...paths: string[]) => new Set(paths);

  it('refuses a tail two different modules claim, across extensions', () => {
    expect(
      resolveJsImport('src/x.ts', '@/shared/routes', keys('a/shared/routes.ts', 'b/shared/routes.ts')),
    ).toBeNull();
    expect(
      resolveJsImport('src/x.ts', '@/shared/routes', keys('a/shared/routes.ts', 'b/shared/routes.tsx')),
    ).toBeNull();
    expect(
      resolveJsImport('src/x.ts', '@/shared/routes', keys('a/shared/routes.ts', 'b/shared/routes.js')),
    ).toBeNull();
    expect(
      resolveJsImport(
        'src/x.ts',
        '@/shared/routes',
        keys('a/shared/routes.ts', 'b/shared/routes/index.ts'),
      ),
    ).toBeNull();
  });

  it('keeps extension precedence when the matches are one module', () => {
    // `x/routes.ts` and `x/routes/index.ts` are two spellings of `x/routes`;
    // Node and tsc both pick the file, so this is precedence, not ambiguity.
    expect(
      resolveJsImport('src/a.ts', '@/x/routes', keys('src/x/routes.ts', 'src/x/routes/index.ts')),
    ).toBe('src/x/routes.ts');
    expect(resolveJsImport('src/a.ts', '@/x/routes', keys('src/x/routes.tsx'))).toBe(
      'src/x/routes.tsx',
    );
  });

  it('never resolves a single-segment bare specifier to a repo file', () => {
    // A bare npm package or Node builtin is not ours to resolve — and this is
    // also the hot path: the unindexed sweep that ran here cost 19.6x on a
    // 4 000-file repo whose only trigger was `import _ from 'lodash'`.
    expect(resolveJsImport('src/a.ts', 'http', keys('src/lib/http.ts'))).toBeNull();
    expect(resolveJsImport('src/a.ts', 'axios', keys('src/lib/axios.ts'))).toBeNull();
    expect(resolveJsImport('src/a.ts', 'lodash', keys('src/lodash.ts'))).toBeNull();
  });

  it('still resolves alias and relative specifiers', () => {
    expect(resolveJsImport('src/a/b.ts', './c', keys('src/a/c.ts'))).toBe('src/a/c.ts');
    expect(resolveJsImport('src/a/b.ts', '@/lib/http', keys('src/lib/http.ts'))).toBe(
      'src/lib/http.ts',
    );
    expect(resolveJsImport('src/a/b.ts', 'lib/http', keys('src/lib/http.ts'))).toBe(
      'src/lib/http.ts',
    );
  });
});
