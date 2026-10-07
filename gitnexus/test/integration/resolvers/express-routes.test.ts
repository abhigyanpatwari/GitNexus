import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
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
      expect(sources).not.toContain('test/stubs.ts');
    }
  });

  it('models app.all as method-agnostic, not GET', () => {
    const mcpRoutes = getNodesByLabelFull(result, 'Route').filter(
      (node) => node.name === '/api/mcp',
    );
    expect(mcpRoutes).toHaveLength(1);
    expect(mcpRoutes[0].properties.method).toBe('*');
  });

  it('does not classify a one-argument Map.get lookup as a route', () => {
    expect(getNodesByLabel(result, 'Route')).not.toContain('/ghost');
  });

  it('still indexes a test-only route when there is no production collision', () => {
    expect(getNodesByLabel(result, 'Route')).toContain('/test-only');
  });
});
