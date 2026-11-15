import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

const FIXTURE = path.resolve(__dirname, '..', '..', 'fixtures', 'lumen-route-app');

describe('Lumen route pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60000);

  const routeByUrl = (url: string) => {
    let found: { id: string; url: string; method?: string } | undefined;
    result.graph.forEachNode((n) => {
      if (n.label !== 'Route') return;
      const u = (n.properties.url ?? n.properties.name) as string | undefined;
      if (u === url)
        found = { id: n.id, url: u, method: n.properties.method as string | undefined };
    });
    return found;
  };

  const routeUrls = (): string[] => {
    const urls: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Route') {
        const url = (n.properties.url ?? n.properties.name) as string | undefined;
        if (url) urls.push(url);
      }
    });
    return urls.sort();
  };

  const routeCalls = () =>
    getRelationships(result, 'CALLS').filter((e) => e.rel.reason === 'laravel-route');

  const handlesRoute = () => getRelationships(result, 'HANDLES_ROUTE');

  it('emits exact Route URLs for bound and unbound route files', () => {
    expect(routeUrls()).toEqual(['/home', '/orders/v1/list', '/solo', '/users']);
    expect(routeUrls()).not.toContain('/prefixed-by-non-route-require');
  });

  it('CALLS and HANDLES_ROUTE reach the correct controller methods', () => {
    const homeRoute = routeByUrl('/home');
    const orderRoute = routeByUrl('/orders/v1/list');
    expect(homeRoute).toBeDefined();
    expect(orderRoute).toBeDefined();

    const homeCall = routeCalls().find(
      (e) =>
        e.target === 'show' && e.targetFilePath.endsWith('app/Http/Controllers/HomeController.php'),
    );
    expect(homeCall).toBeDefined();

    const orderCall = routeCalls().find(
      (e) =>
        e.target === 'index' &&
        e.targetFilePath.endsWith('app/Http/Controllers/OrderController.php'),
    );
    expect(orderCall).toBeDefined();

    expect(
      handlesRoute().some((e) => e.rel.targetId === homeRoute?.id && e.sourceLabel === 'Method'),
    ).toBe(true);
    expect(
      handlesRoute().some((e) => e.rel.targetId === orderRoute?.id && e.sourceLabel === 'Method'),
    ).toBe(true);
  });

  it('unbound standalone route keeps in-file path without bootstrap prefix', () => {
    expect(routeByUrl('/solo')).toBeDefined();
    expect(routeByUrl('/orders/solo')).toBeUndefined();
  });
});
