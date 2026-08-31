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
import { describe, it, expect, vi } from 'vitest';
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
  });

  it('ignores unregistered vendor prefixes (review: suffix-only accepted @AuditPostMapping)', () => {
    // Suffix matching alone produced phantom routes from unrelated
    // annotations like @AuditPostMapping — resolution now requires a
    // registered prefix (Win by default).
    expect(resolveSpringAnnotationAlias('AuditPostMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('CompanyPostMapping')).toBeUndefined();
    expect(resolveSpringAnnotationAlias('XyzGetMapping')).toBeUndefined();
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

// ═══════════════════════════════════════════════════════════════════════════
// Review regressions (magyargergo, 2026-08-29)
// ═══════════════════════════════════════════════════════════════════════════

describe('review regressions: class-level aliases', () => {
  it('P1: isClassLevelMappingAnnotation accepts @WinRequestMapping like @RequestMapping', async () => {
    const { isClassLevelMappingAnnotation } = await import(
      '../../src/core/ingestion/route-extractors/spring-shared.js'
    );
    expect(isClassLevelMappingAnnotation('RequestMapping')).toBe(true);
    expect(isClassLevelMappingAnnotation('WinRequestMapping')).toBe(true);
    expect(isClassLevelMappingAnnotation('WinPostMapping')).toBe(false);
    expect(isClassLevelMappingAnnotation('AuditRequestMapping')).toBe(false);
    expect(isClassLevelMappingAnnotation('GetMapping')).toBe(false);
  });

  it('P1: vendor class prefix flows into route paths (@WinRequestMapping + @WinGetMapping)', () => {
    const tree = parse(`
@WinRequestMapping("/vendor")
public class VendorController {
    @WinGetMapping("/users")
    public String list() { return "ok"; }
}
`);
    const routes = extractSpringRoutes(tree, 'VendorController.java');
    expect(routes).toHaveLength(1);
    // Class prefix /vendor comes from the aliased @WinRequestMapping — the
    // exact path the old exact-match-only class handling missed (review P1).
    expect(routes[0].prefix).toBe('/vendor');
    expect(routes[0].routePath).toBe('/users');
    expect(routes[0].httpMethod).toBe('GET');
  });

  it('P2: unregistered suffix no longer emits a phantom route (end-to-end)', () => {
    const tree = parse(`
public class AuditController {
    @AuditPostMapping("/audit")
    public String audit() { return "x"; }
}
`);
    const routes = extractSpringRoutes(tree, 'AuditController.java');
    expect(routes).toHaveLength(0);
  });

  it('P2: extra vendor prefixes can be registered via env', async () => {
    process.env.GITNEXUS_SPRING_VENDOR_PREFIXES = 'Win,Acme';
    // Re-import a fresh copy of the module graph so the env is picked up.
    vi.resetModules();
    const fresh = await import('../../src/core/ingestion/route-extractors/spring-shared.js');
    expect(fresh.resolveSpringAnnotationAlias('AcmePostMapping')).toBe('PostMapping');
    expect(fresh.resolveSpringAnnotationAlias('OtherPostMapping')).toBeUndefined();
    delete process.env.GITNEXUS_SPRING_VENDOR_PREFIXES;
    vi.resetModules();
  });
});
