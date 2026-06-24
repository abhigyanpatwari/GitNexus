import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  extractTemplateStaticFetchCalls,
  isTemplateRouteCandidate,
  normalizeExtractedRoutePath,
  routesPhase,
} from '../../src/core/ingestion/pipeline-phases/routes.js';
import type { ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';

describe('Blade/template static route extraction', () => {
  it('keeps Blade files as template route candidates', () => {
    expect(isTemplateRouteCandidate('resources/views/orders/index.blade.php')).toBe(true);
    expect(isTemplateRouteCandidate('resources\\views\\Orders\\INDEX.BLADE.PHP')).toBe(true);
  });

  it('extracts safe static form, href, AJAX, and Blade URL helper URLs', () => {
    const calls = extractTemplateStaticFetchCalls(
      'resources/views/orders/index.blade.php',
      `<form action="/orders" method="POST">
  <a href='/orders/history'>History</a>
  <script>
    $.ajax({ url: '/api/orders', method: 'POST' });
  </script>
  <a href="{{ url('/checkout') }}">Checkout</a>
  <a href="{!! url('/checkout/raw') !!}">Raw checkout</a>
</form>`,
    );

    expect(new Set(calls.map((call) => call.fetchURL))).toEqual(
      new Set(['/orders', '/orders/history', '/api/orders', '/checkout', '/checkout/raw']),
    );
    expect(new Set(calls.map((call) => call.filePath))).toEqual(
      new Set(['resources/views/orders/index.blade.php']),
    );
  });

  it('does not treat Laravel asset helper URLs as route signals', () => {
    const calls = extractTemplateStaticFetchCalls(
      'resources/views/layouts/app.blade.php',
      `<link href="{{ asset('/css/app.css') }}" rel="stylesheet">
<script src="{!! asset('/js/app.js') !!}"></script>`,
    );

    expect(calls).toEqual([]);
  });

  it('resolves parameterless Blade named route helpers from extracted route names', () => {
    const calls = extractTemplateStaticFetchCalls(
      'resources/views/auth/login.blade.php',
      `<a href="{{ route('login') }}">Login</a>
<form method="POST" action="{!! route('log-viewer.login.submit') !!}"></form>
<a href="{{ route('orders.show') }}">Missing parameter</a>
<a href="{{ route('orders.show', $order) }}">Dynamic order</a>`,
      new Map([
        ['login', '/login'],
        ['log-viewer.login.submit', '/logs/login'],
        ['orders.show', '/orders/{order}'],
      ]),
    );

    expect(calls.map((call) => call.fetchURL)).toEqual(['/login', '/logs/login']);
  });

  it('does not turn dynamic Blade expressions or parameterized named routes into static URL signals', () => {
    const calls = extractTemplateStaticFetchCalls(
      'resources/views/orders/show.blade.php',
      `<a href="{{ $url }}">Dynamic</a>
<a href="{{ route('orders.show', $order) }}">Named route follow-up</a>
<a href="{{ url($dynamic) }}">Dynamic helper</a>
<script>
  $.ajax({ url: '/orders/' + id, method: 'GET' });
  axios({ url: \`/orders/\${id}\`, method: 'GET' });
</script>`,
    );

    expect(calls).toEqual([]);
  });

  it('normalizes Laravel route prefixes before matching template URL signals', () => {
    expect(normalizeExtractedRoutePath('/orders', 'admin')).toBe('/admin/orders');
    expect(normalizeExtractedRoutePath('orders', '/admin/')).toBe('/admin/orders');
    expect(normalizeExtractedRoutePath('/', 'admin')).toBe('/admin');
    expect(normalizeExtractedRoutePath('/orders', null)).toBe('/orders');
  });

  it('links Blade static URL signals to matching route graph nodes without PHP parsing', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-blade-routes-'));
    try {
      await fs.mkdir(path.join(repoPath, 'routes'), { recursive: true });
      await fs.mkdir(path.join(repoPath, 'resources/views/orders'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'routes/web.php'), `<?php\nRoute::post('/orders');\n`);
      await fs.writeFile(
        path.join(repoPath, 'resources/views/orders/index.blade.php'),
        `<form action="/admin/orders" method="POST">
  <a href="{{ route('admin.orders') }}">Orders</a>
  <link href="{{ asset('/css/app.css') }}" rel="stylesheet">
</form>`,
      );

      const graph = createKnowledgeGraph();
      const parseOutput = {
        allPaths: ['routes/web.php', 'resources/views/orders/index.blade.php'],
        allFetchCalls: [],
        allExtractedRoutes: [
          {
            filePath: 'routes/web.php',
            httpMethod: 'post',
            routePath: '/orders',
            routeName: 'admin.orders',
            controllerName: null,
            methodName: null,
            middleware: [],
            prefix: 'admin',
            lineNumber: 1,
          },
          {
            filePath: 'routes/web.php',
            httpMethod: 'get',
            routePath: '/css/app.css',
            routeName: 'assets.css',
            controllerName: null,
            methodName: null,
            middleware: [],
            prefix: null,
            lineNumber: 2,
          },
        ],
        allDecoratorRoutes: [],
        routeHandlerSymbols: new Map(),
      } as unknown as ParseOutput;

      const output = await routesPhase.execute(
        {
          repoPath,
          graph,
          onProgress: () => {},
          pipelineStart: Date.now(),
        },
        new Map([['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }]]),
      );

      expect(output.routeRegistry.get('/admin/orders')).toEqual({
        filePath: 'routes/web.php',
        source: 'framework-route',
        method: 'POST',
      });

      const fetchEdges = graph.relationships.filter((rel) => rel.type === 'FETCHES');
      expect(fetchEdges).toHaveLength(1);
      expect(fetchEdges.map((rel) => graph.getNode(rel.targetId)?.properties.name)).toEqual([
        '/admin/orders',
      ]);
      const target = graph.getNode(fetchEdges[0]!.targetId);
      expect(fetchEdges[0]!.sourceId).toBe(
        generateId('File', 'resources/views/orders/index.blade.php'),
      );
      expect(target?.properties.name).toBe('/admin/orders');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});
