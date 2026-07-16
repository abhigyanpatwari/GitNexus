/**
 * Disk-backed `ParsedFile` store (#1983 scope-resolution OOM).
 *
 * ## Why this exists
 *
 * The scope-resolution phase needs a `ParsedFile` (scopes / defs / reference
 * sites) for every file. Historically it re-extracted each file from source on
 * the **main thread** via `extractParsedFile` → `parseSourceSafe`. On a huge
 * repo (Linux kernel, ~64k C files) that re-parse accumulates an unbounded
 * **native** memory leak in `tree-sitter` 0.21.1 (`CallbackInput` retains the
 * input string with no destructor; node-tree-sitter PR #201) — the leaked
 * `TSTree` memory is invisible to V8, never reclaimed by GC, and not freed by
 * worker_thread teardown. The parse phase escapes it only because each parse is
 * relatively cheap there; a second full re-parse of every file on the immortal
 * main thread pushes RSS past the heap cap and the OOM-killer fires.
 *
 * The fix: the parse workers already build a tree-sitter `Tree` per file, so
 * they emit the `ParsedFile` directly (reusing that tree — no second parse).
 * Holding all of them in main-thread heap is what the original #1983 work
 * removed (it cost ~1× the semantic model in RAM during parse), so instead we
 * flush them to this disk store per chunk and stream them back per language in
 * scope-resolution. Net effect: the file is parsed exactly once (in a worker),
 * scope-resolution does ZERO parsing, and peak heap stays bounded.
 *
 * ## Shape
 *
 * `<storagePath>/parsedfile-store/<shardId>.json` — one shard per parse chunk,
 * a JSON array of `ParsedFile` serialized with the same `mapReplacer` the parse
 * cache uses (Scope.bindings / Scope.typeBindings are `Map`s). The store is
 * cleared at the start of each parse and after scope-resolution consumes it, so
 * it never lingers and never goes stale across runs.
 *
 * ## Durable sibling store (`parsedfile-cache/`, warm-cache coverage)
 *
 * The run-scoped store above is only populated when the parse workers actually
 * run. On a warm re-analyze where every chunk is a parse-cache HIT, no worker
 * runs, the run-scoped store was cleared at parse start, and the cached
 * `ParseWorkerResult` carries no `ParsedFile`s (the worker emptied them after
 * its store write) — so scope-resolution would find an empty store and fall
 * back to main-thread `extractParsedFile`, re-opening the #1983 OOM. To close
 * that gap we ALSO write the worker's ParsedFiles to a second, CONTENT-ADDRESSED
 * store keyed by the parse chunk hash (`getDurableParsedFileDir`), which mirrors
 * the parse cache's lifecycle (persists across runs, pruned by `usedKeys`,
 * version-tied via `PARSE_CACHE_VERSION`). On a warm hit the chunk's durable
 * shards are byte-COPIED into the run-scoped store (no re-parse, no
 * re-serialize → byte-identical), so scope-resolution streams them exactly as
 * on a cold run. Content-addressing makes stale reuse impossible: a changed
 * file changes its chunk hash, which misses BOTH stores and re-dispatches.
 */

import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { mapReplacer, mapReviver } from './parse-cache.js';

const STORE_DIRNAME = 'parsedfile-store';
const DURABLE_DIRNAME = 'parsedfile-cache';
const DURABLE_INDEX_FILENAME = 'index.json';

/**
 * Build a JSON.parse reviver that (a) interns every string against a shared
 * pool and (b) applies the parse-cache `mapReviver` (Map/Set reconstruction).
 *
 * `JSON.parse` allocates a DISTINCT string object for every textual token, so a
 * `ParsedFile` graph round-tripped through disk holds millions of duplicate
 * strings — every def repeats its `filePath`, and common type/qualified names
 * (`int`, `void`, `struct …`) recur across the whole repo. On the Linux kernel
 * that roughly DOUBLES the deserialized heap (~15 GB vs ~7.6 GB interned).
 * Interning IN the reviver collapses duplicates as the tree is revived (one
 * pass, no second walk). The pool is per-load; the interned strings stay shared
 * through the retained `ParsedFile` references after the pool is dropped.
 */
