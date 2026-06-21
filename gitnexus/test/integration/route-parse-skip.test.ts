/**
 * #2138 Part 2 · U4 — parse-skip proof.
 *
 * The win: for files whose provider routes are fully covered by the graph in a
 * `routeCoverage: 'complete'` language (Java/Spring here), `HttpRouteExtractor`
 * must skip the source scan AND the tree-sitter parse — the graph is
 * authoritative. This is the measurable reduction #2167 could not demonstrate.
 *
 * We spy the real `parseSourceSafe` to COUNT parses (deterministic, not
 * wall-time), over a real temp repo of Java controllers, with a mock DB that
 * returns resolved HANDLES_ROUTE rows. Three scenarios:
 *   1. no graph (baseline)  → every Java file is parsed.
 *   2. fully covered        → ZERO Java files parsed (the win).
 *   3. one unresolved route → that file falls back to a scan (parsed); the
 *      resolved file stays skipped (fail-open is per-file, not per-repo).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Count real parses by wrapping the actual parseSourceSafe.
const parseCalls: string[] = [];
vi.mock('../../src/core/tree-sitter/safe-parse.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../src/core/tree-sitter/safe-parse.js')>();
  return {
    ...actual,
    parseSourceSafe: (parser: unknown, src: unknown) => {
      // src is the file content string; record it so tests can attribute the
      // parse to a specific controller by class name.
      parseCalls.push(typeof src === 'string' ? src : '<non-string>');
      return (actual.parseSourceSafe as (p: unknown, s: unknown) => unknown)(parser, src);
    },
  };
});

import { HttpRouteExtractor } from '../../src/core/group/extractors/http-route-extractor.js';

let repoDir: string;

const CONTROLLER_A = `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/a")
public class AController {
  @GetMapping("/list")
  public Object list() { return null; }
}
`;
const CONTROLLER_B = `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/b")
public class BController {
  @PostMapping("/make")
  public Object make() { return null; }
}
`;
// A provider that ALSO calls out via RestTemplate — fully provider-covered by
// the graph, but its consumer contract (/api/inventory) lives only in source.
const CONTROLLER_C = `package com.example;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;
@RestController
@RequestMapping("/api/c")
public class CController {
  private RestTemplate restTemplate;
  @GetMapping("/list")
  public Object list() { return restTemplate.getForObject("/api/inventory", Object.class); }
}
`;

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-parse-skip-'));
  fs.writeFileSync(path.join(repoDir, 'AController.java'), CONTROLLER_A);
  fs.writeFileSync(path.join(repoDir, 'BController.java'), CONTROLLER_B);
});

afterAll(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

beforeEach(() => {
  parseCalls.length = 0;
});

const repo = { name: 'r', url: 'r' } as never;

/** A mock DB whose HANDLES_ROUTE rows resolve (or not) per file. */
function makeDb(opts: { resolved: Record<string, boolean> }) {
  return vi.fn(async (query: string) => {
    if (query.includes('HANDLES_ROUTE')) {
      return [
        {
          fileId: 'File:AController.java',
          filePath: 'AController.java',
          routePath: '/api/a/list',
          routeMethod: 'GET',
          handlerSymbolId: opts.resolved['AController.java'] ? 'Method:AController.java:list' : '',
          routeSource: 'framework-route',
        },
        {
          fileId: 'File:BController.java',
          filePath: 'BController.java',
          routePath: '/api/b/make',
          routeMethod: 'POST',
          handlerSymbolId: opts.resolved['BController.java'] ? 'Method:BController.java:make' : '',
          routeSource: 'framework-route',
        },
      ];
    }
    if (query.includes('CONTAINS')) {
      // Return both handler symbols; the extractor picks by id.
      return [
        { uid: 'Method:AController.java:list', name: 'list', filePath: 'AController.java', labels: ['Method'] },
        { uid: 'Method:BController.java:make', name: 'make', filePath: 'BController.java', labels: ['Method'] },
      ];
    }
    return []; // FETCHES → no consumers
  });
}

describe('HttpRouteExtractor — parse-skip for graph-covered files (#2138 U4)', () => {
  it('baseline: with no graph, every Java file is parsed', async () => {
    const out = await new HttpRouteExtractor().extract(null, repoDir, repo);
    // Both controllers discovered via source scan.
    const paths = out.filter((c) => c.role === 'provider').map((c) => c.meta.path);
    expect(paths).toEqual(expect.arrayContaining(['/api/a/list', '/api/b/make']));
    // Both files were parsed.
    expect(parseCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('fully covered: zero Java files parsed (the win)', async () => {
    const out = await new HttpRouteExtractor().extract(
      makeDb({ resolved: { 'AController.java': true, 'BController.java': true } }),
      repoDir,
      repo,
    );
    // Providers still produced — from the graph.
    const providers = out.filter((c) => c.role === 'provider');
    expect(providers.map((c) => c.meta.path)).toEqual(
      expect.arrayContaining(['/api/a/list', '/api/b/make']),
    );
    expect(providers.every((c) => c.meta.extractionStrategy === 'graph_assisted')).toBe(true);
    // The whole point: no source parse happened for the covered files.
    expect(parseCalls.length).toBe(0);
  });

  it('mixed: an unresolved route falls back to a scan; the resolved file stays skipped', async () => {
    await new HttpRouteExtractor().extract(
      makeDb({ resolved: { 'AController.java': true, 'BController.java': false } }),
      repoDir,
      repo,
    );
    const parsedA = parseCalls.some((s) => s.includes('class AController'));
    const parsedB = parseCalls.some((s) => s.includes('class BController'));
    // B (unresolved) falls back to a source scan → parsed.
    expect(parsedB).toBe(true);
    // A (resolved + complete-coverage language) stays skipped → NOT parsed.
    expect(parsedA).toBe(false);
  });

  it('provider-covered file that ALSO calls out is still parsed (consumer not dropped)', async () => {
    // Own repo dir so the file set is exactly one provider+consumer controller.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-parse-skip-consumer-'));
    fs.writeFileSync(path.join(dir, 'CController.java'), CONTROLLER_C);
    try {
      const db = vi.fn(async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) {
          return [
            {
              fileId: 'File:CController.java',
              filePath: 'CController.java',
              routePath: '/api/c/list',
              routeMethod: 'GET',
              handlerSymbolId: 'Method:CController.java:list', // fully resolved
              routeSource: 'framework-route',
            },
          ];
        }
        if (query.includes('CONTAINS')) {
          return [
            { uid: 'Method:CController.java:list', name: 'list', filePath: 'CController.java', labels: ['Method'] },
          ];
        }
        return [];
      });
      const out = await new HttpRouteExtractor().extract(db, dir, repo);

      // Provider still produced from the graph.
      expect(out.some((c) => c.role === 'provider' && c.meta.path === '/api/c/list')).toBe(true);
      // The consumer call lives only in source — it MUST survive because the
      // file's consumer signal kept it in the scan set (so it was parsed).
      expect(parseCalls.some((s) => s.includes('class CController'))).toBe(true);
      expect(out.some((c) => c.role === 'consumer' && c.meta.path === '/api/inventory')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
