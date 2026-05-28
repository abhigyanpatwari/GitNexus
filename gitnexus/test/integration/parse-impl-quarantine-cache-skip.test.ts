/**
 * U20 — Integration regression test for chunk-cache corruption on
 * worker quarantine.
 *
 * Pins the fix for the Codex adversarial review finding on PR #1693
 * (`docs/plans/2026-05-20-002-fix-chunk-cache-corruption-on-worker-quarantine-plan.md`):
 *
 *   The chunk hash is computed from every file in the chunk, but the
 *   worker pool's Layer 3 quarantine filters quarantined files out of
 *   dispatch. Before the fix, the chunk-loop would cache the partial
 *   worker results under the full-coverage chunk hash, locking in
 *   silent corruption that the next analyze would replay.
 *
 * Runs with REAL `worker_threads` + `createWorkerPool`. Injects a
 * custom worker script via `workerUrlForTest` that:
 *   1. Implements the U17/U19 IPC protocol (decode Buffer or hybrid
 *      envelope/contents shape, decode header + JSON payload).
 *   2. Emits a `{type:'ready'}` handshake so the pool's
 *      `waitForWorkerReady` resolves promptly.
 *   3. On a sub-batch containing `poison.ts`, emits a starting-file
 *      and exits with code 134 — deterministic worker death the pool
 *      attributes to `poison.ts` via the in-flight signal, then
 *      adds to its session-scoped quarantine.
 *   4. On a sub-batch without poison, synthesizes a minimal valid
 *      ParseWorkerResult with a Function node per file (no
 *      tree-sitter dependency in the test worker — the synthesized
 *      nodes give the merge step deterministic content to add to the
 *      graph).
 *
 * U20 design pivot — no sequential fallback. The U1 sequential
 * reparse for quarantined chunk files was removed: relying on the
 * worker pool's resilience layers (respawn budget, circuit breaker,
 * quarantine, slot-attribution, cumulative timeout) as the SOLE
 * contract avoids re-triggering tree-sitter native crashes on the
 * main thread and gives operators a clear hard signal when workers
 * exhaust. Quarantined files are missing from this run's graph;
 * they're surfaced in the per-chunk warn log; U2's cache-skip keeps
 * the chunk uncached so the next analyze with a fresh pool retries.
 *
 * Assertions exercised here:
 *   - Worker-path runs and produces results for surviving files
 *     (good_a, good_c) via the synthesized worker output.
 *   - The quarantined file (poison.ts) is NOT in the graph — no
 *     sequential reparse fired.
 *   - U2 (cache-write suppression): `parseCache.entries` does NOT
 *     contain the chunk hash after the run. `parseCache.usedKeys`
 *     DOES contain it (chunk was processed; the cache write was
 *     specifically skipped). A cross-run scenario verifies that a
 *     subsequent dispatch with a fresh pool re-attempts the chunk
 *     (cache miss) and the cache stays empty for that chunk.
 *
 * Why integration over unit:
 *   - The fix lives at the boundary between processParsing
 *     (`parsing-processor.ts`) and the chunk-loop
 *     (`pipeline-phases/parse-impl.ts`) under a real
 *     workerPool. Unit-mocking the worker-pool import bypasses the
 *     structured-clone boundary, the dispatch lifecycle, and the
 *     actual quarantine flow — it verifies the test setup rather
 *     than the contract. The real worker thread executing the test
 *     script through the U17/U19 IPC protocol IS the load-bearing
 *     surface; this test exercises it end-to-end.
 *   - The `writeReadyWorker` pattern from `worker-pool.test.ts` is
 *     reused inline here (the READY_PREAMBLE + test-worker script
 *     composition).
 *
 * Wall-clock budget: well under 5 s under normal CI conditions.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { computeChunkHash, fileContentHash } from '../../src/storage/parse-cache.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

/**
 * Inline READY preamble + IPC decode wrapper (mirrors
 * `test/integration/worker-pool.test.ts`'s READY_PREAMBLE). Lets the
 * test worker script below speak the production U17/U19 IPC protocol
 * without importing dist/protocol.js (the script runs as a standalone
 * CJS file at a temp path, so it can't resolve dist/ via relative
 * paths reliably).
 */
