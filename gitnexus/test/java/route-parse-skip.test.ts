/**
 * #2138 Part 2 · parse-skip proof + P1 regression guards.
 *
 * The win: for a file whose provider routes are fully covered by the graph in a
 * `routeCoverage: 'complete'` language, `HttpRouteExtractor` skips the source
 * scan AND the tree-sitter parse — the graph is authoritative. We spy the real
 * `parseSourceSafe` to COUNT parses (deterministic, not wall-time).
 *
 * PHP/Laravel is the language used for the *win* scenarios: ingestion's Laravel
 * route extraction is a superset of the group PHP scan, so PHP is `'complete'`.
 *
 * Java is deliberately `'partial'` (the graph provider set is a strict subset of
 * the group Java scan — array-form, interface-inherited, and same-URL multi-verb
 * routes have no graph Route node). The Java cases below are REGRESSION GUARDS:
 * they prove those group-only routes survive because Java is never parse-skipped.
 * If someone flips Java to `'complete'` without making ingestion provider-
 * complete, these tests fail — exactly the #2138 P1 data-loss class.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Count real parses by wrapping the actual parseSourceSafe.
const parseCalls: string[] = [];
vi.mock('../../src/core/tree-sitter/safe-parse.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/core/tree-sitter/safe-parse.js')>();
  return {
    ...actual,
    parseSourceSafe: (parser: unknown, src: unknown) => {
      parseCalls.push(typeof src === 'string' ? src : '<non-string>');
      return (actual.parseSourceSafe as (p: unknown, s: unknown) => unknown)(parser, src);
    },
  };
});

import { HttpRouteExtractor } from '../../src/core/group/extractors/http-route-extractor.js';

const repo = { name: 'r', url: 'r' } as never;

beforeEach(() => {
  parseCalls.length = 0;
});

function mkRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-parse-skip-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/** HANDLES_ROUTE rows from a compact spec; CONTAINS/FETCHES return empty. */
function makeDb(
  rows: Array<{ file: string; routePath: string; method: string; resolved: boolean }>,
) {
  return vi.fn(async (query: string) => {
    if (query.includes('HANDLES_ROUTE')) {
      return rows.map((r, i) => ({
        fileId: `File:${r.file}`,
        filePath: r.file,
        routePath: r.routePath,
        routeMethod: r.method,
        handlerSymbolId: r.resolved ? `Method:${r.file}:h${i}` : '',
        routeSource: 'framework-route',
      }));
    }
    return []; // CONTAINS (basename fallback is fine) + FETCHES (no consumers)
  });
}

const providerPaths = (out: Awaited<ReturnType<HttpRouteExtractor['extract']>>) =>
  out.filter((c) => c.role === 'provider').map((c) => `${c.meta.method}::${c.meta.path}`);

// ── PHP / Laravel — the `'complete'` language where the skip engages ──────────

const ROUTES_A = `<?php
Route::get('/api/a/list', 'AController@list');
`;
const ROUTES_B = `<?php
Route::post('/api/b/make', 'BController@make');
`;

