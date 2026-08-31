/**
 * #2980 review round-2: COLD and WARM pipeline e2e for the provider-hook
 * constant harvest (`extractModuleConstants` / `moduleConstantHeuristic` /
 * `foldRoutePathOperands`).
 *
 * The maintainer's blocking finding: unit tests only exercised worker-gated
 * helpers — never the REAL pipeline. A controller referencing constants from
 * a class NOT named `*Constants` (e.g. `ApiPaths`) was silently dropped:
 * the old content gate `/import ... [\\w.]*Constants/` never matched, the
 * constants file never entered the import map, the route resolved to null and
 * got skipped.
 *
 * This file drives the REAL `runChunkedParseAndResolve` with the REAL compiled
 * dist worker (vitest auto-falls back to dist/core/ingestion/workers/
 * parse-worker.js) over a fixture repo shaped like the reviewer's example:
 *
 *   repo/
 *     src/main/java/com/example/ApiPaths.java     — constants class NOT named
 *                                                    *Constants (the High bug)
 *     src/main/java/com/example/UserController.java — @RequestMapping prefix +
 *                                                    @PostMapping(ApiPaths.X) +
 *                                                    FQN form + concat over a
 *                                                    named static import +
 *                                                    wildcard static import
 *
 * Assertions (both runs):
 *  - the emitted Route node carries the FOLDED literal path, not the expr;
 *  - ALL THREE non-literal shapes survive (qualified, FQN-qualified, concat);
 *  - a phantom `POST ` / empty path never appears (skip floor);
 *  - the warm run yields the IDENTICAL route set AND is a genuine replay
 *    (`usedWorkerPool === false`) — the harvest result survives the
 *    structured-clone cache round trip (ModuleConstants uses Map, exercised
 *    through mapReplacer/mapReviver). Asserting the route set alone would pass
 *    on a cache MISS that silently reparsed.
 *
 * Rebuild gate: this test requires dist/ to be current; when dist/ is stale
 * (older than src/) it self-skips with a loud message rather than silently
 * asserting against the old binary. (CI builds before vitest, so it runs.)
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { PARSE_CACHE_VERSION, type ParseCache } from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';

// ── dist freshness gate ───────────────────────────────────────────────────
// The worker is one emitted file among many: TypeScript emits every module in
// this feature separately, so comparing dist/parse-worker.js against
// src/parse-worker.ts alone passes while the resolver, the Spring extractor or
// the provider behind it are stale — and the test then asserts against the
// PREVIOUS build's harvest. Gate on the newest mtime across every source this
// pipeline actually loads.
const repoRoot = path.resolve(__dirname, '..', '..');
const distWorker = path.join(repoRoot, 'dist', 'core', 'ingestion', 'workers', 'parse-worker.js');
const GATED_SOURCES = [
  'core/ingestion/workers/parse-worker.ts',
  'core/ingestion/route-extractors/java-const-resolver.ts',
  'core/ingestion/route-extractors/constant-resolver.ts',
  'core/ingestion/route-extractors/spring.ts',
  'core/ingestion/languages/java.ts',
  'core/ingestion/languages/python.ts',
  'core/ingestion/language-provider.ts',
  'core/ingestion/pipeline-phases/parse-impl.ts',
];
const newestSourceMs = Math.max(
  ...GATED_SOURCES.map((rel) => fs.statSync(path.join(repoRoot, 'src', rel)).mtimeMs),
);
const distStale = !fs.existsSync(distWorker) || fs.statSync(distWorker).mtimeMs < newestSourceMs;

if (distStale) {
  // `describe.skip` prints only vitest's ordinary skip marker, so without this
  // the docblock's promised "loud message" did not exist and a stale/absent
  // dist/ looked like a passing run.
  console.warn(
    '[#2980 e2e] SKIPPED: dist/ is missing or older than src/ — run `npm run build` to exercise the real pipeline.',
  );
}

const maybeDescribe = distStale ? describe.skip : describe;

// ── fixture repo (reviewer's exact High-finding shape) ────────────────────
const API_PATHS = `package com.example.common;

public class ApiPaths {
    public static final String USERS = "/api/v1/users";
    public static final String ORDERS = "/api/v1/orders";
    public static final String V1 = "/api/v1";
}
`;

const USER_CONTROLLER = `package com.example;

import com.example.common.ApiPaths;
import static com.example.common.ApiPaths.V1;
import static com.example.common.ApiPaths.*;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;

@RequestMapping("/users")
public class UserController {

    // Qualified ref via a class NOT named *Constants (High finding): the old
    // gate dropped the whole route because ApiPaths fails the name pattern.
    @PostMapping(ApiPaths.USERS)
    public void create() {}

    // FQN-qualified form (F3): multi-segment field_access chain.
    @GetMapping(com.example.common.ApiPaths.ORDERS)
    public void list() {}

    // Bare ref materialized by the provider's repo-wide wildcard prep hook.
    @GetMapping(ORDERS)
    public void listViaWildcard() {}

    // Inline concat with a STATIC-IMPORTED bare ref — the shape this fixture
    // used to only claim: it spelled the operand as the full FQN chain, which
    // just re-tested the FQN branch above, so bare-name resolution through the
    // import table had no coverage anywhere in the suite.
    @PostMapping(V1 + "/orders")
    public void createOrders() {}
}
`;

let repoDir: string;
let storageDir: string;

function writeFixture(): { path: string; size: number }[] {
  const files: [string, string][] = [
    ['src/main/java/com/example/common/ApiPaths.java', API_PATHS],
    ['src/main/java/com/example/UserController.java', USER_CONTROLLER],
  ];
  const out: { path: string; size: number }[] = [];
  for (const [rel, content] of files) {
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    out.push({ path: rel, size: Buffer.byteLength(content) });
  }
  return out;
}

/**
 * The parse phase does not emit Route nodes itself — it returns the folded
 * `decoratorRoutes` (the routes phase emits them downstream). Asserting on the
 * folded paths at THIS seam is exactly the regression the maintainer asked
 * for: the worker's harvest → provider heuristic → parse-impl fold, with the
 * real dist worker.
 */
