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

describe('Next.js route mapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'nextjs-route-mapping'), () => {});
  }, 60000);

  it('creates Route nodes for API endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/grants');
    expect(routes).toContain('/api/organizations/[slug]/grants');
  });

  it('creates HANDLES_ROUTE edge from route file to Route node', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    expect(edges.length).toBeGreaterThanOrEqual(2);
    const grantsRoute = edges.find((e) => e.target === '/api/grants');
    expect(grantsRoute).toBeDefined();
    expect(grantsRoute!.sourceFilePath).toContain('app/api/grants/route.ts');
  });

  it('creates FETCHES edge from consumer to Route node', () => {
    const edges = getRelationships(result, 'FETCHES');
    const fetchEdge = edges.find(
      (e) => e.sourceFilePath.includes('useGrants') && e.target === '/api/grants',
    );
    expect(fetchEdge).toBeDefined();
  });

  it('creates Route nodes for PHP API endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/upload');
    expect(routes).toContain('/api/status');
  });

  it('matches dynamic route segments', () => {
    const edges = getRelationships(result, 'FETCHES');
    const dynamicFetch = edges.find((e) => e.sourceFilePath.includes('GrantsList'));
    expect(dynamicFetch).toBeDefined();
    expect(dynamicFetch!.target).toBe('/api/organizations/[slug]/grants');
  });

  it('links project-level middleware.ts to matching API routes', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const grants = routes.find((r) => r.name === '/api/grants');
    expect(grants).toBeDefined();
    expect(grants!.properties.middleware).toBeDefined();
    expect(grants!.properties.middleware).toContain('middleware');
  });

  it('links middleware to all routes matching the matcher pattern', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const apiRoutes = routes.filter((r) => (r.name as string).startsWith('/api/'));
    expect(apiRoutes.length).toBeGreaterThanOrEqual(2);
    for (const route of apiRoutes) {
      expect(route.properties.middleware).toBeDefined();
      expect((route.properties.middleware as string[]).length).toBeGreaterThan(0);
    }
  });

  it('does not link middleware to routes outside the matcher pattern', () => {
    const routes = getNodesByLabelFull(result, 'Route');
    const nonApiRoutes = routes.filter((r) => !(r.name as string).startsWith('/api'));
    for (const route of nonApiRoutes) {
      const mw = route.properties.middleware as string[] | undefined;
      if (mw) {
        expect(mw).not.toContain('middleware');
      }
    }
  });
});
