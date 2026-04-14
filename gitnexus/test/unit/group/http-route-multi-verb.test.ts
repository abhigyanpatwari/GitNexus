/**
 * Coverage tests for `HttpRouteExtractor` graph-assisted paths —
 * specifically the multi-verb same-path regression (Codex finding F2).
 *
 * The bug: `extractProvidersGraph` / `extractConsumersGraph` used
 * `detections.find(d => normalizeHttpPath(d.path) === routePath)` to
 * backfill handler name and (for providers) method. On a file with
 * multiple verbs at the same normalized path (e.g. `GET /api/orders`
 * and `POST /api/orders` in one router), `.find()` returned the first
 * match, silently attaching the wrong handler and/or method.
 *
 * Strategy: mock `./http-patterns/index.js` + `./fs-utils.js` so we
 * can inject a synthetic `HttpDetection[]` per file without needing
 * real tree-sitter grammars. The `db` executor is a vi.fn() that
 * returns stubbed rows for the HANDLES_ROUTE / FETCHES / CONTAINS
 * queries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Parser from 'tree-sitter';
import type { HttpDetection } from '../../../src/core/group/extractors/http-patterns/types.js';

// Per-file detections injected into the mocked plugin.
const FILE_DETECTIONS = new Map<string, HttpDetection[]>();

vi.mock('../../../src/core/group/extractors/fs-utils.js', () => ({
  readSafe: (_repo: string, _rel: string) => 'stub content',
}));

vi.mock('../../../src/core/group/extractors/http-patterns/index.js', () => {
  return {
    HTTP_SCAN_GLOB: '**/*.fake',
    getPluginForFile: (rel: string) => ({
      name: 'fake',
      language: {},
      scan: (_tree: Parser.Tree) => FILE_DETECTIONS.get(rel) ?? [],
    }),
  };
});

// Patch tree-sitter Parser so `.setLanguage()` + `.parse()` don't
// require a real grammar — the mocked plugin's scan() ignores the
// tree anyway.
vi.mock('tree-sitter', () => {
  class FakeParser {
    setLanguage(_lang: unknown) {}
    parse(_src: string) {
      return {} as Parser.Tree;
    }
  }
  return { default: FakeParser };
});

import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';

function detection(
  role: 'provider' | 'consumer',
  method: string,
  p: string,
  name: string | null,
): HttpDetection {
  return { role, framework: 'test', method, path: p, name, confidence: 0.8 };
}

