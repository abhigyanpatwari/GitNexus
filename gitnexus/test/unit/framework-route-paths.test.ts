import { describe, expect, it } from 'vitest';
import { composeFrameworkRoutePaths } from '../../src/core/ingestion/route-extractors/framework-route-paths.js';
import type {
  FrameworkMount,
  ResolvedFrameworkRoutes,
} from '../../src/core/ingestion/route-extractors/framework-route-types.js';

function project(
  mounts: FrameworkMount[],
  ids = ['app', 'a', 'b', 'c', 'standalone'],
): ResolvedFrameworkRoutes {
  return {
    allocations: ids.map((id) => ({ id, kind: id === 'app' ? 'app' : 'router' })),
    mounts,
    registrations: ids
      .filter((id) => id !== 'app')
      .map((id) => ({
        receiverId: id,
        framework: 'express',
        route: {
          filePath: `${id}.ts`,
          routePath: '/item',
          httpMethod: 'GET',
          decoratorName: 'express.get',
          lineNumber: 7,
          handlerName: `${id}Handler`,
        },
      })),
  };
}
const paths = (resolved: ResolvedFrameworkRoutes, budget?: number) =>
  composeFrameworkRoutePaths(resolved, budget)
    .map((route) => `${route.filePath} ${route.routePath}`)
    .sort();
const mount = (parentId: string, childId: string, ...prefixes: string[]): FrameworkMount => ({
  parentId,
  childId,
  prefixes,
});

describe('framework mounted route paths', () => {
  it('composes root, nested, repeated and path-array mounts while preserving standalone routers', () => {
    const resolved = project([
      mount('app', 'a', '/v1', '/v2'),
      mount('a', 'b', '/admin'),
      mount('b', 'c', '/'),
    ]);
    expect(paths(resolved)).toEqual([
      'a.ts /v1/item',
      'a.ts /v2/item',
      'b.ts /v1/admin/item',
      'b.ts /v2/admin/item',
      'c.ts /v1/admin/item',
      'c.ts /v2/admin/item',
      'standalone.ts /item',
    ]);
    expect(
      composeFrameworkRoutePaths(resolved).find((route) => route.filePath === 'c.ts'),
    ).toMatchObject({
      lineNumber: 7,
      handlerName: 'cHandler',
      httpMethod: 'GET',
      decoratorName: 'express.get',
    });
  });

  it('does not invent local paths from dynamic mounts; independently known static paths survive', () => {
    const resolved = project([
      { parentId: 'app', childId: 'a', prefixes: null },
      mount('a', 'b', '/child'),
      mount('app', 'c', '/known'),
      { parentId: 'app', childId: 'c', prefixes: null },
    ]);
    expect(paths(resolved)).toEqual(['c.ts /known/item', 'standalone.ts /item']);
  });

  it('keeps all acyclic paths through a diamond and cycle, deduplicating identical outcomes', () => {
    const resolved = project(
      [
        mount('app', 'a', '/a'),
        mount('app', 'b', '/b'),
        mount('a', 'c', '/c'),
        mount('b', 'c', '/c'),
        mount('c', 'a', '/again'),
        mount('app', 'a', '/a'),
      ],
      ['app', 'a', 'b', 'c'],
    );
    expect(paths(resolved)).toEqual([
      'a.ts /a/item',
      'a.ts /b/c/again/item',
      'b.ts /b/item',
      'c.ts /a/c/item',
      'c.ts /b/c/item',
    ]);
  });

  it('declines rootless cycles while retaining an unrelated standalone router', () => {
    expect(
      paths(project([mount('a', 'b', '/b'), mount('b', 'a', '/a')], ['a', 'b', 'standalone'])),
    ).toEqual(['standalone.ts /item']);
  });

  it('fails an exhausted component atomically and independently of input ordering', () => {
    const resolved = project(
      [mount('app', 'a', '/a', '/b', '/c'), mount('a', 'b', '/nested')],
      ['app', 'a', 'b', 'standalone'],
    );
    expect(paths(resolved, 3)).toEqual(['standalone.ts /item']);
    expect(
      paths(
        {
          allocations: [...resolved.allocations].reverse(),
          mounts: [...resolved.mounts].reverse(),
          registrations: [...resolved.registrations].reverse(),
        },
        3,
      ),
    ).toEqual(paths(resolved, 3));
    expect(paths(resolved, 100)).toHaveLength(7);
  });

  it('preserves proven Hono routes without Express mounting semantics', () => {
    const resolved: ResolvedFrameworkRoutes = {
      allocations: [{ id: 'hono', kind: 'hono' }],
      mounts: [],
      registrations: [
        {
          receiverId: 'hono',
          framework: 'hono',
          route: {
            filePath: 'hono.ts',
            routePath: '/hello',
            httpMethod: 'GET',
            lineNumber: 2,
            decoratorName: 'hono.get',
          },
        },
      ],
    };
    expect(paths(resolved)).toEqual(['hono.ts /hello']);
  });
});
