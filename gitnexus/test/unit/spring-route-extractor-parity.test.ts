/**
 * Parity test: the two Spring route extractors must agree.
 *
 * The ingestion-layer extractor (`route-extractors/spring.ts`, producing
 * graph `Route` nodes) and the group-layer extractor
 * (`group/extractors/http-patterns/java.ts`, producing cross-repo HTTP
 * contracts) share their low-level primitives via `route-extractors/
 * spring-shared.ts`. They keep separate output shapes and the group layer
 * carries extra consumer/inheritance handling the ingestion side doesn't
 * need — but for plain Spring `@RestController` providers they MUST surface
 * the same set of (HTTP method, full URL) pairs.
 *
 * This test parses one shared fixture through both extractors and asserts
 * the provider method/path combinations match, so the two implementations
 * can't drift apart on the semantics they share.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { extractSpringRoutes } from '../../src/core/ingestion/route-extractors/spring.js';
import { JAVA_HTTP_PLUGIN } from '../../src/core/group/extractors/http-patterns/java.js';
import { normalizeExtractedRoutePath } from '../../src/core/ingestion/route-extractors/route-path.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(code);
}

/** Shared fixture: a Spring controller exercising every supported verb,
 *  positional + named args, and a class-level @RequestMapping prefix. */
const SPRING_FIXTURE = `
package com.example.controller;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/list")
    public String list() { return "[]"; }

    @PostMapping("/create")
    public String create() { return "{}"; }

    @PutMapping(value = "/update")
    public void update() {}

    @DeleteMapping(path = "/delete")
    public void delete() {}

    @PatchMapping("/patch")
    public void patch() {}
}
`;

/** Normalize an ingestion route (separate routePath + prefix) to a full URL. */
function ingestionPairs(tree: Parser.Tree): Set<string> {
  return new Set(
    extractSpringRoutes(tree, 'UserController.java').map(
      (r) => `${r.httpMethod} ${normalizeExtractedRoutePath(r.routePath, r.prefix ?? null)}`,
    ),
  );
}

/** Normalize a group provider detection (path already prefix-joined) to a full URL. */
function groupPairs(tree: Parser.Tree): Set<string> {
  return new Set(
    JAVA_HTTP_PLUGIN.scan(tree)
      .filter((d) => d.role === 'provider')
      .map((d) => `${d.method} ${normalizeExtractedRoutePath(d.path, null)}`),
  );
}

describe('Spring route extractor parity (ingestion vs group)', () => {
  it('both extractors surface the same provider method/path combinations', () => {
    const tree = parse(SPRING_FIXTURE);

    const ingestion = ingestionPairs(tree);
    const group = groupPairs(tree);

    // Both must agree on the full set — no route only one side sees.
    expect([...ingestion].sort()).toEqual([...group].sort());

    // Sanity: the expected combinations are actually present (guards against
    // both extractors silently agreeing on an empty set).
    expect(ingestion).toEqual(
      new Set([
        'GET /api/users/list',
        'POST /api/users/create',
        'PUT /api/users/update',
        'DELETE /api/users/delete',
        'PATCH /api/users/patch',
      ]),
    );
  });

  it('agree when there is no class-level prefix', () => {
    const tree = parse(`
@RestController
public class HealthController {
    @GetMapping("/health")
    public String health() { return "OK"; }

    @PostMapping("/ping")
    public String ping() { return "OK"; }
}
`);

    expect([...ingestionPairs(tree)].sort()).toEqual([...groupPairs(tree)].sort());
  });
});
