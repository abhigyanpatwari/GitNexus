import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
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

  it('detects multiple HTTP methods on same path as single route', () => {
    // /api/users has GET and POST but route registry deduplicates by path
    const routes = getNodesByLabel(result, 'Route');
    const usersRoutes = routes.filter((r) => r === '/api/users');
    expect(usersRoutes).toHaveLength(1);
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
