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
 * The fix: workers ALSO write a durable, content-addressed ParsedFile store
 * keyed by chunk hash (`parsedfile-cache/`); a warm hit LOADS those shards
 * in place (no copy into the run-scoped store) so scope-resolution streams
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

// Partial mock: lets one test make prepareDurableParsedFileChunk fail without
// touching the worker-side persist path (which shares the same directory).
const prepareOverride = vi.hoisted(() => ({
  impl: undefined as undefined | (() => Promise<void>),
}));
const persistOverride = vi.hoisted(() => ({
  impl: undefined as undefined | (() => Promise<boolean>),
}));
vi.mock('../../src/storage/parsedfile-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/storage/parsedfile-store.js')>();
  return {
    ...real,
    prepareDurableParsedFileChunk: (durableDir: string, chunkHash: string) =>
      prepareOverride.impl
        ? prepareOverride.impl()
        : real.prepareDurableParsedFileChunk(durableDir, chunkHash),
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
  PARSE_CACHE_VERSION,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  getParsedFileStoreDir,
  prepareDurableParsedFileChunk,
  persistDurableParsedFileShardSync,
  loadParsedFilesForPaths,
  loadDurableParsedFileIndex,
  pruneAndSaveDurableParsedFileStore,
  clearParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';
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
    const loaded = await loadParsedFilesForPaths(tempDir, new Set(files), {
      durableDir,
      durableKeys: new Set([chunkHash]),
    });
    expect([...loaded.keys()].sort()).toEqual([...files].sort());
  });

  it('durableChunkHasShards is false when the chunk has no durable shards', async () => {
    const durableDir = getDurableParsedFileDir(tempDir);
    const { durableChunkHasShards } = await import('../../src/storage/parsedfile-store.js');
    expect(
      await durableChunkHasShards(durableDir, tempDir, 'b'.repeat(64), new Set(['missing.ts'])),
    ).toBe(false);
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
    const files = await loadParsedFilesForPaths(
      tempDir,
      new Set(['old.ts', 'new-a.ts', 'new-b.ts']),
      { durableDir, durableKeys: new Set([chunkHash]) },
    );
    expect([...files.keys()].sort()).toEqual(['new-a.ts', 'new-b.ts']);
  });

  it('index load is version-gated (PARSE_CACHE_VERSION mismatch ⇒ empty)', async () => {
    const durableDir = getDurableParsedFileDir(tempDir);
    const chunkHash = 'c'.repeat(64);
    persistDurableParsedFileShardSync(durableDir, chunkHash, 1, 0, [mkParsedFile('x.ts')]);
    await pruneAndSaveDurableParsedFileStore(durableDir, PARSE_CACHE_VERSION, new Set([chunkHash]));

    expect(await loadDurableParsedFileIndex(durableDir, PARSE_CACHE_VERSION)).toEqual(
      new Map([[chunkHash, new Set(['x.ts'])]]),
    );
    // A schema bump (different version) invalidates the whole durable store.
    expect(await loadDurableParsedFileIndex(durableDir, '999+9.9.9')).toEqual(new Map());
  });

  it('prune keeps only keepKeys subdirs with ≥1 shard, drops the rest, and re-indexes', async () => {
    const durableDir = getDurableParsedFileDir(tempDir);
    const keep = 'd'.repeat(64);
    const drop = 'e'.repeat(64); // present on disk but NOT in keepKeys (e.g. quarantined / stale)
    persistDurableParsedFileShardSync(durableDir, keep, 1, 0, [mkParsedFile('keep.ts')]);
    persistDurableParsedFileShardSync(durableDir, drop, 1, 0, [mkParsedFile('drop.ts')]);

    await pruneAndSaveDurableParsedFileStore(durableDir, PARSE_CACHE_VERSION, new Set([keep]));

    expect(fs.existsSync(path.join(durableDir, keep))).toBe(true);
    expect(fs.existsSync(path.join(durableDir, drop))).toBe(false);
    expect(await loadDurableParsedFileIndex(durableDir, PARSE_CACHE_VERSION)).toEqual(
      new Map([[keep, new Set(['keep.ts'])]]),
    );
  });
});

