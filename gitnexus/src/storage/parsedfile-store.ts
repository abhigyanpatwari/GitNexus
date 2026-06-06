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
 */

import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { mapReplacer, mapReviver } from './parse-cache.js';

const STORE_DIRNAME = 'parsedfile-store';

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
const makeInterningReviver = (
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