export const makeInterningReviver = (
  pool: Map<string, string>,
  defPool: Map<string, SymbolDefinition>,
) => {
  return (key: string, value: unknown): unknown => {
    if (typeof value === 'string') {
      const hit = pool.get(value);
      if (hit !== undefined) return hit;
      pool.set(value, value);
      return value;
    }
    const revived = mapReviver(key, value);
    // Collapse the THREE serialized copies of each `SymbolDefinition` back to one
    // shared object, keyed on the def-exclusive `nodeId`. A def is serialized in
    // `localDefs`, in its owning `scope.ownedDefs`, and inside `scope.bindings[].def`;
    // in the live extractor those are ONE object by reference, but `JSON.parse`
    // rebuilds three distinct objects (string interning alone leaves the object
    // duplication intact — ~3× the def-object heap on the disk-backed path).
    // Re-sharing is byte-identical to resolution: every consumer reads defs BY
    // VALUE (`nodeId`/`type`), never by object identity, and the authoritative
    // resolver index is built from `localDefs` only. `nodeId` is def-exclusive in
    // the scope-resolution schema; the `filePath` check guards future shapes.
    if (
      revived !== null &&
      typeof revived === 'object' &&
      typeof (revived as { nodeId?: unknown }).nodeId === 'string' &&
      typeof (revived as { filePath?: unknown }).filePath === 'string'
    ) {
      const def = revived as SymbolDefinition;
      const seen = defPool.get(def.nodeId);
      if (seen !== undefined) return seen;
      defPool.set(def.nodeId, def);
      return def;
    }
    return revived;
  };
};

/**
 * Best-effort forced garbage collection. `JSON.parse` of each shard builds a
 * transient bloated (pre-intern) tree; across hundreds of shards that churn
 * outpaces V8's incremental GC and piles up against the heap limit (measured
 * ~5 GB of avoidable transient on the kernel). A periodic full GC during the
 * load keeps the peak at the retained set rather than retained + churn. Uses
 * the global `gc` when exposed, else the v8/vm trick — and degrades to a no-op
 * if neither is available, so it never throws.
 */
let cachedGc: (() => void) | null | undefined;
/**
 * Best-effort synchronous GC. Uses `globalThis.gc` when `--expose-gc` is set,
 * else lazily wires it via `v8.setFlagsFromString('--expose-gc')` + a fresh
 * `vm` context. Exported so scope-resolution can reclaim a finished language's
 * ParsedFiles at the per-language eviction boundary (#1741 / kernel memory work).
 */
export const forceGc = (): void => {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g === 'function') {
    g();
    return;
  }
  if (cachedGc === undefined) {
    cachedGc = null;
    try {
      v8.setFlagsFromString('--expose-gc');
      cachedGc = vm.runInNewContext('gc') as () => void;
      v8.setFlagsFromString('--no-expose-gc');
    } catch {
      cachedGc = null;
    }
  }
  cachedGc?.();
};

export const getParsedFileStoreDir = (storagePath: string): string =>
  path.join(storagePath, STORE_DIRNAME);

/** Remove any prior run's shards so a fresh parse starts clean. Idempotent. */
export const clearParsedFileStore = async (storagePath: string): Promise<void> => {
  await fs.rm(getParsedFileStoreDir(storagePath), { recursive: true, force: true });
};

/**
 * Single source of truth for a shard's bytes. Returns `null` for an empty
 * chunk (caller writes nothing). Both the async (`persistParsedFileChunk`) and
 * sync (`persistParsedFileShardSync`) writers go through this so the two paths
 * are guaranteed byte-identical — the shards must round-trip through the same
 * `mapReviver`, and matching bytes by having both authors type the same
 * `mapReplacer` call would be a coincidence, not a guarantee.
 */