type PipelineResult = Awaited<ReturnType<typeof runChunkedParseAndResolve>>;

function foldedRoutesOf(result: PipelineResult): Array<{ path: string; method: string }> {
  return (result.allDecoratorRoutes ?? [])
    .filter((r) => typeof r.routePath === 'string')
    .map((r) => ({ path: r.routePath, method: r.httpMethod }));
}

async function runPipeline(
  cache: ParseCache,
  files: { path: string; size: number }[],
): Promise<PipelineResult> {
  const kg = createKnowledgeGraph();
  return await runChunkedParseAndResolve(
    kg,
    files,
    files.map((f) => f.path),
    files.length,
    repoDir,
    Date.now(),
    () => {},
    { workerPoolSize: 1, parseCache: cache },
  );
}

maybeDescribe('#2980 provider-hook constant harvest — real pipeline (cold + warm)', () => {
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-2980-cold-'));
    storageDir = path.join(repoDir, '.gitnexus');
  });
  afterEach(() => {
    for (const d of [repoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('cold run: folds qualified / FQN / concat paths from a non-*Constants class', async () => {
    const files = writeFixture();
    const cache: ParseCache = {
      version: PARSE_CACHE_VERSION,
      entries: new Map(),
      usedKeys: new Set(),
      storagePath: storageDir,
      onDiskKeys: new Set(),
    };

    const result = await runPipeline(cache, files);
    expect(result.usedWorkerPool).toBe(true);
    const routes = foldedRoutesOf(result);

    // All three non-literal shapes resolve to folded literals. (The class-level
    // @RequestMapping("/users") prefix join happens in the downstream routes
    // phase — at this seam we assert the method-level folded paths.)
    const paths = routes.map((r) => r.path).sort();
    expect(paths).toContain('/api/v1/users'); // qualified ref via import
    expect(paths).toContain('/api/v1/orders'); // FQN multi-segment chain
    // FQN, wildcard, and concat routes fold to the same literal.
    expect(paths.filter((p) => p === '/api/v1/orders').length).toBeGreaterThanOrEqual(3);
    // Skip floor: no phantom empty/raw-expr paths.
    for (const p of paths) {
      expect(p.length).toBeGreaterThan(1);
      expect(p).not.toContain('ApiPaths');
      expect(p).not.toContain('com.example');
    }
  }, 120_000);

  it('warm run: parse-cache replay yields the identical folded route set', async () => {
    const files = writeFixture();
    const cache: ParseCache = {
      version: PARSE_CACHE_VERSION,
      entries: new Map(),
      usedKeys: new Set(),
      storagePath: storageDir,
      onDiskKeys: new Set(),
    };

    // Run #1 populates the cache; persist it like run-analyze does — BOTH the
    // chunk shards and the durable ParsedFile store. `slimParseWorkerResultsForCache`
    // blanks `parsedFiles` before writing a shard, so a warm run without the
    // durable store cannot replay the chunk and silently falls back to the
    // workers — which is what this test used to do while still passing.
    const run1 = await runPipeline(cache, files);
    const { saveParseCache, pruneCache } = await import('../../src/storage/parse-cache.js');
    pruneCache(cache, cache.usedKeys);
    const savedKeys = await saveParseCache(storageDir, cache);
    expect(savedKeys.length).toBeGreaterThan(0);
    await pruneAndSaveDurableParsedFileStore(
      getDurableParsedFileDir(storageDir),
      PARSE_CACHE_VERSION,
      new Set(savedKeys),
    );

    // Run #2 — warm: every chunk is a cache HIT, no worker spawn, the cached
    // ParseWorkerResult (moduleConstants included) is replayed from disk.
    const { loadParseCache } = await import('../../src/storage/parse-cache.js');
    const warm = await loadParseCache(storageDir);
    expect(warm.onDiskKeys).toEqual(new Set(savedKeys));
    const run2 = await runPipeline(warm, files);

    const cold = foldedRoutesOf(run1)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const hot = foldedRoutesOf(run2)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(hot).toEqual(cold);
    expect(hot.length).toBeGreaterThan(0);
    // Without this the test proves nothing about the cache: `loadParseCache`
    // returns an EMPTY cache on any failure (missing file, corrupt JSON,
    // version mismatch) and never throws, so a broken Map round-trip through
    // mapReplacer/mapReviver — the exact regression this test exists for —
    // would silently reparse through the workers and produce the same routes.
    expect(run1.usedWorkerPool).toBe(true);
    expect(run2.usedWorkerPool).toBe(false);
  }, 120_000);
});
