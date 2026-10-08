import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import {
  loadParseCache,
  PARSE_CACHE_VERSION,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Express/Hono route detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'express-route-mapping'), () => {});
  }, 60000);

  it('creates Route nodes for Express endpoints in TypeScript', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/users');
    expect(routes).toContain('/api/users/:id');
    expect(routes).toContain('/api/health');
  });

  it('creates Route nodes for Express endpoints in JavaScript', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/items');
  });

  it('creates HANDLES_ROUTE edges from handler files to Route nodes', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    expect(edges.length).toBeGreaterThanOrEqual(4);

    const usersRoute = edges.find((e) => e.target === '/api/users');
    expect(usersRoute).toBeDefined();
    expect(usersRoute!.sourceFilePath).toContain('server.ts');

    const itemsRoute = edges.find((e) => e.target === '/api/items');
    expect(itemsRoute).toBeDefined();
    expect(itemsRoute!.sourceFilePath).toContain('app.js');
  });

  it('splits same-path GET/POST into one Route node per verb (#2289)', () => {
    // /api/users carries both GET and POST. Route identity is now `(method, url)`,
    // so the pair becomes TWO Route nodes — each keeps `/api/users` as its display
    // name and is distinguished by its `method` property. (Pre-#2289 the registry
    // deduplicated by URL and collapsed them into a single node.)
    const usersNodes = getNodesByLabelFull(result, 'Route').filter((n) => n.name === '/api/users');
    expect(usersNodes).toHaveLength(2);
    const methods = usersNodes.map((n) => n.properties.method).sort();
    expect(methods).toEqual(['GET', 'POST']);
  });

  it('detects router.get() routes (not just app.get())', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/health');

    const edges = getRelationships(result, 'HANDLES_ROUTE');
    const healthEdge = edges.find((e) => e.target === '/api/health');
    expect(healthEdge).toBeDefined();
    expect(healthEdge!.sourceFilePath).toContain('server.ts');
  });
});

