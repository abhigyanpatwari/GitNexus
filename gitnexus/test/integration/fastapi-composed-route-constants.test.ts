/**
 * End-to-end coverage of imported/composed FastAPI route path constants (#2391).
 *
 * `@router.post(API_V1_WIDGETS_GET)` — where the path is an imported constant
 * built by `+`-concatenation in another module — must index as
 * `POST /api/v1/widgets/get` in the ingestion `Route` graph nodes (which drive
 * `route_map` / `api_impact`), NOT as `POST /`. An argument that cannot be folded
 * to a literal is skipped entirely (KTD5 floor), never recorded as `/`.
 *
 * The group HTTP-contract parity, multi-hop chains, the module-collision floor,
 * and the warm-cache guard are added by U5/U6 (see the sibling describe blocks
 * and `http-route-extractor.test.ts`).
 *
 * Fixture: `test/fixtures/fastapi-composed-app/`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';
import { PYTHON_HTTP_PLUGIN } from '../../src/core/group/extractors/http-patterns/python.js';
import {
  loadParseCache,
  saveParseCache,
  PARSE_CACHE_VERSION,
} from '../../src/storage/parse-cache.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fastapi-composed-app');

describe('FastAPI composed route constants — ingestion pipeline (#2391)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  function routes(): { method: string | undefined; url: string }[] {
    const out: { method: string | undefined; url: string }[] = [];
    result.graph.forEachNode((n) => {
      if (n.label !== 'Route') return;
      const method = n.properties.method;
      out.push({
        method: method === undefined ? undefined : String(method),
        url: String(n.properties.name),
      });
    });
    return out;
  }
  const urls = (): string[] =>
    routes()
      .map((r) => r.url)
      .sort();

  it('resolves the imported composed constant to its full path', () => {
    expect(routes()).toContainEqual({ method: 'POST', url: '/api/v1/widgets/get' });
  });

  it('never records a phantom `/` for a non-literal path', () => {
    expect(urls()).not.toContain('/');
  });

  it('leaves an ordinary string-literal sibling route unchanged', () => {
    expect(routes()).toContainEqual({ method: 'GET', url: '/literal/health' });
  });

  it('skips an unresolvable constant argument (no Route node, not `/`)', () => {
    // `@router.delete(UNKNOWN_ROUTE_CONST)` — the constant is defined nowhere, so
    // it folds to null and the route is dropped rather than indexed as `DELETE /`.
    expect(routes().some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('joins an APIRouter(prefix=…) with a resolved composed path', () => {
    // prefixed.py: `router = APIRouter(prefix="/v2")` + `@router.post(COMPOSED)`.
    expect(routes()).toContainEqual({ method: 'POST', url: '/v2/api/v1/widgets/get' });
  });

  it('keeps two composed routes at distinct paths as distinct nodes', () => {
    const composed = routes().filter((r) => r.url.endsWith('/api/v1/widgets/get'));
    expect(composed.map((r) => r.url).sort()).toEqual([
      '/api/v1/widgets/get',
      '/v2/api/v1/widgets/get',
    ]);
  });

  it('resolves a multi-hop import chain (leaf → mid → base) with an inline concat', () => {
    // deep/base.py ROOT=/root → deep/mid.py MID=ROOT+"/mid" → deep/leaf.py
    // @router.get(MID + "/leaf").
    expect(routes()).toContainEqual({ method: 'GET', url: '/root/mid/leaf' });
  });

  it('resolves same-named constants in different packages against their OWN package', () => {
    // pkg_a/constants.py SHARED="/a-shared" and pkg_b/constants.py SHARED="/b-shared",
    // each imported via `from .constants import SHARED`. Never crossed (KTD4).
    expect(routes()).toContainEqual({ method: 'GET', url: '/a-shared' });
    expect(routes()).toContainEqual({ method: 'GET', url: '/b-shared' });
    expect(urls().filter((u) => u.endsWith('-shared'))).toEqual(['/a-shared', '/b-shared']);
  });

  it('snapshots an aliased constant before a later mutation, end-to-end (#2393)', () => {
    // app/snapshot.py: `SNAP = API_V1` (captures "/api/v1") then `API_V1 += "/mutated"`.
    // SNAP's route must be the pre-mutation value, never the mutated one.
    expect(routes()).toContainEqual({ method: 'GET', url: '/api/v1' });
    expect(urls()).not.toContain('/api/v1/mutated');
  });
});

// ─── R4 parity: the group HTTP-contract layer resolves the same paths ─────────

describe('FastAPI composed route constants — ingestion↔group parity (#2391 R4)', () => {
  it('group provider paths match the ingestion Route-node paths for composed routes', async () => {
    const ingestion = await runPipelineFromRepo(FIXTURE, () => {}, {});
    const ingestionUrls = new Set<string>();
    ingestion.graph.forEachNode((n) => {
      if (n.label === 'Route') ingestionUrls.add(String(n.properties.name));
    });

    // Run the group plugin over the same fixture files.
    const files: Record<string, string> = {};
    const walk = (dir: string, rel: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(abs, r);
        else if (entry.name.endsWith('.py')) files[r] = fs.readFileSync(abs, 'utf8');
      }
    };
    walk(FIXTURE, '');
    const parser = new Parser();
    const parseSource = (p: Parser, src: string): Parser.Tree => {
      p.setLanguage(Python);
      return p.parse(src);
    };
    const ctx = PYTHON_HTTP_PLUGIN.prepareRepo?.({
      files: Object.keys(files),
      parser,
      readFile: (r) => files[r] ?? null,
      parseSource,
    });
    const groupPaths = new Set<string>();
    for (const [rel, src] of Object.entries(files)) {
      for (const d of PYTHON_HTTP_PLUGIN.scan(parseSource(parser, src), ctx, rel)) {
        if (d.role === 'provider') groupPaths.add(d.path);
      }
    }

    // Every composed route the ingestion side resolved is also a group provider
    // path, and vice versa — the two subsystems agree (R4), including the
    // multi-hop and per-package-collision cases. (The `/v2` APIRouter(prefix)
    // route is emitted by BOTH sides as well — asserted separately above; the
    // four paths below are this block's shared-parity set.)
    for (const composed of ['/api/v1/widgets/get', '/root/mid/leaf', '/a-shared', '/b-shared']) {
      expect(ingestionUrls.has(composed)).toBe(true);
      expect(groupPaths.has(composed)).toBe(true);
    }
    // Neither side invents a phantom `/` for the unresolvable DELETE route.
    expect(ingestionUrls.has('/')).toBe(false);
    expect(groupPaths.has('/')).toBe(false);
  }, 60_000);
});

// ─── Warm parse-cache: composed routes survive the cache serialization ────────

describe('FastAPI composed route constants — warm parse-cache (#2391 SCHEMA_BUMP)', () => {
  it('re-resolves the composed route on an all-hit warm run after a save/load round-trip', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-composed-warm-'));
    try {
      // Run #1 populates the parse cache.
      const cold = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set<string>(),
      };
      await runPipelineFromRepo(FIXTURE, () => {}, { parseCache: cold });

      // Force the JSON round-trip (mapReplacer/mapReviver) the real warm path uses
      // — this is where the new `moduleConstants` Maps and `routePathExpr` fields
      // must survive, or a warm re-analyze silently drops the composed route.
      await saveParseCache(storageDir, cold);
      const warm = await loadParseCache(storageDir);
      expect(warm).not.toBeNull();

      const result = await runPipelineFromRepo(FIXTURE, () => {}, {
        parseCache: warm ?? undefined,
      });
      const urls = new Set<string>();
      result.graph.forEachNode((n) => {
        if (n.label === 'Route') urls.add(String(n.properties.name));
      });
      expect(urls.has('/api/v1/widgets/get')).toBe(true);
      expect(urls.has('/root/mid/leaf')).toBe(true);
      expect(urls.has('/')).toBe(false);
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  }, 120_000);
});
