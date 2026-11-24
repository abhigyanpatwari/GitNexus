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
import assert from 'node:assert/strict';
import { describe, it, afterEach, beforeEach } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { extractSpringRoutes } from '../../../../../src/core/ingestion/route-extractors/spring.js';
import { JAVA_HTTP_PLUGIN } from '../../../../../src/core/group/extractors/http-patterns/java.js';
import { normalizeExtractedRoutePath } from '../../../../../src/core/ingestion/route-extractors/route-path.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(code);
}

const priorPrefixes = process.env.GITNEXUS_SPRING_VENDOR_PREFIXES;
beforeEach(() => {
  process.env.GITNEXUS_SPRING_VENDOR_PREFIXES = 'Win';
});
afterEach(() => {
  if (priorPrefixes === undefined) delete process.env.GITNEXUS_SPRING_VENDOR_PREFIXES;
  else process.env.GITNEXUS_SPRING_VENDOR_PREFIXES = priorPrefixes;
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
    assert.equal(routes.length, 3);

    const postRoutes = routes.filter((r) => r.httpMethod === 'POST');
    assert.equal(postRoutes.length, 2);
    const postPaths = postRoutes.map((r) => r.routePath).sort();
    assert.deepEqual(postPaths, ['/create', '/update']);
    for (const r of postRoutes) {
      assert.equal(r.prefix, '/api/opt');
    }

    const getRoute = routes.find((r) => r.httpMethod === 'GET')!;
    assert.equal(getRoute.routePath, '/query');
    assert.equal(getRoute.prefix, '/api/opt');
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
    assert.equal(routes.length, 3);

    const paths = routes.map((r) => r.routePath).sort();
    assert.deepEqual(paths, ['/std-create', '/std-get', '/win-create']);
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

    assert.deepEqual([...ingestionRoutes].sort(), [...groupRoutes].sort());
    assert.deepEqual([...ingestionRoutes].sort(), [
      'GET /api/parity/query',
      'POST /api/parity/create',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Review regressions (magyargergo, 2026-08-29)
// ═══════════════════════════════════════════════════════════════════════════

describe('review regressions: class-level aliases', () => {
  it('P1: vendor class prefix flows into route paths (@WinRequestMapping + @WinGetMapping)', () => {
    const tree = parse(`
@WinRequestMapping("/vendor")
public class VendorController {
    @WinGetMapping("/users")
    public String list() { return "ok"; }
}
`);
    const routes = extractSpringRoutes(tree, 'VendorController.java');
    assert.equal(routes.length, 1);
    // Class prefix /vendor comes from the aliased @WinRequestMapping — the
    // exact path the old exact-match-only class handling missed (review P1).
    assert.equal(routes[0].prefix, '/vendor');
    assert.equal(routes[0].routePath, '/users');
    assert.equal(routes[0].httpMethod, 'GET');
    assert.deepEqual(
      JAVA_HTTP_PLUGIN.scan(tree)
        .filter((detection) => detection.role === 'provider')
        .map((detection) => `${detection.method} ${detection.path}`),
      ['GET /vendor/users'],
    );
  });

  it('P2: unregistered suffix no longer emits a phantom route (end-to-end)', () => {
    const tree = parse(`
public class AuditController {
    @AuditPostMapping("/audit")
    public String audit() { return "x"; }
}
`);
    const routes = extractSpringRoutes(tree, 'AuditController.java');
    assert.equal(routes.length, 0);
    assert.deepEqual(
      JAVA_HTTP_PLUGIN.scan(tree).filter((detection) => detection.role === 'provider'),
      [],
    );
  });
});
