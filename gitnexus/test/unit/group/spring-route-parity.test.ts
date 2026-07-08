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
 * fixture through both and asserts the provider sets are identical for the
 * shapes ingestion claims to cover: bare, named-arg, and array-form method
 * routes under a *scalar* (or absent) class prefix.
 *
 * Known, deliberate divergence (NOT covered by the equality assertions): a
 * method-level array route nested under a class-level *array-form*
 * @RequestMapping. Ingestion suppresses it (it can't resolve which of several
 * class prefixes to apply, and a dropped-prefix route is a wrong signal), while
 * the group layer emits the full cross-product. The last test pins this so the
 * suppression can't silently regress into emitting wrong routes; full
 * class-array support is tracked in #2280.
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

  it('agree on named-arg ARRAY forms (path = {...} / value = {...})', () => {
    // Guards the spring.ts named-array query branch specifically: positional
    // arrays alone would not exercise it.
    const src = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class NamedArrayController {
  @PutMapping(value = {"/update", "/modify"}) public Object upd() { return null; }
  @DeleteMapping(path = {"/x", "/y"}) public Object del() { return null; }
}
`;
    const group = groupProviders(src);
    expect(group).toEqual(
      new Set(['PUT /api/update', 'PUT /api/modify', 'DELETE /api/x', 'DELETE /api/y']),
    );
    expect(ingestionProviders(src)).toEqual(group);
  });

  it('do not leak non-route arrays (consumes/produces) as routes — array analogue', () => {
    // The scalar `produces` anti-regression already exists in the route tests;
    // this is its array form. `consumes`/`produces` arrays must never surface as
    // provider routes; only the path value does.
    const src = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class ContentTypeController {
  @GetMapping(value = "/v", consumes = {"application/json", "application/xml"}, produces = {"application/json"})
  public Object v() { return null; }
  @PostMapping(consumes = {"application/json"})
  public Object noPath() { return null; }
}
`;
    const ingestion = ingestionProviders(src);
    const group = groupProviders(src);
    // Only the explicit path leaks through; the consumes/produces arrays do not,
    // and the path-less @PostMapping contributes nothing.
    expect(group).toEqual(new Set(['GET /v']));
    expect(ingestion).toEqual(group);

    // Pure-consumes controller (no path anywhere) → EMPTY provider set on both
    // sides: a consumes/produces array must never be misread as a route path.
    const consumesOnly = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class ConsumesOnlyController {
  @PostMapping(consumes = {"application/json", "application/xml"})
  public Object a() { return null; }
  @PutMapping(produces = {"application/json"})
  public Object b() { return null; }
}
`;
    expect(groupProviders(consumesOnly)).toEqual(new Set());
    expect(ingestionProviders(consumesOnly)).toEqual(new Set());
  });

  it('pins the deliberate class-array divergence: ingestion suppresses, group emits cross-product (#2280)', () => {
    // A method-level array under a class-level ARRAY-form @RequestMapping. There
    // is no single class prefix to apply, so ingestion suppresses the route
    // rather than emit it unprefixed (a wrong signal). The group layer emits the
    // full cross-product. This is a KNOWN gap (#2280), pinned here so the
    // suppression can't silently regress into emitting wrong unprefixed routes.
    const src = `package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/base/one", "/base/two"})
public class MultiPrefixController {
  @GetMapping({"/primary", "/alias"}) public Object x() { return null; }
}
`;
    const ingestion = ingestionProviders(src);
    const group = groupProviders(src);

    // group: correct cross-product of the two class prefixes × two method paths.
    expect(group).toEqual(
      new Set([
        'GET /base/one/primary',
        'GET /base/two/primary',
        'GET /base/one/alias',
        'GET /base/two/alias',
      ]),
    );
    // ingestion: suppressed — emits NO route for the array method (never a wrong
    // unprefixed `GET /primary` / `GET /alias`).
    expect(ingestion).toEqual(new Set());
    // And the divergence is asymmetric-by-design: ingestion ⊊ group here.
    expect(ingestion).not.toEqual(group);
  });
});
