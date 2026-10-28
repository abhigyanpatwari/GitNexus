/**
 * `resolveGoRouteFacts`: wrapper-package route candidates become gin/echo
 * routes only when their root type is declared in `goRouterAliases`.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import { extractGoRouteCandidates } from '../../src/core/ingestion/route-extractors/go-gin-echo.js';
import { resolveGoRouteFacts } from '../../src/core/ingestion/languages/go/route-facts.js';
import type { RouteFrameworkAlias } from '../../src/core/ingestion/language-provider.js';
import { routeHookConfigKey } from '../../src/core/ingestion/route-hook-config.js';

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
    { resolveImportTargets: () => [], routeFrameworkAliases: aliases },
  );

describe('resolveGoRouteFacts', () => {
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
    expect(routeHookConfigKey([a, b], ['z.Wrap', 'Z.Wrap'])).toBe(
      routeHookConfigKey([b, a], ['Z.Wrap', 'z.Wrap']),
    );
    // Uppercase sorts before lowercase by code unit, regardless of host locale.
    expect(routeHookConfigKey([a, b], ['z.Wrap', 'Z.Wrap'])).toBe(
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