describe('HttpRouteExtractor — graph-assisted multi-verb disambiguation', () => {
  beforeEach(() => {
    FILE_DETECTIONS.clear();
  });

  // Helper to build a CONTAINS response covering all handler names in a file.
  const containsFor = (names: string[]) =>
    names.map((name, i) => ({
      uid: `uid-${name}`,
      name,
      filePath: 'routes.ts',
      labels: ['Function'],
      0: `uid-${name}`,
      1: name,
      2: 'routes.ts',
      3: ['Function'],
    }));

  // ── Provider: happy path (single match) ────────────────────────────
  it('provider: single detection backfills handler name as today', async () => {
    FILE_DETECTIONS.set('routes.ts', [detection('provider', 'GET', '/api/orders', 'listOrders')]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            routeId: 'r1',
            responseKeys: [],
            routeSource: 'decorator-Get',
          },
        ];
      }
      if (query.includes('CONTAINS')) return containsFor(['listOrders']);
      return [];
    });

    const ex = new HttpRouteExtractor();
    const out = await ex.extract(db, '/repo', { name: 'r', url: 'r' } as never);
    expect(out).toHaveLength(1);
    expect(out[0].symbolName).toBe('listOrders');
    expect(out[0].meta.method).toBe('GET');
  });

  // ── Provider: multi-verb, method KNOWN (POST) ──────────────────────
  it('provider: multi-verb with method known picks the matching verb (POST)', async () => {
    FILE_DETECTIONS.set('routes.ts', [
      detection('provider', 'GET', '/api/orders', 'listOrders'),
      detection('provider', 'POST', '/api/orders', 'createOrder'),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            routeSource: 'decorator-Post',
          },
        ];
      }
      if (query.includes('CONTAINS')) return containsFor(['listOrders', 'createOrder']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].symbolName).toBe('createOrder');
    expect(out[0].meta.method).toBe('POST');
  });

  it('provider: multi-verb with method known picks the matching verb (GET)', async () => {
    FILE_DETECTIONS.set('routes.ts', [
      detection('provider', 'GET', '/api/orders', 'listOrders'),
      detection('provider', 'POST', '/api/orders', 'createOrder'),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            routeSource: 'decorator-Get',
          },
        ];
      }
      if (query.includes('CONTAINS')) return containsFor(['listOrders', 'createOrder']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].symbolName).toBe('listOrders');
    expect(out[0].meta.method).toBe('GET');
  });

  // ── Provider: multi-verb, method UNKNOWN → refuse to guess ─────────
  it('provider: multi-verb with method unknown skips backfill (no silent inheritance)', async () => {
    FILE_DETECTIONS.set('routes.ts', [
      detection('provider', 'GET', '/api/orders', 'listOrders'),
      detection('provider', 'POST', '/api/orders', 'createOrder'),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            routeSource: 'unknown-reason', // methodFromRouteReason → null
          },
        ];
      }
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out).toHaveLength(1);
    // CRITICAL: must NOT silently inherit POST from createOrder via .find()
    expect(out[0].meta.method).toBe('GET'); // conservative default
    // CRITICAL: must NOT silently attach createOrder as handler
    expect(out[0].symbolName).not.toBe('createOrder');
    // With no CONTAINS rows, handlerName stays null and file-basename fallback wins.
    expect(out[0].symbolName).toBe('routes.ts');
  });

  // ── Provider: multi-verb + CONTAINS rows → must still refuse to guess ──
  it('provider: ambiguous multi-verb skips CONTAINS enrichment (no silent pool[0] pick)', async () => {
    // Regression test for Copilot's review on PR #817. Before the fix,
    // the ambiguous-case code path left `handlerName` null but still ran
    // the CONTAINS DB query, and `pickSymbolUid(syms, null)` silently
    // picked pool[0] — reintroducing handler mis-attribution via a
    // different route than `.find()`.
    FILE_DETECTIONS.set('routes.ts', [
      detection('provider', 'GET', '/api/orders', 'listOrders'),
      detection('provider', 'POST', '/api/orders', 'createOrder'),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            routeSource: 'unknown-reason',
          },
        ];
      }
      if (query.includes('CONTAINS')) return containsFor(['listOrders', 'createOrder']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out).toHaveLength(1);
    // Ambiguous → do not attribute to any real handler in the file.
    expect(out[0].symbolName).not.toBe('listOrders');
    expect(out[0].symbolName).not.toBe('createOrder');
    expect(out[0].symbolUid).toBe('');
    expect(out[0].symbolName).toBe('routes.ts');
    expect(out[0].meta.method).toBe('GET');
    // CONTAINS query must have been skipped entirely under ambiguity.
    const calls = db.mock.calls.map(([q]) => q as string);
    expect(calls.some((q) => q.includes('CONTAINS'))).toBe(false);
  });

  // ── Provider: three-verb method known ──────────────────────────────
  it('provider: three verbs at same path with method known still matches correctly', async () => {
    FILE_DETECTIONS.set('routes.ts', [
      detection('provider', 'GET', '/api/orders', 'listOrders'),
      detection('provider', 'POST', '/api/orders', 'createOrder'),
      detection('provider', 'PUT', '/api/orders', 'replaceOrder'),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            routeSource: 'decorator-Put',
          },
        ];
      }
      if (query.includes('CONTAINS'))
        return containsFor(['listOrders', 'createOrder', 'replaceOrder']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out[0].symbolName).toBe('replaceOrder');
    expect(out[0].meta.method).toBe('PUT');
  });

  // ── Provider: unrelated path detections don't false-positive ───────
  it('provider: detection for unrelated path does not backfill', async () => {
    FILE_DETECTIONS.set('routes.ts', [detection('provider', 'POST', '/api/users', 'createUser')]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            routeSource: 'unknown',
          },
        ];
      }
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out[0].meta.method).toBe('GET');
    expect(out[0].symbolName).not.toBe('createUser');
  });

  // ── Integration: one row, two detections, one out.push ─────────────
  it('integration: one db row with two same-path detections yields exactly one contract', async () => {
    FILE_DETECTIONS.set('routes.ts', [
      detection('provider', 'GET', '/api/orders', 'listOrders'),
      detection('provider', 'POST', '/api/orders', 'createOrder'),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            routeSource: 'decorator-Post',
          },
        ];
      }
      if (query.includes('CONTAINS')) return containsFor(['listOrders', 'createOrder']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].meta.method).toBe('POST');
    expect(out[0].symbolName).toBe('createOrder');
  });

  // ── Consumer: single match ─────────────────────────────────────────
  it('consumer: single detection backfills method as today', async () => {
    FILE_DETECTIONS.set('client.ts', [detection('consumer', 'POST', '/api/orders', null)]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('FETCHES')) {
        return [
          {
            fileId: 'f1',
            filePath: 'client.ts',
            routePath: '/api/orders',
            fetchReason: 'fetch',
          },
        ];
      }
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].meta.method).toBe('POST');
  });

  // ── Consumer: multi-verb skips backfill ────────────────────────────
  it('consumer: multi-verb at same path skips backfill (conservative GET)', async () => {
    FILE_DETECTIONS.set('client.ts', [
      detection('consumer', 'GET', '/api/orders', null),
      detection('consumer', 'POST', '/api/orders', null),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('FETCHES')) {
        return [
          {
            fileId: 'f1',
            filePath: 'client.ts',
            routePath: '/api/orders',
            fetchReason: 'fetch',
          },
        ];
      }
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out).toHaveLength(1);
    // CRITICAL: must NOT silently pick POST (first/last via .find)
    expect(out[0].meta.method).toBe('GET'); // conservative default
    expect(out[0].contractId).toBe('http::GET::/api/orders');
  });
});
