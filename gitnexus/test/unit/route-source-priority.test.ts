import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSemanticModel } from '../../src/core/ingestion/model/index.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { resolveRouteHandlerSymbols } from '../../src/core/ingestion/call-processor.js';
import { routesPhase } from '../../src/core/ingestion/pipeline-phases/routes.js';
import type { ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';
import type { ExtractedRoute } from '../../src/core/ingestion/route-extractors/laravel.js';
import type { ExtractedDecoratorRoute } from '../../src/core/ingestion/workers/parse-worker.js';
import { DATA_ROUTE_TABLE_SOURCE } from '../../src/core/ingestion/route-extractors/data-route-table.js';
import { DISPATCH_GUARD_SOURCE } from '../../src/core/ingestion/route-extractors/dispatch-guard.js';
import {
  isTestRouteFile,
  routeNodeKey,
} from '../../src/core/ingestion/route-extractors/route-path.js';
import { generateId } from '../../src/lib/utils.js';

type Route = ExtractedRoute | ExtractedDecoratorRoute;
const PROD = 'src/server.ts';
const TEST = 'test/stubs.ts';
const KEY = routeNodeKey('GET', '/api/orders');
const handlerId = (filePath: string, name: string) => `Function:${filePath}:${name}`;

function extracted(filePath: string, handler = 'handle'): ExtractedRoute {
  return {
    filePath,
    httpMethod: 'GET',
    routePath: '/api/orders',
    routeName: null,
    controllerName: null,
    methodName: handler,
    middleware: [],
    prefix: null,
    lineNumber: 1,
  };
}

function decorator(filePath: string, handler = 'handle'): ExtractedDecoratorRoute {
  return {
    filePath,
    httpMethod: 'GET',
    routePath: '/api/orders',
    decoratorName: 'express.get',
    handlerName: handler,
    lineNumber: 1,
  };
}

function table(filePath: string, handler = 'handle'): ExtractedDecoratorRoute {
  return { ...decorator(filePath, handler), source: DATA_ROUTE_TABLE_SOURCE };
}

async function resolveAndEmit(
  extractedRoutes: ExtractedRoute[],
  decoratorRoutes: ExtractedDecoratorRoute[],
  definitions: Array<[filePath: string, name: string]>,
  additionalFiles: Record<string, string> = {},
) {
  const model = createSemanticModel();
  const graph = createKnowledgeGraph();
  for (const [filePath, name] of definitions) {
    const id = handlerId(filePath, name);
    model.symbols.add(filePath, name, id, 'Function');
    graph.addNode({
      id,
      label: 'Function',
      properties: { name, filePath, startLine: 0, endLine: 0 },
    });
  }
  const selected = new Set<Route>();
  const symbols = resolveRouteHandlerSymbols(
    model,
    extractedRoutes,
    decoratorRoutes,
    undefined,
    selected,
  );
  const allPaths = [
    ...new Set([
      ...[...extractedRoutes, ...decoratorRoutes].map((r) => r.filePath),
      ...Object.keys(additionalFiles),
    ]),
  ];
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-route-priority-'));
  try {
    for (const filePath of allPaths) {
      await fs.mkdir(path.dirname(path.join(repoPath, filePath)), { recursive: true });
      await fs.writeFile(
        path.join(repoPath, filePath),
        additionalFiles[filePath] ?? 'export function handle() {}\n',
      );
    }
    // Pass the raw declarations with the admitted references, as the parse
    // phase does: losing declarations may still carry named route aliases.
    const output = {
      allPaths,
      allFetchCalls: [],
      allFetchWrapperDefs: [],
      allExtractedRoutes: extractedRoutes,
      allDecoratorRoutes: decoratorRoutes,
      selectedRoutes: selected,
      routeHandlerSymbols: symbols,
    } as unknown as ParseOutput;
    await routesPhase.execute(
      { repoPath, graph, onProgress: () => {}, pipelineStart: Date.now() },
      new Map([['parse', { phaseName: 'parse', output, durationMs: 0 }]]),
    );
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
  return {
    graph,
    symbols,
    selected,
    route: (key = KEY) => graph.getNode(generateId('Route', key)),
    sources: (key = KEY) =>
      graph.relationships
        .filter((r) => r.type === 'HANDLES_ROUTE' && r.targetId === generateId('Route', key))
        .map((r) => r.sourceId)
        .sort(),
  };
}

describe('route declaration priority through resolver and routes phase', () => {
  it('keeps named aliases from losing declarations for both Blade consumers', async () => {
    const first = { ...extracted(PROD, 'first'), routeName: 'orders.primary' };
    const alias = { ...extracted(PROD, 'second'), routeName: 'orders.alias' };
    const primaryView = 'resources/views/orders/primary.blade.php';
    const aliasView = 'resources/views/orders/alias.blade.php';
    const result = await resolveAndEmit(
      [first, alias],
      [],
      [
        [PROD, 'first'],
        [PROD, 'second'],
      ],
      {
        [primaryView]: `<a href="{{ route('orders.primary') }}">Orders</a>`,
        [aliasView]: `<a href="{{ route('orders.alias') }}">Orders alias</a>`,
      },
    );
    expect([...result.selected]).toEqual([first]);
    expect(result.selected.has(alias)).toBe(false);
    expect(result.route()?.properties.handlerSymbolId).toBe(handlerId(PROD, 'first'));
    const fetches = result.graph.relationships.filter((r) => r.type === 'FETCHES');
    expect(fetches).toHaveLength(2);
    expect(fetches.map((r) => r.sourceId).sort()).toEqual(
      [generateId('File', primaryView), generateId('File', aliasView)].sort(),
    );
    expect(fetches.map((r) => r.targetId)).toEqual([
      generateId('Route', KEY),
      generateId('Route', KEY),
    ]);
  });

  it.each(['test-extracted', 'test-decorator'] as const)(
    'production wins across route collections with %s',
    async (kind) => {
      const prod = kind === 'test-extracted' ? decorator(PROD) : extracted(PROD);
      const stub = kind === 'test-extracted' ? extracted(TEST) : decorator(TEST);
      const result = await resolveAndEmit(
        [kind === 'test-extracted' ? (stub as ExtractedRoute) : (prod as ExtractedRoute)],
        [
          kind === 'test-extracted'
            ? (prod as ExtractedDecoratorRoute)
            : (stub as ExtractedDecoratorRoute),
        ],
        [
          [PROD, 'handle'],
          [TEST, 'handle'],
        ],
      );
      expect([...result.selected]).toEqual([prod]);
      expect(result.selected.has(prod)).toBe(true);
      expect(result.selected.has(stub)).toBe(false);
      expect(result.route()?.properties.filePath).toBe(PROD);
      expect(result.route()?.properties.handlerSymbolId).toBe(handlerId(PROD, 'handle'));
      expect(result.sources()).toEqual(
        [generateId('File', PROD), handlerId(PROD, 'handle')].sort(),
      );
    },
  );

  it('compares normalized prefixes and methods, retaining a different verb', async () => {
    const stub = {
      ...extracted(TEST),
      httpMethod: ' get ',
      routePath: '/orders/',
      prefix: '/api/',
    };
    const prod = { ...decorator(PROD), routePath: '/api//orders/' };
    const post = { ...decorator(TEST, 'post'), httpMethod: 'POST' };
    const result = await resolveAndEmit(
      [stub],
      [prod, post],
      [
        [TEST, 'handle'],
        [TEST, 'post'],
        [PROD, 'handle'],
      ],
    );
    expect([...result.selected]).toEqual([prod, post]);
    expect(result.route()?.properties.filePath).toBe(PROD);
    expect(result.symbols.get(KEY)).toBe(handlerId(PROD, 'handle'));
    expect(result.route(routeNodeKey('POST', '/api/orders'))?.properties.handlerSymbolId).toBe(
      handlerId(TEST, 'post'),
    );
  });

  it.each(['test-first', 'production-first'] as const)(
    'an unresolved production handler cannot borrow a test handler (%s)',
    async (order) => {
      const prod = decorator(PROD, 'missing');
      const stub = decorator(TEST);
      const routes = order === 'test-first' ? [stub, prod] : [prod, stub];
      const result = await resolveAndEmit([], routes, [[TEST, 'handle']]);
      expect([...result.selected]).toEqual([prod]);
      expect(result.symbols.has(KEY)).toBe(false);
      expect(result.route()?.properties.filePath).toBe(PROD);
      expect(result.route()?.properties).not.toHaveProperty('handlerSymbolId');
      expect(result.sources()).toEqual([generateId('File', PROD)]);
    },
  );

  it.each([PROD, TEST])(
    'keeps same-tier first writer and test-only declarations (%s)',
    async (file) => {
      const first = decorator(file, 'first');
      const second = decorator(file, 'second');
      const result = await resolveAndEmit(
        [],
        [first, second],
        [
          [file, 'first'],
          [file, 'second'],
        ],
      );
      expect([...result.selected]).toEqual([first]);
      expect(result.route()?.properties.filePath).toBe(file);
      expect(result.route()?.properties.handlerSymbolId).toBe(handlerId(file, 'first'));
    },
  );

  it.each(['conflicting', 'unresolved'] as const)(
    'test data tables cannot invalidate a production table (%s)',
    async (kind) => {
      const prod = table(PROD);
      const stub = table(TEST, kind === 'conflicting' ? 'fake' : 'missing');
      const result = await resolveAndEmit(
        [],
        [stub, prod],
        [
          [PROD, 'handle'],
          [TEST, 'fake'],
        ],
      );
      expect([...result.selected]).toEqual([prod]);
      expect(result.route()?.properties.filePath).toBe(PROD);
      expect(result.route()?.properties.handlerSymbolId).toBe(handlerId(PROD, 'handle'));
    },
  );

  it.each(['conflicting', 'unresolved'] as const)(
    'suppresses ambiguous same-tier tables (%s)',
    async (kind) => {
      const first = table(PROD);
      const second = table(PROD, kind === 'conflicting' ? 'other' : 'missing');
      const result = await resolveAndEmit(
        [],
        [first, second],
        [
          [PROD, 'handle'],
          [PROD, 'other'],
        ],
      );
      expect(result.selected.size).toBe(0);
      expect(result.symbols.size).toBe(0);
      expect(result.route()).toBeUndefined();
    },
  );

  it('falls back from an unproven production table to the actual test declaration', async () => {
    const prod = table(PROD, 'missing');
    const stub = decorator(TEST);
    const result = await resolveAndEmit([], [prod, stub], [[TEST, 'handle']]);
    expect([...result.selected]).toEqual([stub]);
    expect(result.route()?.properties.filePath).toBe(TEST);
    expect(result.route()?.properties.handlerSymbolId).toBe(handlerId(TEST, 'handle'));
    expect(result.sources()).toEqual([generateId('File', TEST), handlerId(TEST, 'handle')].sort());
  });

  it('a discarded methodless dispatch guard cannot donate the app.all handler', async () => {
    const methodless = {
      ...decorator(PROD, 'stale'),
      httpMethod: '',
      source: DISPATCH_GUARD_SOURCE,
    };
    const verbed = { ...decorator(PROD, 'get'), source: DISPATCH_GUARD_SOURCE };
    const wildcard = { ...decorator(PROD, 'all'), httpMethod: '*', decoratorName: 'express.all' };
    const result = await resolveAndEmit(
      [],
      [methodless, verbed, wildcard],
      [
        [PROD, 'stale'],
        [PROD, 'get'],
        [PROD, 'all'],
      ],
    );
    expect(result.selected.has(methodless)).toBe(false);
    expect(result.selected.has(wildcard)).toBe(true);
    expect(result.route('/api/orders')?.properties.method).toBe('*');
    expect(result.route('/api/orders')?.properties.handlerSymbolId).toBe(handlerId(PROD, 'all'));
    expect(result.sources('/api/orders')).toEqual(
      [generateId('File', PROD), handlerId(PROD, 'all')].sort(),
    );
    expect(result.route()?.properties.handlerSymbolId).toBe(handlerId(PROD, 'get'));
  });
});

describe('route priority shares test-file classification', () => {
  it.each([
    'spec/routes.ts',
    'testing/routes.ts',
    '__mocks__/routes.ts',
    '__tests__/routes.ts',
    'routes.spec.ts',
    'routes.test.js',
    'routes_test.go',
    'routes_test.py',
    'routes_test.dart',
    'routes_spec.rb',
    'RoutesTest.php',
    'RoutesTests.cs',
    'RoutesTests.swift',
    'e2e/routes.ts',
    'E2E/routes.ts',
    'src\\testing\\routes.ts',
    'src\\e2e\\routes.ts',
  ])('recognizes test registrations at %s', (file) => {
    expect(isTestRouteFile(file)).toBe(true);
  });

  it.each([
    'src/routes.ts',
    'src/contest.ts',
    'src/Contest.swift',
    'src/Latest.php',
    'src/e2e-utils/routes.ts',
  ])('keeps production registrations at %s', (file) => {
    expect(isTestRouteFile(file)).toBe(false);
  });
});
