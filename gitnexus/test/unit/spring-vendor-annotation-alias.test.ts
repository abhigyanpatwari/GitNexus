/**
 * Unit test: vendor-derived Spring mapping annotation alias resolution.
 *
 * Frameworks wrap Spring's built-in annotations with company-specific variants
 * (e.g. Winning Health's `@WinPostMapping`). The tree-sitter query captures
 * these annotations like any other, but `springAnnotationHttpMethods` must
 * resolve them to the correct HTTP verb via suffix matching.
 *
 * These tests cover:
 * 1. `resolveSpringAnnotationAlias` directly (unit)
 * 2. `springAnnotationHttpMethods` with aliased annotations (unit)
 * 3. End-to-end `extractSpringRoutes` with a fixture using vendor annotations
 * 4. Parity: both ingestion and group extractors surface the same routes
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  resolveSpringAnnotationAlias,
  springAnnotationHttpMethods,
} from '../../src/core/ingestion/route-extractors/spring-shared.js';
import { extractSpringRoutes } from '../../src/core/ingestion/route-extractors/spring.js';
import { JAVA_HTTP_PLUGIN } from '../../src/core/group/extractors/http-patterns/java.js';
import { normalizeExtractedRoutePath } from '../../src/core/ingestion/route-extractors/route-path.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(code);
}

describe('resolveSpringAnnotationAlias', () => {
  it('returns undefined for exact built-in shortcut annotations', () => {
    expect(resolveSpringAnnotationAlias('PostMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('GetMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('PutMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('DeleteMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('PatchMapping')).toBeUndefined();
  });

  it('returns undefined for exact RequestMapping', () => {
    expect(resolveSpringAnnotationAlias('RequestMapping')).toBeUndefined();
  });

  it('returns undefined for unrelated annotations', () => {
    expect(resolveSpringAnnotationAlias('Override')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('Autowired')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('Component')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('Data')).toBeUndefined();
  });

  it('resolves vendor shortcut annotations by suffix', () => {
    expect(resolveSpringAnnotationAlias('WinPostMapping')).toBe('PostMapping');
    expect(resolveSpringAnnotationAlias('WinGetMapping')).toBe('GetMapping');
    expect(resolveSpringAnnotationAlias('WinPutMapping')).toBe('PutMapping');
    expect(resolveSpringAnnotationAlias('WinDeleteMapping')).toBe('DeleteMapping');
    expect(resolveSpringAnnotationAlias('WinPatchMapping')).toBe('PatchMapping');
  });

  it('resolves vendor RequestMapping variants', () => {
    expect(resolveSpringAnnotationAlias('WinRequestMapping')).toBe('RequestMapping');
    expect(resolveSpringAnnotationAlias('CustomRequestMapping')).toBe('RequestMapping');
  });

  it('works with arbitrary vendor prefixes', () => {
    expect(resolveSpringAnnotationAlias('CompanyPostMapping')).toBe('PostMapping');
    expect(resolveSpringAnnotationAlias('XyzGetMapping')).toBe('GetMapping');
  });

  it('does not match annotations that merely contain a mapping name', () => {
    expect(resolveSpringAnnotationAlias('PostMappingHelper')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('GetMappingInfo')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('PreMapping')).toBeUndefined();
  });
});

describe('springAnnotationHttpMethods with vendor aliases', () => {
  it('resolves WinPostMapping to POST', () => {
    expect(springAnnotationHttpMethods('WinPostMapping', '@WinPostMapping("/api")')).toEqual([
      'POST',
    ]);
  });

  it('resolves WinGetMapping to GET', () => {
    expect(springAnnotationHttpMethods('WinGetMapping', '@WinGetMapping("/api")')).toEqual(['GET']);
  });

  it('resolves WinDeleteMapping to DELETE', () => {
    expect(springAnnotationHttpMethods('WinDeleteMapping', '@WinDeleteMapping("/api")')).toEqual([
      'DELETE',
    ]);
  });

  it('resolves WinRequestMapping without method attribute to wildcard', () => {
    expect(springAnnotationHttpMethods('WinRequestMapping', '@WinRequestMapping("/api")')).toEqual([
      '*',
    ]);
  });

  it('resolves WinRequestMapping with method attribute', () => {
    const text = '@WinRequestMapping(value = "/api", method = RequestMethod.POST)';
    expect(springAnnotationHttpMethods('WinRequestMapping', text)).toEqual(['POST']);
  });

  it('returns empty for unrelated annotations', () => {
    expect(springAnnotationHttpMethods('Component', '@Component')).toEqual([]);
    expect(springAnnotationHttpMethods('Override', '@Override')).toEqual([]);
  });
});

describe('extractSpringRoutes with vendor annotations', () => {
  it('extracts routes from a controller using @Win annotations', () => {
    const tree = parse(`
package com.winning.opt.controller;

@RestController
@RequestMapping("/api/opt")
public class OrderController {
    @WinPostMapping("/create")
    public String create() { return "{}"; }

    @WinGetMapping("/query")
    public String query() { return "[]"; }

    @WinPostMapping(value = "/update")
    public String update() { return "{}"; }
}
`);

    const routes = extractSpringRoutes(tree, 'OrderController.java');
    expect(routes).toHaveLength(3);

    const postRoutes = routes.filter((r) => r.httpMethod === 'POST');
    expect(postRoutes).toHaveLength(2);
    const postPaths = postRoutes.map((r) => r.routePath).sort();
    expect(postPaths).toEqual(['/create', '/update']);
    for (const r of postRoutes) {
      expect(r.prefix).toBe('/api/opt');
    }

    const getRoute = routes.find((r) => r.httpMethod === 'GET')!;
    expect(getRoute.routePath).toBe('/query');
    expect(getRoute.prefix).toBe('/api/opt');
  });

  it('extracts routes when vendor and standard annotations are mixed', () => {
    const tree = parse(`
@RestController
@RequestMapping("/api/mix")
public class MixedController {
    @WinPostMapping("/win-create")
    public String winCreate() { return "{}"; }

    @PostMapping("/std-create")
    public String stdCreate() { return "{}"; }

    @GetMapping("/std-get")
    public String stdGet() { return "[]"; }
}
`);

    const routes = extractSpringRoutes(tree, 'MixedController.java');
    expect(routes).toHaveLength(3);

    const paths = routes.map((r) => r.routePath).sort();
    expect(paths).toEqual(['/std-create', '/std-get', '/win-create']);
  });

  it('ingestion and group extractors agree on vendor annotation routes', () => {
    const tree = parse(`
@RestController
@RequestMapping("/api/parity")
public class ParityController {
    @WinPostMapping("/create")
    public String create() { return "{}"; }

    @WinGetMapping("/query")
    public String query() { return "[]"; }
}
`);

    const ingestionRoutes = new Set(
      extractSpringRoutes(tree, 'ParityController.java').map(
        (r) => `${r.httpMethod} ${normalizeExtractedRoutePath(r.routePath, r.prefix ?? null)}`,
      ),
    );

    const groupRoutes = new Set(
      JAVA_HTTP_PLUGIN.scan(tree)
        .filter((d) => d.role === 'provider')
        .map((d) => `${d.method} ${normalizeExtractedRoutePath(d.path, null)}`),
    );

    expect([...ingestionRoutes].sort()).toEqual([...groupRoutes].sort());
    expect([...ingestionRoutes].sort()).toEqual([
      'GET /api/parity/query',
      'POST /api/parity/create',
    ]);
  });
});