describe('HttpRouteExtractor — PHP parse-skip for graph-covered files (#2138)', () => {
  it('baseline: with no graph, every PHP file is parsed', async () => {
    const dir = mkRepo({ 'routes_a.php': ROUTES_A, 'routes_b.php': ROUTES_B });
    try {
      const out = await new HttpRouteExtractor().extract(null, dir, repo);
      expect(providerPaths(out)).toEqual(
        expect.arrayContaining(['GET::/api/a/list', 'POST::/api/b/make']),
      );
      expect(parseCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fully covered: zero PHP files parsed (the win)', async () => {
    const dir = mkRepo({ 'routes_a.php': ROUTES_A, 'routes_b.php': ROUTES_B });
    try {
      const out = await new HttpRouteExtractor().extract(
        makeDb([
          { file: 'routes_a.php', routePath: '/api/a/list', method: 'GET', resolved: true },
          { file: 'routes_b.php', routePath: '/api/b/make', method: 'POST', resolved: true },
        ]),
        dir,
        repo,
      );
      const providers = out.filter((c) => c.role === 'provider');
      expect(providers.map((c) => c.meta.path)).toEqual(
        expect.arrayContaining(['/api/a/list', '/api/b/make']),
      );
      expect(providers.every((c) => c.meta.extractionStrategy === 'graph_assisted')).toBe(true);
      expect(parseCalls.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mixed: an unresolved route falls back to a scan; the resolved file stays skipped', async () => {
    const dir = mkRepo({ 'routes_a.php': ROUTES_A, 'routes_b.php': ROUTES_B });
    try {
      await new HttpRouteExtractor().extract(
        makeDb([
          { file: 'routes_a.php', routePath: '/api/a/list', method: 'GET', resolved: true },
          { file: 'routes_b.php', routePath: '/api/b/make', method: 'POST', resolved: false },
        ]),
        dir,
        repo,
      );
      expect(parseCalls.some((s) => s.includes('/api/b/make'))).toBe(true); // B scanned
      expect(parseCalls.some((s) => s.includes('/api/a/list'))).toBe(false); // A skipped
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('provider-covered file that ALSO calls out is still parsed (consumer not dropped)', async () => {
    // routes_c.php is a Laravel provider AND a Laravel Http:: consumer.
    const ROUTES_C = `<?php
Route::get('/api/c/list', 'CController@list');
Http::get('/api/inventory');
`;
    const dir = mkRepo({ 'routes_c.php': ROUTES_C });
    try {
      const out = await new HttpRouteExtractor().extract(
        makeDb([{ file: 'routes_c.php', routePath: '/api/c/list', method: 'GET', resolved: true }]),
        dir,
        repo,
      );
      expect(out.some((c) => c.role === 'provider' && c.meta.path === '/api/c/list')).toBe(true);
      // The Http:: consumer lives only in source — it MUST survive because the
      // consumer signal kept the file in the scan set (so it was parsed).
      expect(parseCalls.some((s) => s.includes('/api/inventory'))).toBe(true);
      expect(out.some((c) => c.role === 'consumer' && c.meta.path === '/api/inventory')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Java — `'partial'`, so the P1 group-only shapes must never be dropped ─────

describe('HttpRouteExtractor — Java parse-skip P1 regression guards (#2138)', () => {
  it('array-form @GetMapping({"/a","/b"}) survives a co-located resolved route', async () => {
    const AC = `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class AController {
  @GetMapping("/covered") public Object covered() { return null; }
  @GetMapping({"/a","/b"}) public Object multi() { return null; }
}
`;
    const dir = mkRepo({ 'AController.java': AC });
    try {
      // The mock DB resolves only /covered; it deliberately omits the array-form
      // routes to exercise the source-scan fallback. (Ingestion now DOES emit
      // array-form Route nodes under a scalar/absent class prefix — see #2280 —
      // but this test asserts the group extractor still recovers them via scan
      // when the graph happens to lack them, which is what 'partial' guarantees.)
      const out = await new HttpRouteExtractor().extract(
        makeDb([
          { file: 'AController.java', routePath: '/covered', method: 'GET', resolved: true },
        ]),
        dir,
        repo,
      );
      const paths = providerPaths(out);
      // The array-form routes are absent from this mock graph but survive via source scan.
      expect(paths).toEqual(expect.arrayContaining(['GET::/a', 'GET::/b']));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('same-URL multi-verb (GET+POST /orders) keeps both verbs', async () => {
    const OC = `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class OrderController {
  @GetMapping("/orders") public Object list() { return null; }
  @PostMapping("/orders") public Object make() { return null; }
}
`;
    const dir = mkRepo({ 'OrderController.java': OC });
    try {
      // Ingestion's URL-keyed Route node collapses to one verb; resolve only GET.
      const out = await new HttpRouteExtractor().extract(
        makeDb([
          { file: 'OrderController.java', routePath: '/orders', method: 'GET', resolved: true },
        ]),
        dir,
        repo,
      );
      const paths = providerPaths(out);
      expect(paths).toEqual(expect.arrayContaining(['GET::/orders', 'POST::/orders']));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('interface-inherited Spring route survives on the implementing controller', async () => {
    const IFACE = `package com.example;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/orders")
public interface OrderApi {
  @GetMapping("/{id}") Object get(Long id);
}
`;
    const CTRL = `package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class OrderController implements OrderApi {
  @GetMapping("/direct") public Object direct() { return null; }
  public Object get(Long id) { return null; }
}
`;
    const dir = mkRepo({ 'OrderApi.java': IFACE, 'OrderController.java': CTRL });
    try {
      // Graph resolves only the controller-direct route; the inherited route is
      // composed only by the group scanProject pass.
      const out = await new HttpRouteExtractor().extract(
        makeDb([
          { file: 'OrderController.java', routePath: '/direct', method: 'GET', resolved: true },
        ]),
        dir,
        repo,
      );
      const paths = providerPaths(out);
      expect(paths).toEqual(expect.arrayContaining(['GET::/orders/{param}']));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
