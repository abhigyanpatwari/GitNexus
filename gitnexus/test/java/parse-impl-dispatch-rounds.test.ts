import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
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
import {
  emptyParseCache,
  loadParseCache,
  packParseCacheChunks,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import { mergeStagedDurableParsedFileStore } from '../../src/storage/parsedfile-store.js';

const parseIdentity = await runtimeParseIdentity();

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

  const stagingPath = () => fs.mkdtempSync(path.join(storageDir, 'run-'));
  const newCache = () =>
    emptyParseCache(parseIdentity, {
      storagePath: storageDir,
      writeStoragePath: stagingPath(),
    });

  const publishCache = async (cache: ParseCache) => {
    if (!cache.writeStoragePath) throw new Error('Expected a staged cache');
    const saved = await saveParseCache(storageDir, cache);
    await mergeStagedDurableParsedFileStore(
      storageDir,
      cache.writeStoragePath,
      parseIdentity.base,
      new Set(saved),
    );
    return loadParseCache(storageDir, parseIdentity, stagingPath());
  };

  const run = async (parseCache?: ParseCache) => {
    const scan = files();
    const rels = scan.map((f) => f.path);
    const graph = createKnowledgeGraph();
    const metrics = await runChunkedParseAndResolve(
      graph,
      scan,
      rels,
      scan.length,
      repoPath,
      Date.now(),
      () => {},
      parseCache ? { parseCache } : {},
    );
    return { graph, metrics };
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
    const { graph: perChunk } = await run();

    delete process.env.GITNEXUS_PARSE_ROUND_BYTES;
    const { graph: batched } = await run();

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

  it('keeps hit and miss chunks attributed to their own files inside one round', async () => {
    // The realistic incremental shape: some packs warm, some cold, batched into
    // the SAME round. `drainRound` walks the round's entries in `chunkIdx`
    // order but pulls worker output with a separate `missIdx` cursor, so a
    // hit sitting between two misses is exactly where that cursor can slip.
    // Cold-then-warm alone never exercises it -- every entry is the same kind.
    const cache = newCache();

    const { graph: cold } = await run(cache);
    const cachedPacks = (cache.stagedKeys?.size ?? 0) + cache.entries.size;
    expect(cachedPacks).toBeGreaterThan(1);
    const published = await publishCache(cache);

    // Edit ONE file. Its pack now misses; every other pack still hits, so the
    // next run's rounds carry both kinds together.
    fs.writeFileSync(
      path.join(repoPath, 'src/mod0.ts'),
      'export function ts0() { return 999; }\nexport function ts0Extra() { return 1; }\n',
    );

    const { graph: mixed, metrics } = await run(published);
    expect(metrics.parseCacheHitFileCount).toBeGreaterThan(0);
    expect(metrics.reparsedFileCount).toBeGreaterThan(0);

    // The edited file's NEW symbol must be present, proving the miss chunk's
    // fresh worker output landed under its own file...
    const mixedPrint = fingerprint(mixed);
    expect(mixedPrint).toContain('ts0Extra');
    // ...and every untouched file's symbols must still be present and attached
    // to their own paths, proving no hit chunk was overwritten by, or swapped
    // with, a neighbouring miss chunk's results.
    const coldPrint = fingerprint(cold);
    const untouched = coldPrint
      .split('\n')
      .filter((entry) => !entry.endsWith('|src/mod0.ts'))
      .sort();
    const mixedUntouched = mixedPrint
      .split('\n')
      .filter((entry) => !entry.endsWith('|src/mod0.ts'))
      .sort();
    expect(mixedUntouched).toEqual(untouched);
  });

  it('stores each pack’s own worker output, so a warm replay reproduces the cold graph', async () => {
    const cache = newCache();

    // Cold: every pack misses, and the round writes each pack's results under
    // that pack's own hash.
    const { graph: cold } = await run(cache);
    // With a writeStoragePath the chunk bodies land in staging and the hash is
    // tracked in `stagedKeys`; failed writes stay in `entries`. Count both so the
    // assertion pins "more than one pack was cached", not the storage route.
    const cachedPacks = (cache.stagedKeys?.size ?? 0) + cache.entries.size;
    expect(cachedPacks).toBeGreaterThan(1);
    expect(cache.usedKeys.size).toBe(cachedPacks);
    const published = await publishCache(cache);

    // Warm: every pack replays from its cache entry with no worker dispatch.
    // If a round had attributed pack A's results to pack B's key, the replayed
    // graph would differ here even though the cold run looked correct.
    const { graph: warm, metrics } = await run(published);
    expect(metrics.reparsedFileCount).toBe(0);
    expect(metrics.parseCacheHitFileCount).toBe(FIXTURE.length);
    expect(fingerprint(warm)).toBe(fingerprint(cold));
    expect(warm.nodeCount).toBe(cold.nodeCount);
    expect(warm.relationshipCount).toBe(cold.relationshipCount);
  });
});