const serializeParsedFileShard = (parsedFiles: readonly ParsedFile[]): string | null => {
  if (parsedFiles.length === 0) return null;
  return JSON.stringify(parsedFiles, mapReplacer);
};

const shardPath = (storagePath: string, shardId: string): string =>
  path.join(getParsedFileStoreDir(storagePath), `${shardId}.json`);

/**
 * Write one parse chunk's `ParsedFile[]` to the store as a single shard (async).
 * No-op for an empty chunk. `shardId` must be unique within a run. Used by the
 * main-thread no-store-disabled fallback and any non-worker writer; the worker
 * store path uses {@link persistParsedFileShardSync}.
 */
export const persistParsedFileChunk = async (
  storagePath: string,
  shardId: string,
  parsedFiles: readonly ParsedFile[],
): Promise<void> => {
  const payload = serializeParsedFileShard(parsedFiles);
  if (payload === null) return;
  await fs.mkdir(getParsedFileStoreDir(storagePath), { recursive: true });
  await fs.writeFile(shardPath(storagePath, shardId), payload, 'utf-8');
};

// Per-process set of store dirs we've already `mkdir`ed, so the sync worker
// writer (called once per job, many times into the same dir) doesn't issue a
// `mkdirSync` syscall on every shard. Mirrors parse-cache.ts's `createdCacheDirs`.
const createdStoreDirs = new Set<string>();

/**
 * Synchronous shard writer for use INSIDE a parse worker (#1983 parallel
 * serialization). The worker is a dedicated thread, so a blocking write there
 * protects the main thread, and a sync write avoids threading `async`/`await`
 * through the synchronous per-file extract loop. Produces byte-identical shards
 * to {@link persistParsedFileChunk} via the shared {@link serializeParsedFileShard}.
 * No-op for an empty chunk. `shardId` must be globally unique for the run (the
 * worker uses `w<threadId>-<seq>`); a duplicate would silently overwrite.
 */
export const persistParsedFileShardSync = (
  storagePath: string,
  shardId: string,
  parsedFiles: readonly ParsedFile[],
): void => {
  const payload = serializeParsedFileShard(parsedFiles);
  if (payload === null) return;
  const dir = getParsedFileStoreDir(storagePath);
  if (!createdStoreDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    createdStoreDirs.add(dir);
  }
  writeFileSync(shardPath(storagePath, shardId), payload, 'utf-8');
};

/**
 * Stream the store and return the `ParsedFile`s whose `filePath` is in
 * `wantPaths`, keyed by path. Loads one shard at a time and retains only the
 * matching entries, so peak heap is bounded by (matched set) + (one shard)
 * rather than the whole store. Returns an empty map when the store is absent
 * (e.g. tests, or a run with no worker pool) — callers fall back to a fresh
 * extract for the missing files.
 */