describe('Express route identity and source priority', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'express-route-priority'), () => {});
  }, 60000);

  it('keeps production handlers when test stubs register the same route', () => {
    const handled = getRelationships(result, 'HANDLES_ROUTE');
    for (const route of ['/api/info', '/api/query']) {
      const sources = handled
        .filter((edge) => edge.target === route)
        .map((edge) => edge.sourceFilePath);
      expect(sources).toContain('src/server.ts');
      expect(sources).not.toContain('spec/stubs.ts');
    }
  });

  it('models app.all as method-agnostic, not GET', () => {
    const mcpRoutes = getNodesByLabelFull(result, 'Route').filter(
      (node) => node.name === '/api/mcp',
    );
    expect(mcpRoutes).toHaveLength(1);
    expect(mcpRoutes[0].properties.method).toBe('*');
  });

  it.each(['/ghost', '/ghost-block-comment', '/ghost-line-comment'])(
    'does not classify the one-argument Map.get lookup %s as a route',
    (route) => {
      expect(getNodesByLabel(result, 'Route')).not.toContain(route);
    },
  );

  it.each([
    ['/api/chained', ['GET']],
    ['/api/chained-post', ['POST']],
    ['/api/chained-multi', ['GET', 'POST']],
    ['/api/chained-all', ['*']],
  ])('uses the registered verbs for route builder %s', (route, methods) => {
    const chainedRoutes = getNodesByLabelFull(result, 'Route').filter(
      (node) => node.name === route,
    );
    expect(chainedRoutes.map((node) => node.properties.method).sort()).toEqual(methods);
    const handled = getRelationships(result, 'HANDLES_ROUTE').filter(
      (edge) => edge.target === route,
    );
    expect(handled).toHaveLength(methods.length);
    expect(handled.every((edge) => edge.sourceFilePath === 'src/server.ts')).toBe(true);
  });

  it.each([
    '/ghost-builder',
    '/ghost-builder-empty',
    '/ghost-builder-block-comment',
    '/ghost-builder-line-comment',
  ])('does not invent a route for builder %s without a handler', (route) => {
    expect(getNodesByLabel(result, 'Route')).not.toContain(route);
    expect(getRelationships(result, 'HANDLES_ROUTE').some((edge) => edge.target === route)).toBe(
      false,
    );
  });

  it('still indexes a test-only route when there is no production collision', () => {
    expect(getNodesByLabel(result, 'Route')).toContain('/test-only');
  });

  it('preserves route ownership through serialized warm and mixed parse-cache replay', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-express-route-cache-'));
    const repoDir = path.join(tempDir, 'repo');
    const storageDir = path.join(tempDir, 'storage');
    try {
      fs.cpSync(path.join(FIXTURES, 'express-route-priority'), repoDir, { recursive: true });
      const cold: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set<string>(),
        storagePath: storageDir,
        onDiskKeys: new Set<string>(),
      };
      const coldResult = await runPipelineFromRepo(repoDir, () => {}, {
        parseCache: cold,
        workerPoolSize: 1,
      });
      expect(coldResult.usedWorkerPool).toBe(true);
      expect(coldResult.reparsedFileCount).toBe(2);
      expect(coldResult.parseCacheHitFileCount).toBe(0);

      pruneCache(cold, cold.usedKeys);
      const savedKeys = await saveParseCache(storageDir, cold);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storageDir),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );
      const warm = await loadParseCache(storageDir);
      expect(warm).not.toBeNull();
      const warmResult = await runPipelineFromRepo(repoDir, () => {}, {
        parseCache: warm ?? undefined,
        workerPoolSize: 1,
      });
      expect(warmResult.usedWorkerPool).toBe(false);
      expect(warmResult.reparsedFileCount).toBe(0);
      expect(warmResult.parseCacheHitFileCount).toBe(2);

      // Keep the earlier test-file chunk cached while the production route
      // definitions are parsed again. Comments do not change route semantics.
      fs.appendFileSync(path.join(repoDir, 'src/server.ts'), '\n// unchanged endpoints\n');
      const mixed = await loadParseCache(storageDir);
      expect(mixed).not.toBeNull();
      const mixedResult = await runPipelineFromRepo(repoDir, () => {}, {
        parseCache: mixed ?? undefined,
        workerPoolSize: 1,
      });
      expect(mixedResult.usedWorkerPool).toBe(true);
      expect(mixedResult.reparsedFileCount).toBe(1);
      expect(mixedResult.parseCacheHitFileCount).toBe(1);

      const project = (pipeline: PipelineResult) => ({
        routes: getNodesByLabelFull(pipeline, 'Route')
          .map((route) => ({
            method: route.properties.method,
            path: route.name,
            filePath: route.properties.filePath,
          }))
          .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
        handled: getRelationships(pipeline, 'HANDLES_ROUTE')
          .map((edge) => ({
            method: pipeline.graph.getNode(edge.rel.targetId)?.properties.method,
            path: edge.target,
            filePath: edge.sourceFilePath,
          }))
          .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
      });
      const expected = [
        { method: 'GET', path: '/api/chained', filePath: 'src/server.ts' },
        { method: '*', path: '/api/chained-all', filePath: 'src/server.ts' },
        { method: 'GET', path: '/api/chained-multi', filePath: 'src/server.ts' },
        { method: 'POST', path: '/api/chained-multi', filePath: 'src/server.ts' },
        { method: 'POST', path: '/api/chained-post', filePath: 'src/server.ts' },
        { method: 'GET', path: '/api/info', filePath: 'src/server.ts' },
        { method: '*', path: '/api/mcp', filePath: 'src/server.ts' },
        { method: 'POST', path: '/api/query', filePath: 'src/server.ts' },
        { method: 'POST', path: '/test-only', filePath: 'spec/stubs.ts' },
      ];
      const coldProjection = project(coldResult);
      expect(coldProjection).toEqual({ routes: expected, handled: expected });
      expect(project(warmResult)).toEqual(coldProjection);
      expect(project(mixedResult)).toEqual(coldProjection);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 120_000);
});
