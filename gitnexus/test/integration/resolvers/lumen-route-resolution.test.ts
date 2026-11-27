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
    expect(routeUrls()).toEqual([
      '/admin/dash',
      '/home',
      '/orders/v1/list',
      '/solo',
      '/solo-case',
      '/users',
    ]);
  });

  it('binds a conditional require whose path is built by string concatenation', () => {
    expect(routeByUrl('/admin/dash')).toBeDefined();
  });

  it('a repeated require_once of the same routes file adds no second group', () => {
    expect(routeByUrl('/legacy/v1/list')).toBeUndefined();
  });

  it('CALLS and HANDLES_ROUTE reach the correct controller methods', () => {
    const homeRoute = routeByUrl('/home');
    const orderRoute = routeByUrl('/orders/v1/list');
    expect(homeRoute).toBeDefined();
    expect(orderRoute).toBeDefined();

    const homeCall = routeCalls().find(
      (e) =>
        e.target === 'show' &&
        e.targetFilePath.endsWith('app/Http/Controllers/HomeController.php') &&
        e.sourceFilePath.replace(/\\/g, '/').endsWith('routes/web.php'),
    );
    expect(homeCall).toBeDefined();

    const orderCall = routeCalls().find(
      (e) =>
        e.target === 'index' &&
        e.targetFilePath.endsWith('app/Http/Controllers/OrderController.php'),
    );
    expect(orderCall).toBeDefined();

    const handlerIdsFor = (routeId: string | undefined) =>
      handlesRoute()
        .filter((e) => e.rel.targetId === routeId && e.sourceLabel === 'Method')
        .map((e) => e.rel.sourceId);
    expect(handlerIdsFor(homeRoute?.id)).toEqual([homeCall?.rel.targetId]);
    expect(handlerIdsFor(orderRoute?.id)).toEqual([orderCall?.rel.targetId]);
  });

  it('a handler spelled in another case resolves to the controller method', () => {
    const solo = routeByUrl('/solo');
    const soloCase = routeByUrl('/solo-case');
    const handlerIdsFor = (routeId: string | undefined) =>
      handlesRoute()
        .filter((e) => e.rel.targetId === routeId && e.sourceLabel === 'Method')
        .map((e) => e.rel.sourceId);
    const showIds = handlerIdsFor(solo?.id);
    expect(showIds).toHaveLength(1);
    expect(handlerIdsFor(soloCase?.id)).toEqual(showIds);
  });

  it('unbound standalone route keeps in-file path without bootstrap prefix', () => {
    expect(routeByUrl('/solo')).toBeDefined();
    expect(routeByUrl('/orders/solo')).toBeUndefined();
  });
});