export const loadParsedFilesForPaths = async (
  storagePath: string,
  wantPaths: ReadonlySet<string>,
): Promise<Map<string, ParsedFile>> => {
  const out = new Map<string, ParsedFile>();
  if (wantPaths.size === 0) return out;
  const dir = getParsedFileStoreDir(storagePath);
  let shards: string[];
  try {
    shards = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return out; // store absent
  }
  // Shared interning pool for this load — deduplicates strings ACROSS shards
  // (one `int` / one repeated filePath for the whole language), which is where
  // most of the saving comes from. Dropped when this function returns.
  const pool = new Map<string, string>();
  for (let i = 0; i < shards.length; i++) {
    // Per-shard def pool: a SymbolDefinition's three serialized copies live within
    // a single shard (one ParsedFile), so the dedup is shard-local. A cross-shard
    // pool would retain defs of files NOT in `wantPaths` (loaded-but-discarded
    // shards), reintroducing the leak; per-shard drops them with the shard.
    const defPool = new Map<string, SymbolDefinition>();
    const reviver = makeInterningReviver(pool, defPool);
    let parsed: ParsedFile[];
    try {
      const raw = await fs.readFile(path.join(dir, shards[i]), 'utf-8');
      parsed = JSON.parse(raw, reviver) as ParsedFile[];
    } catch {
      continue; // skip a corrupt shard; missing files fall back to fresh extract
    }
    if (!Array.isArray(parsed)) continue;
    for (const pf of parsed) {
      if (pf && typeof pf.filePath === 'string' && wantPaths.has(pf.filePath)) {
        out.set(pf.filePath, pf);
      }
    }
    // Every few shards, reclaim the transient pre-intern parse churn before it
    // piles up against the heap limit (~5 GB avoidable on the kernel), and
    // yield so the GC + any pending I/O can run.
    if ((i & 7) === 7) {
      forceGc();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return out;
};

// ─── Durable, content-addressed sibling store (warm-cache coverage) ──────────
//
// Layout: `<durableDir>/<chunkHash>/<chunkHash>-w<tid>-<seq>.json` plus a
// top-level `<durableDir>/index.json` = `{version, keys:[chunkHash…]}`. One
// subdir per chunk hash so a chunk's (possibly several) shards collect and
// prune as a unit, and so `readdir(<chunkHash>/)` is O(shards-of-this-chunk),
// not O(all-history). Shards are byte-identical to run-scoped shards (same
// `serializeParsedFileShard`); restore is a verbatim copy, never a re-serialize.

interface DurableParsedFileIndex {
  version: string;
  keys: string[];
}

/** Durable store dir — a sibling of `parsedfile-store/`, NEVER cleared per run. */
export const getDurableParsedFileDir = (storagePath: string): string =>
  path.join(storagePath, DURABLE_DIRNAME);

const durableChunkDir = (durableDir: string, chunkHash: string): string =>
  path.join(durableDir, chunkHash);

/**
 * Start a fresh durable generation for one content-addressed parse chunk.
 * The main thread calls this once before dispatching a cache miss, before any
 * worker can write that chunk. Recreating the directory immediately keeps the
 * worker-side mkdir memoization valid while preventing old worker shard names
 * from accumulating across analyses.
 */
export const prepareDurableParsedFileChunk = async (
  durableDir: string,
  chunkHash: string,
): Promise<void> => {
  const dir = durableChunkDir(durableDir, chunkHash);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
};

// Per-process set of durable chunk subdirs already `mkdir`ed (mirrors
// `createdStoreDirs`) so the worker doesn't `mkdirSync` on every shard.
const createdDurableDirs = new Set<string>();

/**
 * Synchronous durable-shard writer for use INSIDE a parse worker, alongside
 * {@link persistParsedFileShardSync}. Writes the SAME bytes to a content-addressed
 * durable location keyed by the parse chunk hash so a future warm hit can reuse
 * them. `chunkHash`+`threadId`+`shardSeq` is collision-free across the
 * N-shards-per-chunk fan-out and across worker-death retries — the same
 * uniqueness that makes the run-scoped `w<tid>-<seq>` name safe, prefixed by
 * content. No-op for an empty chunk.
 */
export const persistDurableParsedFileShardSync = (
  durableDir: string,
  chunkHash: string,
  threadId: number,
  shardSeq: number,
  parsedFiles: readonly ParsedFile[],
): void => {
  const payload = serializeParsedFileShard(parsedFiles);
  if (payload === null) return;
  const dir = durableChunkDir(durableDir, chunkHash);
  if (!createdDurableDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    createdDurableDirs.add(dir);
  }
  writeFileSync(path.join(dir, `${chunkHash}-w${threadId}-${shardSeq}.json`), payload, 'utf-8');
};

/**
 * Restore a cached chunk's durable shards into the run-scoped store on a warm
 * hit. A verbatim byte copy (no parse, no re-serialize), so the restored
 * ParsedFiles are byte-identical to a cold run and `loadParsedFilesForPaths`
 * (which keys on `filePath`, not shard name) gives scope-resolution full
 * coverage. The durable shard names already carry the chunk hash, so they never
 * collide with the worker's run-scoped `w<tid>-<seq>` shards. Returns the number
 * of shards restored (0 ⇒ no durable coverage for this chunk; caller treats it
 * as a miss).
 */
export const restoreDurableParsedFileShard = async (
  durableDir: string,
  runStoragePath: string,
  chunkHash: string,
): Promise<number> => {
  const src = durableChunkDir(durableDir, chunkHash);
  let shards: string[];
  try {
    shards = (await fs.readdir(src)).filter((f) => f.endsWith('.json'));
  } catch {
    return 0; // no durable shards for this chunk
  }
  if (shards.length === 0) return 0;
  const dst = getParsedFileStoreDir(runStoragePath);
  await fs.mkdir(dst, { recursive: true });
  for (const name of shards) {
    await fs.copyFile(path.join(src, name), path.join(dst, name));
  }
  return shards.length;
};

/**
 * Read the durable index and return the set of chunk hashes it vouches for,
 * gated on `expectedVersion` (`PARSE_CACHE_VERSION`). A version mismatch or a
 * missing/corrupt index returns the empty set — the caller then treats every
 * chunk as a durable miss and re-dispatches workers (NEVER the main-thread
 * `extractParsedFile` fallback), which rewrites the durable store under the new
 * version. Mirrors `loadParseCache`'s version-invalidation contract.
 */
export const loadDurableParsedFileIndex = async (
  durableDir: string,
  expectedVersion: string,
): Promise<Set<string>> => {
  try {
    const raw = await fs.readFile(path.join(durableDir, DURABLE_INDEX_FILENAME), 'utf-8');
    const idx = JSON.parse(raw) as DurableParsedFileIndex;
    if (idx?.version !== expectedVersion || !Array.isArray(idx.keys)) return new Set();
    return new Set(idx.keys);
  } catch {
    return new Set();
  }
};

/**
 * Prune the durable store to `keepKeys` and rewrite its index. `keepKeys` must
 * be the parse cache's surviving on-disk keys (so the two stores stay coherent:
 * a chunk is "cached" iff BOTH its parse-cache shard and its durable shards
 * exist; a quarantined chunk — no parse-cache shard — drops its durable subdir
 * here and re-dispatches next run). Only subdirs with ≥1 shard are indexed
 * (mirrors `saveParseCache`'s written-keys discipline — never vouch for a chunk
 * hash with no backing shard). The index write is tmp+rename atomic.
 */
export const pruneAndSaveDurableParsedFileStore = async (
  durableDir: string,
  version: string,
  keepKeys: ReadonlySet<string>,
): Promise<void> => {
  let entries: string[];
  try {
    entries = await fs.readdir(durableDir);
  } catch {
    return; // nothing written this run
  }
  const survivors: string[] = [];
  for (const name of entries) {
    if (name === DURABLE_INDEX_FILENAME) continue;
    const full = path.join(durableDir, name);
    if (keepKeys.has(name)) {
      try {
        const shards = (await fs.readdir(full)).filter((f) => f.endsWith('.json'));
        if (shards.length > 0) {
          survivors.push(name);
          continue;
        }
      } catch {
        /* not a readable dir → drop below */
      }
    }
    await fs.rm(full, { recursive: true, force: true });
  }
  const idx: DurableParsedFileIndex = { version, keys: survivors };
  const tmp = path.join(durableDir, `${DURABLE_INDEX_FILENAME}.tmp`);
  await fs.mkdir(durableDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(idx), 'utf-8');
  await fs.rename(tmp, path.join(durableDir, DURABLE_INDEX_FILENAME));
};
