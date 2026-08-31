/**
 * Group ↔ ingestion parity for Java constant-valued Spring route paths (#2980).
 *
 * Drives `JAVA_HTTP_PLUGIN.prepareRepo` + `scan(tree, ctx, rel)` with all three
 * arguments and compares the result against what `extractSpringRoutes` + the
 * Java operand fold produce on the ingestion side. The existing Spring parity
 * guards call `scan(tree)` with ONE argument, which makes them structurally
 * blind here: without a repo context the plugin drops every constant-valued
 * route, so no fixture they carry can exercise this feature.
 *
 * Asserted:
 *   • a constant-valued mapping resolves to the SAME path on both sides;
 *   • a CONSTANT class prefix suppresses the method route on both sides — the
 *     prefix cannot be folded at extraction time, and emitting the route
 *     unprefixed would publish a path the application does not serve;
 *   • without a repo context the group side emits nothing (the documented skip
 *     floor, and the branch that makes the 1-arg guards blind);
 *   • literal routes are untouched.
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { JAVA_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/java.js';
import type { HttpDetection } from '../../../src/core/group/extractors/http-patterns/types.js';
import { extractSpringRoutes } from '../../../src/core/ingestion/route-extractors/spring.js';
import { javaProvider } from '../../../src/core/ingestion/languages/java.js';
import {
  expandJavaWildcardStaticImports,
  extractJavaModuleConstants,
  foldJavaOperands,
  type RepoConstants,
} from '../../../src/core/ingestion/route-extractors/java-const-resolver.js';

const parser = new Parser();
const parseSource = (p: Parser, src: string): Parser.Tree => {
  p.setLanguage(Java);
  return p.parse(src);
};
const parse = (src: string): Parser.Tree => parseSource(parser, src);

/** Group side: prepareRepo + a 3-argument scan over every .java file. */
function groupProviders(files: Record<string, string>): string[] {
  const ctx = JAVA_HTTP_PLUGIN.prepareRepo?.({
    files: Object.keys(files),
    parser: new Parser(),
    readFile: (rel: string) => files[rel] ?? null,
    parseSource,
  });
  const out: string[] = [];
  for (const rel of Object.keys(files)) {
    const detections: HttpDetection[] = JAVA_HTTP_PLUGIN.scan(parse(files[rel]), ctx, rel);
    for (const d of detections) {
      if (d.role === 'provider') out.push(`${d.method} ${d.path}`);
    }
  }
  return out.sort();
}

/** Ingestion side: extract routes, then fold operands against the same map. */
function ingestionRoutes(files: Record<string, string>): string[] {
  const repo: RepoConstants = new Map();
  for (const [rel, src] of Object.entries(files)) {
    repo.set(rel, extractJavaModuleConstants(parse(src)));
  }
  for (const [rel, mc] of repo) {
    expandJavaWildcardStaticImports(mc, rel, repo);
  }
  const out: string[] = [];
  for (const [rel, src] of Object.entries(files)) {
    for (const route of extractSpringRoutes(parse(src), rel, 0)) {
      const path = route.routePathOperands
        ? foldJavaOperands(rel, route.routePathOperands, repo)
        : route.routePath;
      if (path === null) continue;
      out.push(`${route.httpMethod} ${`${route.prefix ?? ''}${path}`.replace(/\/{2,}/g, '/')}`);
    }
  }
  return out.sort();
}

const CONSTS = 'src/main/java/com/example/ApiPaths.java';
const CTL = 'src/main/java/com/example/OrderController.java';

const CONSTS_SRC = `package com.example;
public class ApiPaths {
  public static final String BASE = "/api/v1";
  public static final String ORDERS = "/api/v1/orders";
}`;

