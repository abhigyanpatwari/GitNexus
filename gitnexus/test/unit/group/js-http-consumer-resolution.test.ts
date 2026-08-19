import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  TYPESCRIPT_HTTP_PLUGIN,
  JAVASCRIPT_HTTP_PLUGIN,
} from '../../../src/core/group/extractors/http-patterns/node.js';
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

  it('resolves a relative import as well as an alias-style one', () => {
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
});
