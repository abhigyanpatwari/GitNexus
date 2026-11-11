import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
/** Real worker quarantine must exclude the failed file from cache while keeping
 * complete neighbours reusable. A fresh pool must retry the failed file. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { computeChunkHash, fileContentHash } from '../../src/storage/parse-cache.js';
import type { ParseCache } from '../../src/storage/parse-cache.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

import { writeFileResultWorker } from '../helpers/file-result-worker.js';

const parseIdentity = await runtimeParseIdentity();

const FIXTURE_FILES = {
  'src/good_a.ts': 'export function good_a() { return 1; }\n',
  'src/poison.ts': 'export function poison() { return 2; }\n',
  'src/good_c.ts': 'export function good_c() { return 3; }\n',
};

const POISON_PATH = 'src/poison.ts';
const hashFiles = (
  scanned: { path: string; size: number }[],
): { poison: string; others: string[] } => {
  const key = (p: string) =>
    computeChunkHash(
      [
        {
          filePath: p,
          contentHash: fileContentHash(FIXTURE_FILES[p as keyof typeof FIXTURE_FILES]),
        },
      ],
      parseIdentity,
    );
  return {
    poison: key(POISON_PATH),
    others: scanned.filter((f) => f.path !== POISON_PATH).map((f) => key(f.path)),
  };
};

describe('U20: parse-impl quarantine + file-cache integration (PR #1693 Codex finding)', () => {
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
    writeFileResultWorker(workerPath, path.join(tempDir, 'spawned'), { crashPaths: [POISON_PATH] });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('worker quarantine leaves poison.ts out of the graph AND suppresses file-cache write', async () => {
    const filePaths = Object.keys(FIXTURE_FILES);
    const scanned = filePaths.map((rel) => ({
      path: rel,
      size: statSync(path.join(repoDir, rel)).size,
    }));

    const expectedFileKey = hashFiles(scanned).poison;

    const parseCache: ParseCache = {
      identity: parseIdentity,
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

    // U2 assertion: file-cache write was suppressed. The file key
    // is in usedKeys (chunk WAS processed) but absent from entries
    // (cache write skipped because of the quarantine intersection).
    // This is the load-bearing cross-run protection: a future analyze
    // with unchanged content will re-derive the same fileKey, miss
    // the cache, and re-dispatch — giving the file another chance
    // against a fresh-quarantine pool.
    expect(parseCache.fileResults?.memory.has(expectedFileKey)).toBe(false);
    expect(parseCache.usedKeys.has(expectedFileKey)).toBe(true);
    // #3204: `usedKeys` alone would let `saveParseCache` copy a pre-existing
    // shard forward, so the skipped chunk is also retired from the save.
    expect(parseCache.staleKeys?.has(expectedFileKey)).toBe(true);
    for (const hash of hashFiles(scanned).others) {
      expect(parseCache.fileResults?.memory.has(hash)).toBe(true);
    }
  });

  it('cross-run: unchanged fixture re-dispatches the poison file because that pack was not cached', async () => {
    // First pass: same setup as the previous test. The poison file is not
    // cached; other packs may be.
    const filePaths = Object.keys(FIXTURE_FILES);
    const scanned = filePaths.map((rel) => ({
      path: rel,
      size: statSync(path.join(repoDir, rel)).size,
    }));
    const expectedFileKey = hashFiles(scanned).poison;

    const parseCache: ParseCache = {
      identity: parseIdentity,
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
          workerUrlForTest: pathToFileURL(workerPath) as URL,
          workerPoolSize: 1,
          parseCache,
        },
      );
      // Confirm the precondition for the second-pass test: cache is
      // empty for this file key.
      expect(parseCache.fileResults?.memory.has(expectedFileKey)).toBe(false);
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
          workerUrlForTest: pathToFileURL(workerPath) as URL,
          workerPoolSize: 1,
          parseCache,
        },
      );

      // Cache stayed empty (still no entry for this file key) — the
      // load-bearing cross-run protection.
      expect(parseCache.fileResults?.memory.has(expectedFileKey)).toBe(false);
      expect(parseCache.usedKeys.has(expectedFileKey)).toBe(true);
      for (const hash of hashFiles(scanned).others) {
        expect(parseCache.fileResults?.memory.has(hash)).toBe(true);
      }
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
