import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { runtimeParseIdentity } from '../../../../test/helpers/runtime-parse-identity.js';
import { type ParseCache } from '../../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../../src/storage/parsedfile-store.js';

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
    {
      workerPoolSize: 1,
      parseCache: cache,
      workerUrlForTest: new URL(
        '../../../../dist/core/ingestion/workers/parse-worker.js',
        import.meta.url,
      ),
    },
  );
}

describe('#2980 provider-hook constant harvest — real pipeline (cold + warm)', () => {
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-2980-cold-'));
    storageDir = path.join(repoDir, '.gitnexus');
  });
  afterEach(() => {
    for (const d of [repoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  it(
    'cold run: folds qualified / FQN / concat paths from a non-*Constants class',
    { timeout: 120_000 },
    async () => {
      const identity = await runtimeParseIdentity();
      const files = writeFixture();
      const cache: ParseCache = {
        identity,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storageDir,
        writeStoragePath: storageDir,
        onDiskKeys: new Set(),
      };

      const result = await runPipeline(cache, files);
      assert.equal(result.usedWorkerPool, true);
      const routes = foldedRoutesOf(result);

      // All three non-literal shapes resolve to folded literals. (The class-level
      // @RequestMapping("/users") prefix join happens in the downstream routes
      // phase — at this seam we assert the method-level folded paths.)
      const paths = routes.map((r) => r.path).sort(compareCodeUnits);
      assert.ok(paths.includes('/api/v1/users')); // qualified ref via import
      assert.ok(paths.includes('/api/v1/orders')); // FQN multi-segment chain
      // FQN, wildcard, and concat routes fold to the same literal.
      assert.ok(paths.filter((p) => p === '/api/v1/orders').length >= 3);
      // Skip floor: no phantom empty/raw-expr paths.
      for (const p of paths) {
        assert.ok(p.length > 1);
        assert.ok(!p.includes('ApiPaths'));
        assert.ok(!p.includes('com.example'));
      }
    },
  );

  it(
    'warm run: parse-cache replay yields the identical folded route set',
    { timeout: 120_000 },
    async () => {
      const identity = await runtimeParseIdentity();
      const files = writeFixture();
      const cache: ParseCache = {
        identity,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storageDir,
        writeStoragePath: storageDir,
        onDiskKeys: new Set(),
      };

      // Run #1 populates the cache; persist it like run-analyze does — BOTH the
      // chunk shards and the durable ParsedFile store. `slimParseWorkerResultsForCache`
      // blanks `parsedFiles` before writing a shard, so a warm run without the
      // durable store cannot replay the chunk and silently falls back to the
      // workers — which is what this test used to do while still passing.
      const run1 = await runPipeline(cache, files);
      const { saveParseCache, pruneCache } = await import('../../../../src/storage/parse-cache.js');
      pruneCache(cache, cache.usedKeys);
      const savedKeys = await saveParseCache(storageDir, cache);
      assert.ok(savedKeys.length > 0);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storageDir),
        identity.base,
        new Set(savedKeys),
      );

      // Run #2 — warm: every chunk is a cache HIT, no worker spawn, the cached
      // ParseWorkerResult (moduleConstants included) is replayed from disk.
      const { loadParseCache } = await import('../../../../src/storage/parse-cache.js');
      const warm = await loadParseCache(storageDir, identity, storageDir);
      assert.deepEqual(warm.onDiskKeys, new Set(savedKeys));
      const run2 = await runPipeline(warm, files);

      const cold = foldedRoutesOf(run1)
        .map((r) => `${r.method} ${r.path}`)
        .sort(compareCodeUnits);
      const hot = foldedRoutesOf(run2)
        .map((r) => `${r.method} ${r.path}`)
        .sort(compareCodeUnits);
      assert.deepEqual(hot, cold);
      assert.ok(hot.length > 0);
      // Without this the test proves nothing about the cache: `loadParseCache`
      // returns an EMPTY cache on any failure (missing file, corrupt JSON,
      // version mismatch) and never throws, so a broken Map round-trip through
      // mapReplacer/mapReviver — the exact regression this test exists for —
      // would silently reparse through the workers and produce the same routes.
      assert.equal(run1.usedWorkerPool, true);
      assert.equal(run2.usedWorkerPool, false);
    },
  );
});
