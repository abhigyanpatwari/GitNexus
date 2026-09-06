/**
 * Dispatch rounds — batching cache packs into one pool round.
 *
 * `WorkerPool.dispatch` is a barrier, so one round-trip per parse-cache pack
 * strands the pool whenever a pack is smaller than it. Packs are keyed by
 * `(language, hash(path) % 128)`, so on a real repo most of them are: this
 * repository produces 1285 packs where the byte budget alone needs 16, and 549
 * of those hold a single file. Chunks now accumulate into a round bounded by
 * `GITNEXUS_PARSE_ROUND_BYTES` and go out in one `dispatchGroups` call.
 *
 * Batching must be invisible to the graph. These tests pin the two ways it
 * could stop being invisible:
 *  1. Ordering — deferred aggregation runs in `chunkIdx` order, so the graph
 *     must not depend on how chunks were grouped into rounds.
 *  2. Attribution — a round returns one result array per pack, so a pack's
 *     parse-cache entry must hold ITS OWN worker output. Mis-attribution would
 *     survive a cold run and only surface as a corrupted warm replay, which is
 *     what the second test exercises.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { PARSE_CACHE_VERSION, packParseCacheChunks } from '../../src/storage/parse-cache.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

const ORIGINAL_ROUND_BYTES = process.env.GITNEXUS_PARSE_ROUND_BYTES;

/**
 * Enough files, across enough languages, that `(language, bucket)` packing
 * yields many more packs than the byte budget would — the shape that makes
 * per-pack dispatch a barrier problem in the first place.
 */
const FIXTURE: ReadonlyArray<[string, string]> = [
  ...Array.from({ length: 12 }, (_, i): [string, string] => [
    `src/mod${i}.ts`,
    `export function ts${i}() { return ${i}; }\n`,
  ]),
  ...Array.from({ length: 8 }, (_, i): [string, string] => [
    `src/mod${i}.py`,
    `def py${i}():\n    return ${i}\n`,
  ]),
  ...Array.from({ length: 6 }, (_, i): [string, string] => [
    `src/Mod${i}.java`,
    `public class Mod${i} { public int go() { return ${i}; } }\n`,
  ]),
  ...Array.from({ length: 6 }, (_, i): [string, string] => [
    `src/mod${i}.go`,
    `package main\n\nfunc Go${i}() int { return ${i} }\n`,
  ]),
];

describe('parse-impl dispatch rounds', () => {
  let repoPath = '';
  let storageDir = '';

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-dispatch-rounds-'));
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-rounds-storage-'));
    for (const [rel, content] of FIXTURE) {
      const full = path.join(repoPath, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  });

  afterEach(() => {
    for (const dir of [repoPath, storageDir]) {
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    if (ORIGINAL_ROUND_BYTES === undefined) delete process.env.GITNEXUS_PARSE_ROUND_BYTES;
    else process.env.GITNEXUS_PARSE_ROUND_BYTES = ORIGINAL_ROUND_BYTES;
  });

  const files = () =>
    FIXTURE.map(([rel]) => ({ path: rel, size: fs.statSync(path.join(repoPath, rel)).size }));

  /**
   * Order-independent fingerprint of the graph. Counts alone would let a
   * mis-attributed chunk (right totals, wrong contents) pass.
   */
  const fingerprint = (graph: ReturnType<typeof createKnowledgeGraph>): string =>
    Array.from(graph.nodes.values())
      .map((node) => {
        const props = node.properties as { name?: string; filePath?: string } | undefined;
        return `${node.label}|${props?.name ?? ''}|${props?.filePath ?? ''}`;
      })
      .sort()
      .join('\n');

  const run = async (parseCache?: {
    version: string;
    entries: Map<string, ParseWorkerResult[]>;
    usedKeys: Set<string>;
    storagePath: string;
    onDiskKeys: Set<string>;
  }) => {
    const scan = files();
    const rels = scan.map((f) => f.path);
    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      scan,
      rels,
      scan.length,
      repoPath,
      Date.now(),
      () => {},
      parseCache ? { parseCache } : {},
    );
    return graph;
  };

  it('the fixture really does split into more packs than the byte budget needs', () => {
    // Guards the premise: if packing ever stopped over-splitting, the tests
    // below would still pass while measuring nothing.
    const packs = packParseCacheChunks(
      files().map((f) => ({
        path: f.path,
        size: f.size,
        language: f.path.slice(f.path.lastIndexOf('.') + 1),
      })),
      2 * 1024 * 1024,
    );
    const totalBytes = files().reduce((sum, f) => sum + f.size, 0);
    expect(totalBytes).toBeLessThan(2 * 1024 * 1024);
    expect(packs.length).toBeGreaterThan(1);
  });

  it('produces the same graph whether chunks are batched into rounds or dispatched one by one', async () => {
    // 1 byte closes a round after every cache-missing chunk — the pre-round
    // behaviour, and the control arm for the batched default.
    process.env.GITNEXUS_PARSE_ROUND_BYTES = '1';
    const perChunk = await run();

    delete process.env.GITNEXUS_PARSE_ROUND_BYTES;
    const batched = await run();

    expect(batched.nodeCount).toBe(perChunk.nodeCount);
    expect(batched.relationshipCount).toBe(perChunk.relationshipCount);
    expect(fingerprint(batched)).toBe(fingerprint(perChunk));
    // Pin real symbols so an empty-graph regression cannot satisfy the above.
    const names = fingerprint(batched);
    expect(names).toContain('ts0');
    expect(names).toContain('py0');
    expect(names).toContain('Mod0');
    expect(names).toContain('Go0');
  });

  it('stores each pack’s own worker output, so a warm replay reproduces the cold graph', async () => {
    const cache = {
      version: PARSE_CACHE_VERSION,
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(),
      storagePath: storageDir,
      onDiskKeys: new Set<string>(),
    };

    // Cold: every pack misses, and the round writes each pack's results under
    // that pack's own hash.
    const cold = await run(cache);
    // With a storagePath the chunk bodies land on disk and the hash is tracked
    // in `onDiskKeys`; without one they stay in `entries`. Count both so the
    // assertion pins "more than one pack was cached", not the storage route.
    expect(cache.onDiskKeys.size + cache.entries.size).toBeGreaterThan(1);
    expect(cache.usedKeys.size).toBe(cache.onDiskKeys.size + cache.entries.size);

    // Warm: every pack replays from its cache entry with no worker dispatch.
    // If a round had attributed pack A's results to pack B's key, the replayed
    // graph would differ here even though the cold run looked correct.
    const warm = await run(cache);
    expect(fingerprint(warm)).toBe(fingerprint(cold));
    expect(warm.nodeCount).toBe(cold.nodeCount);
    expect(warm.relationshipCount).toBe(cold.relationshipCount);
  });
});
