/**
 * Parity test for the two Spring route extractors (#2078 maintainer request,
 * #2138 follow-up).
 *
 * GitNexus parses Spring `@(Get|Post|...)Mapping` annotations in TWO places:
 *   - ingestion `route-extractors/spring.ts` → `extractSpringRoutes` (produces
 *     graph `Route` nodes)
 *   - group `http-patterns/java.ts` → `JAVA_HTTP_PLUGIN.scan` (produces
 *     cross-repo HTTP contracts)
 *
 * They serve different layers and stay separate, but they MUST agree on the
 * set of provider (method, path) routes they recognise for the same source —
 * otherwise the graph under-covers what the group scan sees, which is exactly
 * the divergence behind the #2265 array-form gap (the group query matched
 * `@GetMapping({"/a","/b"})`, ingestion's didn't). This test runs one shared
 * fixture through both and asserts the provider sets are identical, so the two
 * can't silently drift again.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { extractSpringRoutes } from '../../../src/core/ingestion/route-extractors/spring.js';
import { JAVA_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/java.js';

function parse(src: string): Parser.Tree {
  const p = new Parser();
  p.setLanguage(Java);
  return p.parse(src);
}

/** Canonical `METHOD /a/b` form so prefix-join / slash / case differences wash out. */
function canon(method: string, ...segments: string[]): string {
  const path = `/${segments.join('/').split('/').filter(Boolean).join('/')}`;
  return `${method.toUpperCase()} ${path.toLowerCase()}`;
}

/** ingestion side: join the class prefix + method path the way the routes phase does. */
function ingestionProviders(src: string): Set<string> {
  return new Set(
    extractSpringRoutes(parse(src), 'X.java').map((r) =>
      canon(r.httpMethod, r.prefix ?? '', r.routePath),
    ),
  );
}

/** group side: provider detections (path already prefix-joined by the plugin). */
function groupProviders(src: string): Set<string> {
  return new Set(
    JAVA_HTTP_PLUGIN.scan(parse(src))
      .filter((d) => d.role === 'provider')
      .map((d) => canon(d.method, d.path)),
  );
}

describe('Spring route extractor parity — ingestion spring.ts vs group java.ts', () => {
  it('agree on bare, named-arg, and array-form method routes under a class prefix', () => {
    const src = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping("/list") public Object list() { return null; }
  @PostMapping(path = "/make") public Object make() { return null; }
  @PutMapping(value = "/update") public Object update() { return null; }
  @GetMapping({"/a", "/b"}) public Object multi() { return null; }
}
`;
    const ingestion = ingestionProviders(src);
    const group = groupProviders(src);

    // The array form is the regression that motivated this: both must see all four.
    expect(group).toEqual(
      new Set([
        'GET /api/orders/list',
        'POST /api/orders/make',
        'PUT /api/orders/update',
        'GET /api/orders/a',
        'GET /api/orders/b',
      ]),
    );
    expect(ingestion).toEqual(group);
  });

  it('agree on a no-prefix controller with a positional array', () => {
    const src = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class PlainController {
  @GetMapping("/solo") public Object solo() { return null; }
  @DeleteMapping({"/x", "/y", "/z"}) public Object many() { return null; }
}
`;
    expect(ingestionProviders(src)).toEqual(groupProviders(src));
  });
});