const READY_PREAMBLE = `
const { parentPort: __pp } = require('node:worker_threads');
const __decoder = new TextDecoder('utf-8');
const __decodeFrame = (raw) => {
  if (
    raw && typeof raw === 'object' &&
    raw.type === 'sub-batch' &&
    Array.isArray(raw.files)
  ) {
    return {
      type: 'sub-batch',
      files: raw.files.map((f) => ({
        path: f.path,
        content: typeof f.content === 'string' ? f.content : __decoder.decode(f.content),
      })),
    };
  }
  return raw;
};
const __origOn = __pp.on.bind(__pp);
__pp.on = (event, handler) => {
  if (event !== 'message') return __origOn(event, handler);
  return __origOn(event, (raw) => handler(__decodeFrame(raw)));
};
__pp.postMessage({ type: 'ready' });
`;

/**
 * Test worker script. Synthesizes minimal ParseWorkerResult entries for
 * non-poison files; deterministically crashes on poison.ts via
 * `process.exit(134)`. Accumulates across sub-batches; emits the
 * accumulated result on `flush`.
 */
const TEST_WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads');
const accumulated = {
  nodes: [],
  relationships: [],
  symbols: [],
  imports: [],
  calls: [],
  assignments: [],
  heritage: [],
  routes: [],
  fetchCalls: [],
  fetchWrapperDefs: [],
  decoratorRoutes: [],
  toolDefs: [],
  ormQueries: [],
  constructorBindings: [],
  fileScopeBindings: [],
  parsedFiles: [],
  skippedLanguages: {},
  fileCount: 0,
};
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'sub-batch') {
    const poison = msg.files.find((f) => f.path.endsWith('poison.ts'));
    if (poison) {
      parentPort.postMessage({ type: 'starting-file', path: poison.path });
      process.exit(134);
    }
    for (const file of msg.files) {
      const baseName = file.path.split('/').pop().replace(/\\.ts$/, '');
      accumulated.nodes.push({
        id: 'func:' + file.path,
        label: 'Function',
        properties: {
          name: baseName,
          filePath: file.path,
          startLine: 1,
          endLine: 1,
          language: 'typescript',
          isExported: true,
        },
      });
      accumulated.fileCount++;
    }
    parentPort.postMessage({ type: 'progress', filesProcessed: accumulated.fileCount });
    parentPort.postMessage({ type: 'sub-batch-done' });
    return;
  }
  if (msg && msg.type === 'flush') {
    parentPort.postMessage({ type: 'result', data: accumulated });
  }
});
`;

const FIXTURE_FILES = {
  'src/good_a.ts': 'export function good_a() { return 1; }\n',
  'src/poison.ts': 'export function poison() { return 2; }\n',
  'src/good_c.ts': 'export function good_c() { return 3; }\n',
};

describe('U20: parse-impl quarantine + chunk-cache integration (PR #1693 Codex finding)', () => {
  let tempDir: string;
  let repoDir: string;
  let workerPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'parse-impl-quarantine-cache-skip-'));
    repoDir = path.join(tempDir, 'repo');
    mkdirSync(repoDir, { recursive: true });

    // Write the fixture files to repoDir so filesystem-walker / chunk
    // loop pick them up by relative path.
    for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
      const full = path.join(repoDir, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }

    // Write the test worker script to the same tempDir so it doesn't
    // collide with anything else. The READY preamble + test script
    // share one .js file the pool spawns via `new Worker(URL)`.
    workerPath = path.join(tempDir, 'test-quarantine-worker.js');
    writeFileSync(workerPath, READY_PREAMBLE + TEST_WORKER_SCRIPT);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('worker quarantine leaves poison.ts out of the graph AND suppresses chunk-cache write', async () => {
    const filePaths = Object.keys(FIXTURE_FILES);
    const scanned = filePaths.map((rel) => ({
      path: rel,
      size: statSync(path.join(repoDir, rel)).size,
    }));

    // The chunk hash is computed from EVERY file's content hash. The
    // load-bearing U2 assertion below checks `parseCache.entries.has`
    // against this exact value, so we compute it the same way
    // parse-impl does.
    const expectedChunkHash = computeChunkHash(
      filePaths.map((p) => ({
        filePath: p,
        contentHash: fileContentHash(FIXTURE_FILES[p as keyof typeof FIXTURE_FILES]),
      })),
    );

    const parseCache = {
      version: 'test',
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(),
    };

    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      scanned,
      filePaths,
      filePaths.length,
      repoDir,
      Date.now(),
      () => {},
      {
        skipWorkers: false,
        // Force the worker-pool gate to open on the 3-file fixture.
        workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
        // Inject the custom worker script — the pool will spawn it
        // instead of the production parse-worker.js.
        workerUrlForTest: pathToFileURL(workerPath) as URL,
        // Test-only worker pool size — keep at 1 so the poison-file
        // sub-batch deterministically lands on the only slot (no
        // chance of poison + good landing in different slots).
        workerPoolSize: 1,
        parseCache,
      },
    );

    const nodes = Array.from(graph.nodes.values());

    // Quarantine contract: poison.ts is genuinely missing from the
    // graph for this run. The custom worker crashed on it; no
    // sequential reparse rescued it; the operator sees the per-chunk
    // quarantine warn log. A future analyze with a fresh pool gets
    // another chance via U2's cache-skip below.
    expect(
      nodes.some(
        (n) => n.label === 'Function' && (n.properties as { name?: string }).name === 'poison',
      ),
    ).toBe(false);

    // Surviving files' symbols come from the custom worker's
    // synthesized output via the normal worker-path merge. Pinning
    // them here catches a regression that would drop worker results
    // entirely when quarantine fires.
    expect(
      nodes.some(
        (n) => n.label === 'Function' && (n.properties as { name?: string }).name === 'good_a',
      ),
    ).toBe(true);
    expect(
      nodes.some(
        (n) => n.label === 'Function' && (n.properties as { name?: string }).name === 'good_c',
      ),
    ).toBe(true);

    // U2 assertion: chunk-cache write was suppressed. The chunk hash
    // is in usedKeys (chunk WAS processed) but absent from entries
    // (cache write skipped because of the quarantine intersection).
    // This is the load-bearing cross-run protection: a future analyze
    // with unchanged content will re-derive the same chunkHash, miss
    // the cache, and re-dispatch — giving the file another chance
    // against a fresh-quarantine pool.
    expect(parseCache.entries.has(expectedChunkHash)).toBe(false);
    expect(parseCache.usedKeys.has(expectedChunkHash)).toBe(true);
    expect(parseCache.entries.size).toBe(0);
  });

  it('cross-run: unchanged fixture re-dispatches on a second pass because the cache was empty', async () => {
    // First pass: same setup as the previous test. Cache stays empty
    // because poison.ts triggered quarantine.
    const filePaths = Object.keys(FIXTURE_FILES);
    const scanned = filePaths.map((rel) => ({
      path: rel,
      size: statSync(path.join(repoDir, rel)).size,
    }));
    const expectedChunkHash = computeChunkHash(
      filePaths.map((p) => ({
        filePath: p,
        contentHash: fileContentHash(FIXTURE_FILES[p as keyof typeof FIXTURE_FILES]),
      })),
    );

    const parseCache = {
      version: 'test',
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(),
    };

    // FIRST PASS.
    {
      const graph = createKnowledgeGraph();
      await runChunkedParseAndResolve(
        graph,
        scanned,
        filePaths,
        filePaths.length,
        repoDir,
        Date.now(),
        () => {},
        {
          skipWorkers: false,
          workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
          workerUrlForTest: pathToFileURL(workerPath) as URL,
          workerPoolSize: 1,
          parseCache,
        },
      );
      // Confirm the precondition for the second-pass test: cache is
      // empty for this chunk hash.
      expect(parseCache.entries.has(expectedChunkHash)).toBe(false);
    }

    // SECOND PASS — same content, same parseCache, fresh worker pool
    // (createWorkerPool is called per `runChunkedParseAndResolve`, so
    // every invocation gets a clean quarantine slate). With the cache
    // empty for this chunk, the second pass MUST dispatch the chunk
    // again rather than replaying a cache entry. The custom worker
    // crashes again on poison.ts → quarantine again → cache still
    // skipped. Symptom: cache state unchanged, graph still complete.
    {
      const graph2 = createKnowledgeGraph();
      await runChunkedParseAndResolve(
        graph2,
        scanned,
        filePaths,
        filePaths.length,
        repoDir,
        Date.now(),
        () => {},
        {
          skipWorkers: false,
          workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
          workerUrlForTest: pathToFileURL(workerPath) as URL,
          workerPoolSize: 1,
          parseCache,
        },
      );

      // Cache stayed empty (still no entry for this chunk hash) — the
      // load-bearing cross-run protection.
      expect(parseCache.entries.has(expectedChunkHash)).toBe(false);
      expect(parseCache.usedKeys.has(expectedChunkHash)).toBe(true);
      // Worker path ran again; surviving files in the graph; poison
      // still absent per the U20 contract (workers are the sole
      // resilience layer, no sequential reparse).
      const nodes2 = Array.from(graph2.nodes.values());
      expect(
        nodes2.some(
          (n) => n.label === 'Function' && (n.properties as { name?: string }).name === 'good_a',
        ),
      ).toBe(true);
      expect(
        nodes2.some(
          (n) => n.label === 'Function' && (n.properties as { name?: string }).name === 'poison',
        ),
      ).toBe(false);
    }
  });
});