// ─── Layer 2: parse-impl integration (injected worker, build-free) ───────────

// A test worker that mirrors the production flush contract: it writes a
// run-scoped V8 shard AND a durable, content-addressed V8 shard (when the
// flush carries a chunk hash) using the SAME directory layout as the real worker.
const writeStoreWorker = (workerPath: string, markerPath: string): void => {
  fs.writeFileSync(
    workerPath,
    `
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { createHash } = require('node:crypto');
const { parentPort, threadId, workerData } = require('node:worker_threads');
const storePath = workerData && workerData.parsedFileStoreStoragePath;
const durablePath = workerData && workerData.durableParsedFileStoragePath;
let shardSeq = 0;
fs.writeFileSync(${JSON.stringify(markerPath)}, 'spawned');
parentPort.postMessage({ type: 'ready' });
const writeV8 = (filePath, graph, paths) => {
  const payload = v8.serialize(graph);
  const listing = paths.some((p) => /[\\r\\n\\0]/.test(p))
    ? Buffer.alloc(0)
    : Buffer.from(paths.length + '\\n' + paths.join('\\n') + '\\n', 'utf8');
  const MAGIC = Buffer.from('GNXV8CF1');
  const v8ver = Buffer.from(process.versions.v8, 'utf8');
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  const header = Buffer.allocUnsafe(16 + v8ver.length + 12);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(4, 8);
  header.writeUInt16LE(nodeMajor, 12);
  header.writeUInt16LE(v8ver.length, 14);
  v8ver.copy(header, 16);
  let off = 16 + v8ver.length;
  header.writeUInt32LE(listing.length === 0 ? 0 : paths.length, off);
  header.writeUInt32LE(listing.length, off + 4);
  header.writeUInt32LE(payload.length, off + 8);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payloadHash = createHash('sha256').update(payload).digest();
  fs.writeFileSync(filePath, Buffer.concat([header, listing, payload, payloadHash]));
};
const reset = () => ({
  nodes: [], relationships: [], symbols: [], imports: [], calls: [], assignments: [], heritage: [],
  routes: [], fetchCalls: [], fetchWrapperDefs: [], decoratorRoutes: [], routerIncludes: [],
  routerImports: [], toolDefs: [], ormQueries: [], constructorBindings: [], fileScopeBindings: [],
  parsedFiles: [], skippedLanguages: {}, fileCount: 0,
  scopeExtractionFailures: [],
});
let accumulated = reset();
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'sub-batch') {
    for (const file of msg.files) {
      const filePath = file.path;
      const name = filePath.split('/').pop().replace(/\\.ts$/, '');
      accumulated.nodes.push({
        id: 'Function:' + filePath + ':' + name,
        label: 'Function',
        properties: { name, filePath, startLine: 1, endLine: 1, language: 'typescript' },
      });
      accumulated.parsedFiles.push({
        filePath, moduleScope: '', scopes: [], parsedImports: [], localDefs: [], referenceSites: [],
      });
      if (filePath.includes('broken')) accumulated.scopeExtractionFailures.push(filePath);
      accumulated.fileCount++;
    }
    parentPort.postMessage({ type: 'progress', filesProcessed: accumulated.fileCount });
    parentPort.postMessage({ type: 'sub-batch-done' });
    return;
  }
  if (msg && msg.type === 'flush') {
    if ((storePath || durablePath) && accumulated.parsedFiles.length > 0) {
      const seq = shardSeq++;
      const paths = accumulated.parsedFiles.map((pf) => pf.filePath);
      let wroteStore = false;
      if (durablePath && typeof msg.chunkHash === 'string') {
        writeV8(
          path.join(durablePath, msg.chunkHash, msg.chunkHash + '-w' + threadId + '-' + seq + '.v8'),
          accumulated.parsedFiles,
          paths,
        );
      }
      if (storePath) {
        writeV8(
          path.join(storePath, 'parsedfile-store', 'w' + threadId + '-' + seq + '.v8'),
          accumulated.parsedFiles,
          paths,
        );
        wroteStore = true;
      }
      const keepForMain = accumulated.parsedFiles.some((pf) =>
        pf.filePath.includes('persist-fallback')
      );
      if (wroteStore && !keepForMain) accumulated.parsedFiles = [];
    }
    parentPort.postMessage({ type: 'result', data: accumulated });
    accumulated = reset();
  }
});
`,
  );
};