describe('Java constant-valued routes: group ↔ ingestion parity (#2980)', () => {
  it('resolves a constant-valued mapping to the same path on both sides', () => {
    const files = {
      [CONSTS]: CONSTS_SRC,
      [CTL]: `package com.example;
import com.example.ApiPaths;
public class OrderController {
  @GetMapping(ApiPaths.ORDERS)
  public void list() {}
}`,
    };
    expect(groupProviders(files)).toEqual(['GET /api/v1/orders']);
    expect(ingestionRoutes(files)).toEqual(groupProviders(files));
  });

  it('suppresses the method route under a CONSTANT class prefix on both sides', () => {
    // The class prefix needs the repo-wide constant map, which does not exist
    // at extraction time on either side. Emitting the method route would drop
    // the prefix and publish `GET /api/v1/orders`-without-its-base — a path the
    // application never serves. On base such a route was not emitted at all, so
    // shipping it unprefixed would turn a missing fact into a wrong one.
    const files = {
      [CONSTS]: CONSTS_SRC,
      [CTL]: `package com.example;
import com.example.ApiPaths;
@RequestMapping(ApiPaths.BASE)
public class OrderController {
  @GetMapping(ApiPaths.ORDERS)
  public void list() {}

  @GetMapping("/literal")
  public void literal() {}
}`,
    };
    expect(groupProviders(files)).toEqual([]);
    expect(ingestionRoutes(files)).toEqual([]);
  });

  it('still applies a LITERAL class prefix', () => {
    const files = {
      [CONSTS]: CONSTS_SRC,
      [CTL]: `package com.example;
import com.example.ApiPaths;
@RequestMapping("/api/v1")
public class OrderController {
  @GetMapping("/orders")
  public void list() {}
}`,
    };
    expect(groupProviders(files)).toEqual(['GET /api/v1/orders']);
    expect(ingestionRoutes(files)).toEqual(['GET /api/v1/orders']);
  });

  it('emits nothing for a constant route when scanned without a repo context', () => {
    // This is the branch that makes the 1-argument parity guards blind to the
    // whole feature; pin it so it is not silently dead in the suite.
    const src = `package com.example;
import com.example.ApiPaths;
public class OrderController {
  @GetMapping(ApiPaths.ORDERS)
  public void list() {}
}`;
    const detections = JAVA_HTTP_PLUGIN.scan(parse(src));
    expect(detections.filter((d) => d.role === 'provider')).toEqual([]);
  });

  it('suppresses a NO-ARGUMENT mapping under a constant class prefix on both sides', () => {
    // A bare `@GetMapping` IS the class prefix, so an unfoldable class prefix
    // leaves nothing to emit. Ingestion routes these through a separate loop
    // from the path-carrying ones, and that loop needs the same guard — without
    // it ingestion emitted an empty-path Route where the group emitted nothing.
    const files = {
      [CONSTS]: CONSTS_SRC,
      [CTL]: `package com.example;
import com.example.ApiPaths;
@RequestMapping(ApiPaths.BASE)
public class OrderController {
  @GetMapping public void list() {}
  @PostMapping public void create() {}
}`,
    };
    expect(ingestionRoutes(files)).toEqual([]);
    expect(groupProviders(files)).toEqual([]);
  });

  it('measures import ambiguity over the same candidate set on both sides', () => {
    // Ingestion's harvest gate also admits import-only files, so its repo map is
    // a superset of the group's. When ambiguity was measured over every key, a
    // duplicate FQN belonging to a class that defines NOTHING was invisible to
    // the group and made ingestion alone floor to skip — reopening the very
    // parity break this feature exists to close. Both sides now measure over
    // constant-DEFINING files only.
    const files = {
      'svc-a/src/main/java/com/x/ApiPaths.java': `package com.x;
public class ApiPaths { public static final String ORDERS = "/api/v1/orders"; }`,
      // Same FQN, different module, defines no constant — must not create ambiguity.
      'svc-b/src/main/java/com/x/ApiPaths.java': `package com.x;
import java.util.List;
public class ApiPaths {}`,
      'svc-a/src/main/java/com/x/web/OrderController.java': `package com.x.web;
import com.x.ApiPaths;
public class OrderController {
  @GetMapping(ApiPaths.ORDERS)
  public void list() {}
}`,
    };
    // Guard the premise: the two maps really are different sizes.
    const ingestionKeys = Object.entries(files).filter(([, src]) =>
      javaProvider.moduleConstantHeuristic?.(src),
    ).length;
    expect(ingestionKeys).toBe(3);
    expect(groupProviders(files)).toEqual(['GET /api/v1/orders']);
    expect(ingestionRoutes(files)).toEqual(['GET /api/v1/orders']);
  });

  it('resolves a wildcard-static-imported mapping on both sides', () => {
    const files = {
      [CONSTS]: CONSTS_SRC,
      [CTL]: `package com.example;
import static com.example.ApiPaths.*;
public class OrderController {
  @GetMapping(ORDERS)
  public void list() {}
}`,
    };
    expect(javaProvider.moduleConstantHeuristic?.(files[CTL])).toBe(true);
    expect(groupProviders(files)).toEqual(['GET /api/v1/orders']);
    expect(ingestionRoutes(files)).toEqual(groupProviders(files));
  });

  it('leaves literal routes unchanged with no constant map at all', () => {
    const files = {
      [CTL]: `package com.example;
public class OrderController {
  @PostMapping("/api/v1/orders")
  public void create() {}
}`,
    };
    expect(groupProviders(files)).toEqual(['POST /api/v1/orders']);
    expect(ingestionRoutes(files)).toEqual(['POST /api/v1/orders']);
  });
});
