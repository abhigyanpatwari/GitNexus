/**
 * Regression coverage for the warm-cache ParsedFile gap (#2038, abhigyanpatwari
 * review on parse-cache.ts).
 *
 * #1983 made the parse worker the sole parser: it serializes ParsedFiles to a
 * disk store that scope-resolution streams back, so the main thread NEVER
 * re-parses (the unbounded tree-sitter 0.21.1 native leak → OOM on huge repos).
 * The gap: on a WARM re-analyze where every chunk is a parse-cache HIT, no
 * worker runs, the run-scoped store is cleared at parse start, and the cached
 * `ParseWorkerResult` carries no ParsedFiles — so scope-resolution would find an
 * empty store and fall back to main-thread `extractParsedFile`, re-opening the
 * OOM.
 *
 * The fix now stores independent facts and scope sections in packed file results;
 * a warm hit snapshots those packs
 * into the run-scoped store so scope-resolution streams
 * them exactly as on a cold run — zero re-parse, byte-identical.
 *
 * Two layers of coverage:
 *  (1) Store-level — the durable persist → `loadParsedFilesForPaths`
 *      round-trip at the EXACT seam scope-resolution consumes (phase.ts:255),
 *      plus the index version gate and the prune-coherence rule. Build-free.
 *  (2) Integration — a two-run `runChunkedParseAndResolve`: run #1 (all miss)
 *      populates the durable store; run #2 (all hits) spawns NO worker and
 *      loads full coverage from durable shards; the coherence gate re-dispatches
 *      when durable shards are absent; and a mixed-mode run (one file changed)
 *      hits the unchanged chunk while re-parsing the changed one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const persistOverride = vi.hoisted(() => ({
  impl: undefined as undefined | (() => Promise<boolean>),
}));
const pinOverride = vi.hoisted(() => ({ fail: false }));
vi.mock('../../src/storage/file-result-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/storage/file-result-store.js')>();
  return {
    ...real,
    pinFileResults: (...args: Parameters<typeof real.pinFileResults>) =>
      pinOverride.fail ? Promise.reject(new Error('pin failed')) : real.pinFileResults(...args),
  };
});
vi.mock('../../src/storage/parsedfile-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/storage/parsedfile-store.js')>();
  return {
    ...real,
    persistParsedFileChunk: (
      storagePath: string,
      shardId: string,
      parsedFiles: readonly ParsedFile[],
    ) =>
      persistOverride.impl
        ? persistOverride.impl()
        : real.persistParsedFileChunk(storagePath, shardId, parsedFiles),
  };
});

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import {
  computeChunkHash,
  fileContentHash,
  emptyParseCache,
  loadParseCache,
  saveParseCache,
  loadParseCacheFiles,
  persistParseCacheFiles,
  flushFileParseCache,
  markParseCacheChunkStale,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  prepareDurableParsedFileChunk,
  persistDurableParsedFileShardSync,
  durableChunkHasShards,
  loadParsedFilesForPaths,
  loadDurableParsedFileIndex,
  pruneAndSaveDurableParsedFileStore,
  clearParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import { TEST_PARSE_IDENTITY } from '../helpers/cache-identity.js';
import { encodeFileResultSection } from '../../src/storage/file-result-codec.js';
import { writeFileResultWorker } from '../helpers/file-result-worker.js';
import type { ParseCache } from '../../src/storage/parse-cache.js';
import type { ParsedFile } from 'gitnexus-shared';

// A structurally-minimal ParsedFile. `loadParsedFilesForPaths` keys on
// `filePath`; the rest are empty so a restored shard is byte-stable and
// scope-resolution has nothing to resolve (no edges) but no malformed input.
const mkParsedFile = (filePath: string): ParsedFile =>
  ({
    filePath,
    moduleScope: '',
    scopes: [],
    parsedImports: [],
    localDefs: [],
    referenceSites: [],
  }) as unknown as ParsedFile;

// ─── Layer 1: durable store mechanics (build-free) ──────────────────────────

describe('durable ParsedFile store — content-addressed warm-cache coverage', () => {
  let tempDir = '';
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-parsedfile-store-'));
  });
  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persist → loadParsedFilesForPaths gives full coverage (the warm seam)', async () => {
    const durableDir = getDurableParsedFileDir(tempDir);
    const chunkHash = 'a'.repeat(64);
    const files = ['src/a.ts', 'src/b.ts'];

    // A worker would write this at flush on a cache MISS.
    persistDurableParsedFileShardSync(durableDir, chunkHash, 7, 0, files.map(mkParsedFile));
    await clearParsedFileStore(tempDir);
    const wanted = new Set(files);
    expect(await durableChunkHasShards(tempDir, chunkHash, wanted)).toBe(true);
    const loaded = await loadParsedFilesForPaths(tempDir, wanted);
    expect([...loaded.keys()].sort()).toEqual([...files].sort());
  });

  it('durableChunkHasShards is false when the chunk has no durable shards', async () => {
    expect(await durableChunkHasShards(tempDir, 'b'.repeat(64), new Set(['missing.ts']))).toBe(
      false,
    );
  });

  it('prepares a fresh durable generation without retaining old worker shards', async () => {
    const durableDir = getDurableParsedFileDir(tempDir);
    const chunkHash = 'f'.repeat(64);
    const chunkDir = path.join(durableDir, chunkHash);

    persistDurableParsedFileShardSync(durableDir, chunkHash, 1, 0, [mkParsedFile('old.ts')]);
    await prepareDurableParsedFileChunk(durableDir, chunkHash);
    persistDurableParsedFileShardSync(durableDir, chunkHash, 1, 0, [mkParsedFile('new-a.ts')]);
    persistDurableParsedFileShardSync(durableDir, chunkHash, 2, 0, [mkParsedFile('new-b.ts')]);

    const shards = fs
      .readdirSync(chunkDir)
      .filter((name) => name.endsWith('.v8'))
      .sort();
    expect(shards).toEqual([`${chunkHash}-w1-0.v8`, `${chunkHash}-w2-0.v8`]);
    const wanted = new Set(['old.ts', 'new-a.ts', 'new-b.ts']);
    expect(await durableChunkHasShards(tempDir, chunkHash, new Set(['new-a.ts', 'new-b.ts']))).toBe(
      true,
    );
    const files = await loadParsedFilesForPaths(tempDir, wanted);
    expect([...files.keys()].sort()).toEqual(['new-a.ts', 'new-b.ts']);
  });

  it('index load is gated by the base identity', async () => {
    const durableDir = getDurableParsedFileDir(tempDir);
    const chunkHash = 'c'.repeat(64);
    persistDurableParsedFileShardSync(durableDir, chunkHash, 1, 0, [mkParsedFile('x.ts')]);
    await pruneAndSaveDurableParsedFileStore(
      durableDir,
      TEST_PARSE_IDENTITY.base,
      new Set([chunkHash]),
    );

    expect(await loadDurableParsedFileIndex(durableDir, TEST_PARSE_IDENTITY.base)).toEqual(
      new Map([[chunkHash, new Set(['x.ts'])]]),
    );
    // A different base identity invalidates the whole durable store.
    expect(await loadDurableParsedFileIndex(durableDir, '999+9.9.9')).toEqual(new Map());
  });

  it('prune keeps only keepKeys subdirs with ≥1 shard, drops the rest, and re-indexes', async () => {
    const durableDir = getDurableParsedFileDir(tempDir);
    const keep = 'd'.repeat(64);
    const drop = 'e'.repeat(64); // present on disk but NOT in keepKeys (e.g. quarantined / stale)
    persistDurableParsedFileShardSync(durableDir, keep, 1, 0, [mkParsedFile('keep.ts')]);
    persistDurableParsedFileShardSync(durableDir, drop, 1, 0, [mkParsedFile('drop.ts')]);

    await pruneAndSaveDurableParsedFileStore(durableDir, TEST_PARSE_IDENTITY.base, new Set([keep]));

    expect(fs.existsSync(path.join(durableDir, keep))).toBe(true);
    expect(fs.existsSync(path.join(durableDir, drop))).toBe(false);
    expect(await loadDurableParsedFileIndex(durableDir, TEST_PARSE_IDENTITY.base)).toEqual(
      new Map([[keep, new Set(['keep.ts'])]]),
    );
  });
});

// ─── Packed-file pipeline coverage at the scope-resolution loading seam ───
describe('parse-impl warm-cache ParsedFile coverage', () => {
  let tempDir = '',
    repoDir = '',
    storageDir = '',
    workerPath = '',
    markerPath = '';
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-file-coverage-'));
    repoDir = path.join(tempDir, 'repo');
    storageDir = path.join(tempDir, 'storage');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(storageDir);
    workerPath = path.join(tempDir, 'worker.cjs');
    markerPath = path.join(tempDir, 'spawned');
    writeFileResultWorker(workerPath, markerPath);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    persistOverride.impl = undefined;
    pinOverride.fail = false;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const writeFile = (rel: string, source = 'export const value = 1;') => {
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
    return { path: rel, size: Buffer.byteLength(source) };
  };
  const stage = () => fs.mkdtempSync(path.join(tempDir, 'stage-'));
  const newCache = () =>
    emptyParseCache(TEST_PARSE_IDENTITY, { storagePath: storageDir, writeStoragePath: stage() });
  const warmCache = () => loadParseCache(storageDir, TEST_PARSE_IDENTITY, stage());
  const keyOf = (file: { path: string }) =>
    computeChunkHash(
      [
        {
          filePath: file.path,
          contentHash: fileContentHash(fs.readFileSync(path.join(repoDir, file.path))),
        },
      ],
      TEST_PARSE_IDENTITY,
    );
  const run = (cache: ParseCache, files: { path: string; size: number }[]) =>
    runChunkedParseAndResolve(
      createKnowledgeGraph(),
      files,
      files.map((f) => f.path),
      files.length,
      repoDir,
      Date.now(),
      () => {},
      { workerUrlForTest: pathToFileURL(workerPath), workerPoolSize: 1, parseCache: cache },
    );
  const persist = (cache: ParseCache) => saveParseCache(storageDir, cache);
  it.each(['fresh', 'hit'])(
    'keeps scopes available when pinning a %s record fails',
    async (kind) => {
      const file = writeFile('pin.ts');
      let cache = newCache();
      if (kind === 'hit') {
        await run(cache, [file]);
        await persist(cache);
        cache = await warmCache();
      }
      pinOverride.fail = true;
      const result = await run(cache, [file]);
      expect(result.reparsedFileCount).toBe(1);
      expect((await coverage(cache, [file.path])).has(file.path)).toBe(true);
    },
  );
  it.skipIf(process.platform === 'win32')(
    'uses raw fixture results when the codec rejects a filename',
    async () => {
      const file = writeFile('raw\nfile.ts');
      const cache = newCache();
      const result = await run(cache, [file]);
      expect(result.reparsedFileCount).toBe(1);
      expect(cache.staleKeys?.has(keyOf(file))).toBe(true);
      expect((await coverage(cache, [file.path])).has(file.path)).toBe(true);
    },
  );
  const coverage = (cache: ParseCache, paths: string[]) =>
    loadParsedFilesForPaths(cache.writeStoragePath!, new Set(paths));
  const corrupt = (cache: ParseCache, key: string, section: 'facts' | 'scopes') => {
    const store = cache.fileResults!.live!,
      ref = store.records.get(key)!;
    const file = path.join(store.directory, ref.pack),
      bytes = fs.readFileSync(file);
    bytes[ref.offset + (section === 'facts' ? 0 : ref.factsLength) + 8] ^= 255;
    fs.writeFileSync(file, bytes);
  };
  const seeded = async () => {
    const file = writeFile('src/cached.ts');
    const cold = newCache();
    await run(cold, [file]);
    await persist(cold);
    return file;
  };
  const lostRepair = async () => {
    const file = await seeded(),
      cache = await warmCache(),
      key = keyOf(file);
    const original = (await loadParseCacheFiles(cache, [{ key, path: file.path }])).get(key)!;
    const encoded = {
      key,
      path: file.path,
      cacheable: true,
      facts: encodeFileResultSection(key, file.path, 'facts', { ...original, parsedFiles: [] })!,
      scopes: encodeFileResultSection(key, file.path, 'scopes', original.parsedFiles)!,
    };
    await persistParseCacheFiles(cache, [encoded]);
    cache.usedKeys.add(key);
    fs.rmSync(
      path.join(
        cache.fileResults!.stage!.directory,
        cache.fileResults!.stage!.records.get(key)!.pack,
      ),
    );
    return { file, cache, key };
  };
  it('a miss persists complete scope sections under the file key', async () => {
    const file = writeFile('src/cached.ts'),
      cache = newCache();
    await run(cache, [file]);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(cache.stagedKeys?.has(keyOf(file))).toBe(true);
    expect(cache.fileResults?.stage?.records.has(keyOf(file))).toBe(true);
    expect([...(await coverage(cache, [file.path]))].map(([p]) => p)).toEqual([file.path]);
  });
  it('a failed pack write preserves graph output and scope coverage', async () => {
    const append = fs.promises.appendFile;
    vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.pack')) throw Error('EACCES: simulated pack write failure');
      return append(...args);
    });
    const file = writeFile('src/degrade.ts'),
      cache = newCache();
    const result = await run(cache, [file]);
    expect(result.reparsedFileCount).toBe(1);
    expect((await coverage(cache, [file.path])).has(file.path)).toBe(true);
    expect(cache.stagedKeys?.size).toBe(0);
    expect(cache.fileResults?.memory.has(keyOf(file))).toBe(true);
    await expect(flushFileParseCache(cache)).rejects.toThrow('Could not persist');
  });
  it('does not publish a missing staged repair or fall back to a live record', async () => {
    const { cache, key } = await lostRepair();
    expect(cache.onDiskKeys?.has(key)).toBe(true);
    expect(cache.stagedKeys?.has(key)).toBe(true);
    expect(await persist(cache)).not.toContain(key);
    expect((await warmCache()).onDiskKeys?.has(key)).toBe(false);
  });
  it('keeps a retired file excluded when a sibling fold re-adds its key', async () => {
    const file = await seeded(),
      cache = await warmCache(),
      key = keyOf(file);
    markParseCacheChunkStale(cache, key);
    cache.usedKeys.add(key);
    cache.onDiskKeys?.add(key);
    cache.entries.set(key, []);
    expect(await persist(cache)).not.toContain(key);
  });
  it('retiring a file clears memory, disk and stage lookup state', async () => {
    const file = await seeded(),
      cache = await warmCache(),
      key = keyOf(file);
    cache.usedKeys.add(key);
    cache.stagedKeys?.add(key);
    cache.entries.set(key, []);
    markParseCacheChunkStale(cache, key);
    expect(cache.staleKeys?.has(key)).toBe(true);
    expect(cache.onDiskKeys?.has(key)).toBe(false);
    expect(cache.stagedKeys?.has(key)).toBe(false);
    expect(cache.entries.has(key)).toBe(false);
    expect((await loadParseCacheFiles(cache, [{ key, path: file.path }])).size).toBe(0);
  });
  it('a repaired file is reusable without retaining the corrupt scope generation', async () => {
    const file = await seeded(),
      cache = await warmCache(),
      key = keyOf(file);
    corrupt(cache, key, 'scopes');
    await run(cache, [file]);
    expect(cache.staleKeys?.has(key) ?? false).toBe(false);
    expect(await persist(cache)).toContain(key);
    const warm = await warmCache();
    fs.rmSync(markerPath);
    const result = await run(warm, [file]);
    expect(result.reparsedFileCount).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect((await coverage(warm, [file.path])).has(file.path)).toBe(true);
  });
  it('healthy facts and scopes survive save together', async () => {
    const file = await seeded(),
      cache = await warmCache();
    await run(cache, [file]);
    expect(await persist(cache)).toContain(keyOf(file));
    expect(cache.staleKeys?.size ?? 0).toBe(0);
    expect((await warmCache()).fileResults?.live?.records.has(keyOf(file))).toBe(true);
  });
  it('a lost staged repair reparses on the following run', async () => {
    const { file, cache, key } = await lostRepair();
    await persist(cache);
    const third = await warmCache();
    expect(third.onDiskKeys?.has(key)).toBe(false);
    fs.rmSync(markerPath);
    await run(third, [file]);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
  it('retires only the failed file while its neighbour stays warm', async () => {
    const a = writeFile('file0.ts'),
      b = writeFile('file13.ts');
    const cold = newCache();
    await run(cold, [a, b]);
    await persist(cold);
    const warm = await warmCache();
    corrupt(warm, keyOf(a), 'scopes');
    writeFileResultWorker(workerPath, markerPath, { uncacheablePaths: [a.path] });
    const result = await run(warm, [a, b]);
    expect(result.reparsedFileCount).toBe(1);
    expect(result.parseCacheHitFileCount).toBe(1);
    expect(warm.staleKeys?.has(keyOf(a))).toBe(true);
    expect(warm.staleKeys?.has(keyOf(b)) ?? false).toBe(false);
    await persist(warm);
    fs.rmSync(markerPath);
    await run(await warmCache(), [b]);
    expect(fs.existsSync(markerPath)).toBe(false);
    await run(await warmCache(), [a]);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
  it('retains ParsedFiles when an uncached transient-store write fails', async () => {
    const file = writeFile('src/persist-fallback.ts');
    writeFileResultWorker(workerPath, markerPath, { uncacheablePaths: [file.path] });
    persistOverride.impl = async () => false;
    expect((await run(newCache(), [file])).parsedFiles.map((f) => f.filePath)).toEqual([file.path]);
  });
  it('missing facts cause dispatch before trusting their scope section', async () => {
    const file = await seeded(),
      cache = await warmCache();
    corrupt(cache, keyOf(file), 'facts');
    fs.rmSync(markerPath);
    const result = await run(cache, [file]);
    expect(result.parseCacheHitFileCount).toBe(0);
    expect(result.reparsedFileCount).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect((await coverage(cache, [file.path])).has(file.path)).toBe(true);
  });
  it('a repeated miss replaces scope artifacts instead of accumulating old paths', async () => {
    const file = await seeded(),
      cache = await warmCache();
    corrupt(cache, keyOf(file), 'scopes');
    await run(cache, [file]);
    await persist(cache);
    expect([...(await coverage(cache, [file.path, 'stale-attempt.ts']))].map(([p]) => p)).toEqual([
      file.path,
    ]);
    expect((await warmCache()).fileResults?.live?.records.size).toBe(1);
  });
  it('all hits start no worker and restore complete scope coverage', async () => {
    const file = await seeded(),
      cache = await warmCache();
    fs.rmSync(markerPath);
    const result = await run(cache, [file]);
    expect(result.usedWorkerPool).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect((await coverage(cache, [file.path])).has(file.path)).toBe(true);
  });
  for (const index of ['parse-cache/index.json', 'parse-cache/files/index.json']) {
    it.each([undefined, 'legacy-v1', 'foreign-identity', {}])(
      `rejects incompatible identity in ${index}: %s`,
      async (invalid) => {
        const file = await seeded(),
          filename = path.join(storageDir, index),
          data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        const field = index.endsWith('files/index.json') ? 'identity' : 'version';
        if (invalid === undefined) delete data[field];
        else data[field] = invalid;
        fs.writeFileSync(filename, JSON.stringify(data));
        fs.rmSync(markerPath);
        expect((await run(await warmCache(), [file])).reparsedFileCount).toBe(1);
        expect(fs.existsSync(markerPath)).toBe(true);
      },
    );
  }
  it('incomplete scope extraction remains visible and is never reused', async () => {
    const file = writeFile('src/broken.ts');
    writeFileResultWorker(workerPath, markerPath, { scopeFailures: [file.path] });
    const cold = newCache();
    expect((await run(cold, [file])).scopeExtractionFailures).toEqual([file.path]);
    await persist(cold);
    fs.rmSync(markerPath);
    const next = await run(await warmCache(), [file]);
    expect(next.scopeExtractionFailures).toEqual([file.path]);
    expect(next.reparsedFileCount).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
  it('missing packed scopes force a worker reparse', async () => {
    const file = await seeded(),
      cache = await warmCache(),
      store = cache.fileResults!.live!;
    fs.rmSync(path.join(store.directory, store.records.get(keyOf(file))!.pack));
    fs.rmSync(markerPath);
    expect((await run(cache, [file])).reparsedFileCount).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
  it('corrupt packed scopes force a worker reparse', async () => {
    const file = await seeded(),
      cache = await warmCache();
    corrupt(cache, keyOf(file), 'scopes');
    fs.rmSync(markerPath);
    expect((await run(cache, [file])).reparsedFileCount).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
  it('one file changes while an unchanged member of the same chunk restores', async () => {
    const a = writeFile('file0.ts'),
      b = writeFile('file13.ts'),
      cold = newCache();
    await run(cold, [a, b]);
    await persist(cold);
    const changed = writeFile(a.path, 'export const changed = 2;'),
      warm = await warmCache();
    const result = await run(warm, [changed, b]);
    expect(result.reparsedFileCount).toBe(1);
    expect(result.parseCacheHitFileCount).toBe(1);
    expect([...(await coverage(warm, [a.path, b.path]))].map(([p]) => p).sort()).toEqual([
      a.path,
      b.path,
    ]);
  });
});