describe('parse-impl warm-cache ParsedFile coverage (#2038)', () => {
  let tempDir = '';
  let repoDir = '';
  let storageDir = '';
  let workerPath = '';
  let markerPath = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-cache-coverage-'));
    repoDir = path.join(tempDir, 'repo');
    storageDir = path.join(tempDir, 'storage');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    workerPath = path.join(tempDir, 'store-worker.js');
    markerPath = path.join(tempDir, 'worker-spawned.marker');
    writeStoreWorker(workerPath, markerPath);
  });
  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    prepareOverride.impl = undefined;
    persistOverride.impl = undefined;
  });

  const writeFile = (rel: string, content: string): { path: string; size: number } => {
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return { path: rel, size: fs.statSync(full).size };
  };

  const newCache = () => ({
    version: PARSE_CACHE_VERSION,
    entries: new Map<string, ParseWorkerResult[]>(),
    usedKeys: new Set<string>(),
    storagePath: storageDir,
    onDiskKeys: new Set<string>(),
  });

  // The post-run orchestrator step (run-analyze) — persist parse cache + prune
  // the durable store to the surviving keys. Mirrored here so run #2 sees an
  // index, exactly like a real second invocation.
  const persistCaches = async (cache: ReturnType<typeof newCache>): Promise<void> => {
    const { saveParseCache, pruneCache } = await import('../../src/storage/parse-cache.js');
    pruneCache(cache, cache.usedKeys);
    const saved = await saveParseCache(storageDir, cache);
    await pruneAndSaveDurableParsedFileStore(
      getDurableParsedFileDir(storageDir),
      PARSE_CACHE_VERSION,
      new Set(saved),
    );
  };

  const run = async (
    cache: ReturnType<typeof newCache>,
    files: { path: string; size: number }[],
    chunkByteBudget?: number,
  ): Promise<Awaited<ReturnType<typeof runChunkedParseAndResolve>>> => {
    const rels = files.map((f) => f.path);
    return runChunkedParseAndResolve(
      createKnowledgeGraph(),
      files,
      rels,
      files.length,
      repoDir,
      Date.now(),
      () => {},
      {
        workerUrlForTest: pathToFileURL(workerPath),
        workerPoolSize: 1,
        parseCache: cache,
        ...(chunkByteBudget !== undefined ? { chunkByteBudget } : {}),
      },
    );
  };

  it('run #1 (miss) populates the durable store, keyed by chunk hash', async () => {
    const f = writeFile('src/cached.ts', 'export function cached() { return 1; }\n');
    const chunkHash = computeChunkHash([
      {
        filePath: f.path,
        contentHash: fileContentHash(fs.readFileSync(path.join(repoDir, f.path), 'utf-8')),
      },
    ]);
    const cache = newCache();

    await run(cache, [f]);

    expect(fs.existsSync(markerPath)).toBe(true); // worker ran (miss)
    const chunkDir = path.join(getDurableParsedFileDir(storageDir), chunkHash);
    expect(fs.existsSync(chunkDir)).toBe(true);
    expect(fs.readdirSync(chunkDir).filter((n) => n.endsWith('.v8')).length).toBeGreaterThan(0);
    expect(cache.usedKeys.has(chunkHash)).toBe(true);
  });

  it('a failing durable-generation reset degrades instead of failing the analyze', async () => {
    const f = writeFile('src/degrade.ts', 'export function degrade() { return 1; }\n');
    prepareOverride.impl = () => Promise.reject(new Error('EACCES: simulated cache failure'));
    try {
      await expect(run(newCache(), [f])).resolves.toBeDefined();
    } finally {
      prepareOverride.impl = undefined;
    }
  });

  it('retains worker ParsedFiles when the main-thread run-store write fails', async () => {
    const f = writeFile(
      'src/persist-fallback.ts',
      'export function persistFallback() { return 1; }\n',
    );
    persistOverride.impl = () => Promise.resolve(false);

    const result = await run(newCache(), [f]);

    expect(result.parsedFiles.map((parsed) => parsed.filePath)).toContain(f.path);
  });

  it('does not snapshot durable shards when the parse-cache payload is missing', async () => {
    const f = writeFile('src/orphan.ts', 'export function orphan() { return 1; }\n');
    const chunkHash = computeChunkHash([
      {
        filePath: f.path,
        contentHash: fileContentHash(fs.readFileSync(path.join(repoDir, f.path), 'utf-8')),
      },
    ]);
    const durableDir = getDurableParsedFileDir(storageDir);
    persistDurableParsedFileShardSync(durableDir, chunkHash, 1, 0, [mkParsedFile(f.path)]);
    await pruneAndSaveDurableParsedFileStore(durableDir, PARSE_CACHE_VERSION, new Set([chunkHash]));

    await run(newCache(), [f]);

    const runShards = fs
      .readdirSync(getParsedFileStoreDir(storageDir))
      .filter((name) => name.endsWith('.v8'));
    expect(runShards.length).toBeGreaterThan(0);
    expect(runShards.every((name) => !name.startsWith(chunkHash))).toBe(true);
  });

  it('a repeated cache miss replaces the durable chunk generation', async () => {
    const f = writeFile('src/repeated.ts', 'export function repeated() { return 1; }\n');
    const chunkHash = computeChunkHash([
      {
        filePath: f.path,
        contentHash: fileContentHash(fs.readFileSync(path.join(repoDir, f.path), 'utf-8')),
      },
    ]);

    await run(newCache(), [f]);
    await run(newCache(), [f]);

    const chunkDir = path.join(getDurableParsedFileDir(storageDir), chunkHash);
    const shards = fs.readdirSync(chunkDir).filter((name) => name.endsWith('.v8'));
    expect(shards).toHaveLength(1);
    const shard = shards[0];
    if (!shard) throw new Error('expected one durable V8 shard');
    const { tryLoadV8Cache } = await import('../../src/storage/v8-sidecar.js');
    const hit = await tryLoadV8Cache(path.join(chunkDir, shard));
    expect(hit?.kind).toBe('hit');
    if (hit?.kind !== 'hit') return;
    const parsed = hit.value as Array<{ filePath: string }>;
    expect(parsed.map((item) => item.filePath)).toEqual(['src/repeated.ts']);
  });

  it('run #2 (all hits) spawns NO worker — the warm path is served from caches', async () => {
    const f = writeFile('src/cached.ts', 'export function cached() { return 1; }\n');
    const cache = newCache();

    await run(cache, [f]); // miss → populates
    await persistCaches(cache);

    // Reload caches from disk for the warm run, like a fresh invocation.
    const { loadParseCache } = await import('../../src/storage/parse-cache.js');
    const warm = await loadParseCache(storageDir);
    fs.rmSync(markerPath, { force: true }); // reset the spawn marker

    await run(warm as ReturnType<typeof newCache>, [f]);

    expect(fs.existsSync(markerPath)).toBe(false); // NO worker spawned on the warm hit
  });

  it('replays scope-extraction failures from a warm parse-cache hit', async () => {
    const f = writeFile('src/broken.ts', 'export function broken() { return 1; }\n');
    const cache = newCache();

    const cold = await run(cache, [f]);
    expect(cold.scopeExtractionFailures).toEqual([f.path]);
    await persistCaches(cache);

    const { loadParseCache } = await import('../../src/storage/parse-cache.js');
    const warm = await loadParseCache(storageDir);
    fs.rmSync(markerPath, { force: true });

    const replayed = await run(warm as ReturnType<typeof newCache>, [f]);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(replayed.scopeExtractionFailures).toEqual([f.path]);
  });

  it('coherence gate: a parse-cache hit with NO durable shards re-dispatches the worker', async () => {
    const f = writeFile('src/cached.ts', 'export function cached() { return 1; }\n');
    const cache = newCache();

    await run(cache, [f]); // miss → populates parse cache + durable
    await persistCaches(cache);

    // Wipe ONLY the durable store, leaving the parse cache intact — simulates a
    // first run after the durable store was introduced, or a pruned shard.
    fs.rmSync(getDurableParsedFileDir(storageDir), { recursive: true, force: true });

    const { loadParseCache } = await import('../../src/storage/parse-cache.js');
    const warm = await loadParseCache(storageDir);
    fs.rmSync(markerPath, { force: true });

    await run(warm as ReturnType<typeof newCache>, [f]);

    // The gate must NOT silently skip — it falls through to a worker re-dispatch
    // (which repopulates the durable store), never a main-thread re-extract.
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('coherence gate: a parse-cache hit with a corrupt durable shard re-dispatches', async () => {
    const f = writeFile('src/corrupt.ts', 'export function corrupt() { return 1; }\n');
    const cache = newCache();

    await run(cache, [f]);
    await persistCaches(cache);
    const chunkHash = computeChunkHash([
      {
        filePath: f.path,
        contentHash: fileContentHash('export function corrupt() { return 1; }\n'),
      },
    ]);
    const chunkDir = path.join(getDurableParsedFileDir(storageDir), chunkHash);
    const shard = fs.readdirSync(chunkDir).find((name) => name.endsWith('.v8'));
    expect(shard).toBeDefined();
    if (!shard) return;
    fs.writeFileSync(path.join(chunkDir, shard), Buffer.from([0, 1, 2]));

    const { loadParseCache } = await import('../../src/storage/parse-cache.js');
    const warm = await loadParseCache(storageDir);
    fs.rmSync(markerPath, { force: true });

    await run(warm as ReturnType<typeof newCache>, [f]);

    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('mixed-mode: changing one file re-parses its chunk while the unchanged chunk restores', async () => {
    // Force one file per chunk (chunkByteBudget: 1) so a and b hash to DISTINCT
    // chunks — the true mixed-mode the pr-2038 mixed-mode gap warns about.
    const a = writeFile('src/a.ts', 'export function a() { return 1; }\n');
    const b = writeFile('src/b.ts', 'export function b() { return 2; }\n');
    const cache = newCache();

    await run(cache, [a, b], 1); // both miss → both durable subdirs populated
    await persistCaches(cache);

    const aHash = computeChunkHash([
      { filePath: a.path, contentHash: fileContentHash('export function a() { return 1; }\n') },
    ]);
    // run #1 populated a's durable subdir (the chunk that will HIT on run #2).
    expect(fs.existsSync(path.join(getDurableParsedFileDir(storageDir), aHash))).toBe(true);

    // Change b's content → b's chunk hash changes → b misses, a still hits.
    fs.writeFileSync(path.join(repoDir, b.path), 'export function b() { return 999; }\n');
    const b2 = { path: b.path, size: fs.statSync(path.join(repoDir, b.path)).size };

    const { loadParseCache } = await import('../../src/storage/parse-cache.js');
    const warm = await loadParseCache(storageDir);
    fs.rmSync(markerPath, { force: true });

    await run(warm as ReturnType<typeof newCache>, [a, b2], 1);

    // The worker spawned (for the changed file b); a was loaded from durable.
    expect(fs.existsSync(markerPath)).toBe(true);
    // a's UNCHANGED chunk is still a hit served from the durable store.
    expect((warm as ReturnType<typeof newCache>).usedKeys.has(aHash)).toBe(true);
  });
});
