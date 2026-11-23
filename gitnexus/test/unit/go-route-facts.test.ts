/**
 * `resolveGoRouteFacts`: wrapper-package route candidates become gin/echo
 * routes only when their root type is declared in `goRouterAliases`.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import {
  collectGoRouteFacts,
  extractGoRouteCandidates,
} from '../../src/core/ingestion/route-extractors/go-gin-echo.js';
import { resolveGoRouteFacts } from '../../src/core/ingestion/languages/go/route-facts.js';
import type { RouteFrameworkAlias } from '../../src/core/ingestion/language-provider.js';
import { routeHookConfigKey } from '../../src/core/ingestion/route-hook-config.js';
import { normalizeRouterAliases } from '../../src/core/ingestion/languages/go/route-config.js';

const parser = new Parser();
parser.setLanguage(Go);

const CORE_PATH = 'example.com/infra/pkg';
const SOURCE = `package routes
import (
  core "${CORE_PATH}"
  mw "example.com/app/middleware"
)
func R(s *core.Engine) {
  g := s.Group("/api")
  g.GET("/users", mw.Auth(), First, Last)
}
`;

const resolve = (aliases: RouteFrameworkAlias[]) =>
  resolveGoRouteFacts(
    [{ filePath: 'routes/r.go', facts: extractGoRouteCandidates(parser.parse(SOURCE)) }],
    { resolveImportTargets: () => [], routeHookConfig: { routeFrameworkAliases: aliases } },
  );

describe('resolveGoRouteFacts', () => {
  it('matches a configured Unicode type name against parsed route facts', () => {
    const facts = collectGoRouteFacts(
      parser.parse(`package routes
import core "${CORE_PATH}"
func R(s *core.ΔEngine) {
  s.GET("/unicode", Handler)
}`),
    );
    const routes = resolveGoRouteFacts([{ filePath: 'r.go', facts }], {
      resolveImportTargets: () => [],
      routeHookConfig: {
        routeFrameworkAliases: normalizeRouterAliases(
          [{ importPath: CORE_PATH, type: 'ΔEngine', framework: 'gin' }],
          'goRouterAliases',
        ),
      },
    });
    expect(routes.map((route) => [route.routePath, route.handlerName])).toEqual([
      ['/unicode', 'Handler'],
    ]);
  });

  it('replays serialized direct and alias facts with changed or removed configuration', () => {
    const facts = JSON.parse(
      JSON.stringify(
        collectGoRouteFacts(
          parser.parse(`package routes
import "github.com/gin-gonic/gin"
import core "${CORE_PATH}"
func R(r *gin.Engine, s *core.Engine) {
  s.Group("/alias").GET("/x", First, Last)
  r.Group("/direct").GET("/x", Middleware, Direct)
}`),
          10,
        ),
      ),
    );
    const before = JSON.stringify(facts);
    const replay = (framework?: string) =>
      resolveGoRouteFacts([{ filePath: 'r.go', facts }], {
        resolveImportTargets: () => [],
        routeHookConfig: framework
          ? { routeFrameworkAliases: [{ importPath: CORE_PATH, type: 'Engine', framework }] }
          : undefined,
      }).map((r) => [r.routePath, r.handlerName, r.source, r.lineNumber]);
    expect(replay('gin')).toEqual([
      ['/alias/x', 'Last', 'gin-route', 15],
      ['/direct/x', 'Direct', 'gin-route', 16],
    ]);
    expect(replay('echo')).toEqual([
      ['/alias/x', 'First', 'echo-route', 15],
      ['/direct/x', 'Direct', 'gin-route', 16],
    ]);
    expect(replay()).toEqual([['/direct/x', 'Direct', 'gin-route', 16]]);
    expect(JSON.stringify(facts)).toBe(before);
  });

  it('declines assignments between different root types even when their prefixes agree', () => {
    const facts = collectGoRouteFacts(
      parser.parse(`package routes
import core "${CORE_PATH}"
func R(a *core.First, b *core.Second) {
  g := a.Group("/api")
  g = b.Group("/api")
  g.GET("/ambiguous", H)
  a.GET("/first", H)
  b.GET("/second", H)
}`),
    );
    const routes = resolveGoRouteFacts([{ filePath: 'r.go', facts }], {
      resolveImportTargets: () => [],
      routeHookConfig: {
        routeFrameworkAliases: ['First', 'Second'].map((type) => ({
          importPath: CORE_PATH,
          type,
          framework: 'gin',
        })),
      },
    });
    expect(routes.map((r) => r.routePath)).toEqual(['/first', '/second']);
  });

  it('preserves alias parameter order when registrations use the reverse order', () => {
    const facts = collectGoRouteFacts(
      parser.parse(`package routes
import core "${CORE_PATH}"
func R(a *core.First, b *core.Second) {
  b.GET("/same", Second)
  a.GET("/same", First)
}`),
    );
    expect(facts?.roots.map((root) => root.typeName)).toEqual(['First', 'Second']);
  });

  it('promotes candidates on a gin alias, taking the last argument as handler', () => {
    expect(resolve([{ importPath: CORE_PATH, type: 'Engine', framework: 'gin' }])).toEqual([
      {
        filePath: 'routes/r.go',
        routePath: '/api/users',
        httpMethod: 'GET',
        decoratorName: 'GET',
        lineNumber: 8,
        prefix: null,
        source: 'gin-route',
        handlerName: 'Last',
      },
    ]);
  });

  it('takes the second argument on an echo alias', () => {
    // echo's second argument here is the `mw.Auth()` call: not a designator,
    // and not a wrapper of one, so the route stands without a handler.
    const [route] = resolve([{ importPath: CORE_PATH, type: 'Engine', framework: 'echo' }]);
    expect(route.source).toBe('echo-route');
    expect(route.handlerName).toBeUndefined();
    expect(route.handlerWrapper).toBeUndefined();
  });

  it('drops every candidate whose root type is not declared', () => {
    expect(resolve([])).toEqual([]);
    expect(resolve([{ importPath: CORE_PATH, type: 'Router', framework: 'gin' }])).toEqual([]);
  });

  it('ignores facts it did not produce', () => {
    expect(
      resolveGoRouteFacts([{ filePath: 'x.go', facts: { other: true } }], {
        resolveImportTargets: () => [],
      }),
    ).toEqual([]);
  });
});

describe('routeHookConfigKey', () => {
  it('is independent of declaration order and uses code-unit order', () => {
    const a = { importPath: 'example.com/a', type: 'Engine', framework: 'gin' };
    const b = { importPath: 'example.com/B', type: 'Engine', framework: 'echo' };
    expect(
      routeHookConfigKey({
        routeFrameworkAliases: [a, b],
        routeHandlerWrappers: ['z.Wrap', 'Z.Wrap'],
      }),
    ).toBe(
      routeHookConfigKey({
        routeFrameworkAliases: [b, a],
        routeHandlerWrappers: ['Z.Wrap', 'z.Wrap'],
      }),
    );
    // Uppercase sorts before lowercase by code unit, regardless of host locale.
    expect(
      routeHookConfigKey({
        routeFrameworkAliases: [a, b],
        routeHandlerWrappers: ['z.Wrap', 'Z.Wrap'],
      }),
    ).toBe(
      JSON.stringify([
        [
          ['example.com/B', 'Engine', 'echo'],
          ['example.com/a', 'Engine', 'gin'],
        ],
        ['Z.Wrap', 'z.Wrap'],
      ]),
    );
  });
});
