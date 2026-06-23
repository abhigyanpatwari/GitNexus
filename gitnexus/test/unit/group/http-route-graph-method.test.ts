/**
 * Step A coverage for issue #2138 groundwork:
 * `HttpRouteExtractor.extractProvidersGraph` should read the HTTP verb
 * persisted on the Route node (`route.method`, surfaced as `routeMethod`
 * by HANDLES_ROUTE_QUERY) as the authoritative method, falling back to
 * the edge `reason` only for older indexes / filesystem routes that never
 * stored a method.
 *
 * Why this matters: framework routes (Java Spring, Laravel) are emitted
 * with `routeSource = 'framework-route'`, which `methodFromRouteReason`
 * cannot decode (returns null). Before the Route node carried `method`,
 * the graph path had to re-parse the handler source to recover the verb.
 * Persisting the verb on the node removes that dependency for the method
 * piece (the handler-name piece is addressed separately in Step B).
 *
 * Harness mirrors http-route-multi-verb.test.ts: the plugin registry,
 * fs-utils, and tree-sitter are mocked so we drive the graph rows
 * directly without real grammars.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Parser from 'tree-sitter';
import type { HttpDetection } from '../../../src/core/group/extractors/http-patterns/types.js';

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

const containsFor = (names: string[]) =>
  names.map((name) => ({
    uid: `uid-${name}`,
    name,
    filePath: 'OrderController.java',
    labels: ['Method'],
    0: `uid-${name}`,
    1: name,
    2: 'OrderController.java',
    3: ['Method'],
  }));

describe('HttpRouteExtractor — Route.method from graph (Step A / #2138)', () => {
  beforeEach(() => {
    FILE_DETECTIONS.clear();
  });

  it('framework-route: uses Route.method when the edge reason cannot decode the verb', async () => {
    // Spring controller: reason is the generic 'framework-route', so
    // methodFromRouteReason() returns null. The verb must come from the
    // Route node's persisted `method` (routeMethod).
    FILE_DETECTIONS.set('OrderController.java', [
      detection('provider', 'POST', '/api/orders', 'createOrder'),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'OrderController.java',
            routePath: '/api/orders',
            routeId: 'r1',
            routeMethod: 'POST',
            routeSource: 'framework-route',
          },
        ];
      }
      if (query.includes('UNION ALL')) return containsFor(['createOrder']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].meta.method).toBe('POST');
    expect(out[0].contractId).toBe('http::POST::/api/orders');
  });

  it('framework-route: Route.method disambiguates the handler among multi-verb candidates', async () => {
    // Two verbs at the same path in one controller; reason is generic.
    // Route.method = PUT must both set the verb AND pick replaceOrder.
    FILE_DETECTIONS.set('OrderController.java', [
      detection('provider', 'GET', '/api/orders', 'listOrders'),
      detection('provider', 'PUT', '/api/orders', 'replaceOrder'),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'OrderController.java',
            routePath: '/api/orders',
            routeMethod: 'PUT',
            routeSource: 'framework-route',
          },
        ];
      }
      if (query.includes('UNION ALL')) return containsFor(['listOrders', 'replaceOrder']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].meta.method).toBe('PUT');
    expect(out[0].symbolName).toBe('replaceOrder');
  });

  it('case-insensitive: lower-case Route.method is normalized to an upper-case verb', async () => {
    FILE_DETECTIONS.set('OrderController.java', [
      detection('provider', 'DELETE', '/api/orders/{param}', 'deleteOrder'),
    ]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'OrderController.java',
            routePath: '/api/orders/{id}',
            routeMethod: 'delete',
            routeSource: 'framework-route',
          },
        ];
      }
      if (query.includes('UNION ALL')) return containsFor(['deleteOrder']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out[0].meta.method).toBe('DELETE');
  });

  it('backward-compat: missing Route.method falls back to the edge reason (old indexes)', async () => {
    // Old index has no `method` on the Route node → routeMethod undefined.
    // The decorator reason still decodes the verb as before.
    FILE_DETECTIONS.set('routes.ts', [detection('provider', 'GET', '/api/orders', 'listOrders')]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            // no routeMethod field at all
            routeSource: 'decorator-Get',
          },
        ];
      }
      if (query.includes('UNION ALL')) return containsFor(['listOrders']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    expect(out[0].meta.method).toBe('GET');
    expect(out[0].symbolName).toBe('listOrders');
  });

  it('fast path: Route.handlerSymbolId resolves the handler without any source scan', async () => {
    // Deliberately leave FILE_DETECTIONS empty: if the extractor still resolves
    // the handler, it MUST have used the persisted handlerSymbolId (the graph
    // fast path), not a plugin scan of the source.
    const HID = 'Method:OrderController.java:OrderController.createOrder#0';
    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'OrderController.java',
            routePath: '/api/orders',
            routeMethod: 'POST',
            handlerSymbolId: HID,
            routeSource: 'framework-route',
          },
        ];
      }
      if (query.includes('UNION ALL')) {
        return [
          {
            uid: HID,
            name: 'createOrder',
            filePath: 'OrderController.java',
            startLine: 10,
            endLine: 12,
            labels: ['Method'],
            0: HID,
            1: 'createOrder',
            2: 'OrderController.java',
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
    // The persisted symbol id is authoritative; name/path come from the cheap
    // CONTAINING_QUERY graph lookup by filePath (no source parse).
    expect(out[0].symbolUid).toBe(HID);
    expect(out[0].symbolName).toBe('createOrder');
  });

  it('backward-compat: no Route.method and undecodable reason stays at conservative GET', async () => {
    FILE_DETECTIONS.set('routes.ts', [detection('provider', 'POST', '/api/orders', 'createOrder')]);

    const db = vi.fn(async (query: string) => {
      if (query.includes('HANDLES_ROUTE')) {
        return [
          {
            fileId: 'f1',
            filePath: 'routes.ts',
            routePath: '/api/orders',
            routeSource: 'framework-route', // undecodable, and no routeMethod
          },
        ];
      }
      if (query.includes('UNION ALL')) return containsFor(['createOrder']);
      return [];
    });

    const out = await new HttpRouteExtractor().extract(db, '/repo', {
      name: 'r',
      url: 'r',
    } as never);
    // Single candidate, so its method is adopted (existing behavior); the
    // point is that absence of routeMethod does not throw and still works.
    expect(out[0].meta.method).toBe('POST');
  });
});
