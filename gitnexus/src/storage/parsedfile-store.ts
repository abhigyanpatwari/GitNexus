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
 * `<storagePath>/parsedfile-store/<shardId>.v8` — one shard per parse chunk,
 * a V8 envelope of `ParsedFile[]` (Scope.bindings / Scope.typeBindings stay
 * `Map`s). The store is cleared at the start of each parse and after
 * scope-resolution consumes it, so it never lingers and never goes stale
 * across runs.
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
 * version-tied via `PARSE_CACHE_VERSION`). On a warm hit the chunk's immutable
 * durable shards are hardlinked (or atomically copied) into the run store after
 * their envelope metadata proves complete coverage. That pins a stable snapshot
 * before workers are skipped, even when another branch refreshes the shared
 * durable directory concurrently.
 */

import { promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import type {
  CallableFlowSite,
  ParsedFile,
  ReferenceSite,
  SymbolDefinition,
} from 'gitnexus-shared';
import { isValidReceiverChain } from '../core/ingestion/utils/receiver-chain-codec.js';
import { logger } from '../core/logger.js';
import { mapReviver } from './parse-cache.js';
import { linkOrCopyFile } from './fs-atomic.js';
import {
  inspectV8Cache,
  tryLoadV8Cache,
  writeV8CacheFile,
  writeV8CacheFileSync,
} from './v8-sidecar.js';

const STORE_DIRNAME = 'parsedfile-store';
const DURABLE_DIRNAME = 'parsedfile-cache';
const DURABLE_INDEX_FILENAME = 'index.json';
const MAX_CALLABLE_FLOW_SITES_PER_FILE = 100_000;
const MAX_CALLABLE_FLOW_INDIRECTION = 16;
const MAX_CALLABLE_FLOW_NAME_LENGTH = 4_096;
const MAX_CALLABLE_FLOW_PARAMETERS = 1_024;

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

const isV8ShardName = (name: string): boolean => name.endsWith('.v8') && !name.includes('.v8.');

const shardPath = (storagePath: string, shardId: string): string =>
  path.join(getParsedFileStoreDir(storagePath), `${shardId}.v8`);

const shardFilePaths = (parsedFiles: readonly ParsedFile[]): string[] =>
  parsedFiles.map((pf) => pf.filePath);

const LOAD_YIELD_EVERY_SHARDS = 128;

/**
 * Test seam for #3086. Production always calls {@link forceGc}; unit tests
 * replace `run` to count cadence without requiring `--expose-gc`.
 */
export const parsedFileLoadGc = {
  run: forceGc,
  /** V8 envelope bytes visited between GCs (#3086). Tests may lower this. */
  byteBudget: 128 * 1024 * 1024,
};

/**
 * Write one parse chunk's `ParsedFile[]` to the store as a single `.v8` shard.
 * No-op for an empty chunk. `shardId` must be unique within a run.
 */
export const persistParsedFileChunk = async (
  storagePath: string,
  shardId: string,
  parsedFiles: readonly ParsedFile[],
): Promise<boolean> => {
  if (parsedFiles.length === 0) return true;
  await fs.mkdir(getParsedFileStoreDir(storagePath), { recursive: true });
  return writeV8CacheFile(
    shardPath(storagePath, shardId),
    parsedFiles,
    shardFilePaths(parsedFiles),
  );
};

// Per-process set of store dirs we've already `mkdir`ed, so the sync worker
// writer (called once per job, many times into the same dir) doesn't issue a
// `mkdirSync` syscall on every shard. Mirrors parse-cache.ts's `createdCacheDirs`.
const createdStoreDirs = new Set<string>();

/**
 * Synchronous shard writer for use INSIDE a parse worker (#1983 parallel
 * serialization). Returns false on write failure so the worker can keep
 * ParsedFiles in the result instead of dropping them.
 */
export const persistParsedFileShardSync = (
  storagePath: string,
  shardId: string,
  parsedFiles: readonly ParsedFile[],
): boolean => {
  if (parsedFiles.length === 0) return true;
  const dir = getParsedFileStoreDir(storagePath);
  if (!createdStoreDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    createdStoreDirs.add(dir);
  }
  return writeV8CacheFileSync(
    shardPath(storagePath, shardId),
    parsedFiles,
    shardFilePaths(parsedFiles),
  );
};

const listV8Shards = async (dir: string): Promise<string[]> => {
  try {
    return (await fs.readdir(dir)).filter(isV8ShardName).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

export const loadParsedFilesForPaths = async (
  storagePath: string,
  wantPaths: ReadonlySet<string>,
): Promise<Map<string, ParsedFile>> => {
  const out = new Map<string, ParsedFile>();
  if (wantPaths.size === 0) return out;
  const shardPaths = await listV8Shards(getParsedFileStoreDir(storagePath));
  const pool = new Map<string, string>();
  let droppedSites = 0;
  let filesWithDroppedSites = 0;
  let droppedChains = 0;
  let rejectedFiles = 0;
  let bytesSinceGc = 0;
  let shardsSinceYield = 0;
  const maybeYieldAndGc = async (forceByteGc: boolean): Promise<void> => {
    if (forceByteGc) {
      parsedFileLoadGc.run();
      bytesSinceGc = 0;
      shardsSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    shardsSinceYield++;
    if (shardsSinceYield >= LOAD_YIELD_EVERY_SHARDS) {
      shardsSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  for (const shardFull of shardPaths) {
    const loaded = await tryLoadV8Cache(shardFull, pool, wantPaths);
    if (loaded === undefined) {
      await maybeYieldAndGc(false);
      continue;
    }
    if (loaded.kind === 'skip') {
      bytesSinceGc += loaded.bytes;
      await maybeYieldAndGc(bytesSinceGc >= parsedFileLoadGc.byteBudget);
      continue;
    }
    bytesSinceGc += loaded.bytes;
    const parsed = Array.isArray(loaded.value) ? (loaded.value as ParsedFile[]) : undefined;
    const crossedBudget = bytesSinceGc >= parsedFileLoadGc.byteBudget;
    if (Array.isArray(parsed)) {
      for (const pf of parsed) {
        if (!pf || typeof pf.filePath !== 'string' || !wantPaths.has(pf.filePath)) continue;
        const flow = sanitizeCallableFlowSites(pf.callableFlowSites);
        if (flow === undefined) {
          rejectedFiles++;
          continue;
        }
        const chains = sanitizeReceiverChains(pf.referenceSites);
        if (chains === undefined) {
          rejectedFiles++;
          continue;
        }
        if (flow.dropped === 0 && chains.dropped === 0) {
          out.set(pf.filePath, pf);
        } else {
          droppedSites += flow.dropped;
          droppedChains += chains.dropped;
          filesWithDroppedSites++;
          out.set(pf.filePath, {
            ...pf,
            ...(flow.dropped === 0 ? {} : { callableFlowSites: flow.sites }),
            ...(chains.dropped === 0 ? {} : { referenceSites: chains.sites }),
          });
        }
      }
    }
    await maybeYieldAndGc(crossedBudget);
  }
  if (droppedSites > 0 || droppedChains > 0) {
    logger.warn(
      { droppedSites, droppedChains, files: filesWithDroppedSites },
      'parsedfile-store: dropped malformed/over-bound sites at load; files retained without those facts',
    );
  }
  if (rejectedFiles > 0) {
    logger.warn(
      { rejectedFiles },
      'parsedfile-store: rejected shard entries at load (untrusted shape); those files re-extract every run',
    );
  }
  return out;
};

function sanitizeCallableFlowSites(
  value: unknown,
): { sites: readonly CallableFlowSite[] | undefined; dropped: number } | undefined {
  if (value === undefined) return { sites: undefined, dropped: 0 };
  if (!Array.isArray(value)) return undefined;
  const bounded =
    value.length > MAX_CALLABLE_FLOW_SITES_PER_FILE
      ? value.slice(0, MAX_CALLABLE_FLOW_SITES_PER_FILE)
      : value;
  const sites = bounded.filter(isValidCallableFlowSite);
  return { sites, dropped: value.length - sites.length };
}

/**
 * Untrusted-boundary handling for the compact `receiverChain` on a reference site.
 *
 * NARROWER than its sibling `sanitizeCallableFlowSites`, deliberately and worth
 * stating plainly: that function validates every element with a full type
 * predicate, whereas this one inspects only the `receiverChain` sub-field and, in
 * the common case where nothing was stripped, returns the original array typed as
 * `ReferenceSite[]` without structurally validating `name` / `kind` / `atRange`.
 * That is still a strict improvement — `referenceSites` had NO sanitation at all
 * before this — but it is not parity, and a future change that needs per-site
 * structural validation must add it rather than assume it is already here.
 *
 * Sanitation is per-FIELD, not per-site: a chain that does not decode is
 * stripped and the site is kept, because the site is still perfectly usable
 * through the text cascade — dropping the whole reference would turn a
 * degraded receiver into a missing edge. Only a non-array `referenceSites`
 * rejects the file, and `undefined` (a store written before this field
 * existed) passes through untouched, which is what makes an old shard load
 * without error.
 *
 * Returns the ORIGINAL array when nothing was stripped, so the overwhelmingly
 * common case allocates nothing on a hot warm-load path.
 */
function sanitizeReceiverChains(
  value: unknown,
): { sites: readonly ReferenceSite[] | undefined; dropped: number } | undefined {
  if (value === undefined) return { sites: undefined, dropped: 0 };
  if (!Array.isArray(value)) return undefined;

  let dropped = 0;
  for (const site of value) {
    if (
      isRecord(site) &&
      site.receiverChain !== undefined &&
      !isValidReceiverChain(site.receiverChain)
    )
      dropped++;
  }
  if (dropped === 0) return { sites: value as readonly ReferenceSite[], dropped: 0 };

  const sites = value.map((site) => {
    if (!isRecord(site) || site.receiverChain === undefined) return site;
    if (isValidReceiverChain(site.receiverChain)) return site;
    const { receiverChain: _dropped, ...rest } = site;
    return rest;
  }) as readonly ReferenceSite[];
  return { sites, dropped };
}

function isValidCallableFlowSite(value: unknown): value is CallableFlowSite {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'seed':
      return (
        isValidOperand(value.destination) &&
        isBoundedString(value.targetName) &&
        isOptionalBoundedString(value.targetQualifiedName) &&
        isValidRange(value.targetRange) &&
        isValidExpectedSignature(value.expectedSignature)
      );
    case 'copy':
    case 'alias':
    case 'address':
      return isValidOperand(value.source) && isValidOperand(value.destination);
    case 'store':
      return isValidOperand(value.source) && isValidOperand(value.pointer);
    case 'load':
      return isValidOperand(value.pointer) && isValidOperand(value.destination);
    case 'formal':
      return (
        isBoundedString(value.ownerName) &&
        isValidRange(value.ownerRange) &&
        isSafeIndex(value.parameterIndex) &&
        isValidOperand(value.binding) &&
        (value.passingMode === 'value' ||
          value.passingMode === 'reference' ||
          value.passingMode === 'pointer') &&
        isValidExpectedSignature(value.expectedSignature)
      );
    case 'argument':
      return (
        isValidRange(value.callSite) &&
        isSafeIndex(value.parameterIndex) &&
        isValidOperand(value.source) &&
        isOptionalBoundedString(value.directCalleeName)
      );
    case 'invoke':
      return (
        isValidRange(value.callSite) &&
        isBoundedString(value.inScope) &&
        isValidOperand(value.callee) &&
        (value.receiver === undefined || isValidOperand(value.receiver)) &&
        (value.invocationKind === 'indirect' ||
          value.invocationKind === 'member-pointer' ||
          value.invocationKind === 'callable-object') &&
        (value.arity === undefined || isSafeIndex(value.arity))
      );
    default:
      return false;
  }
}

function isValidOperand(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.name) &&
    isBoundedString(value.inScope) &&
    isValidRange(value.atRange) &&
    Number.isInteger(value.indirection) &&
    (value.indirection as number) >= 0 &&
    (value.indirection as number) <= MAX_CALLABLE_FLOW_INDIRECTION &&
    typeof value.addressOf === 'boolean' &&
    (value.expressionKind === undefined ||
      value.expressionKind === 'binding' ||
      value.expressionKind === 'callable-designator' ||
      value.expressionKind === 'bound-member' ||
      value.expressionKind === 'anonymous-callable') &&
    isOptionalBoundedString(value.qualifiedName)
  );
}

function isValidExpectedSignature(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    (value.parameterCount === undefined || isSafeIndex(value.parameterCount)) &&
    isValidBoundedStringArray(value.parameterTypes) &&
    (value.parameterTypeClasses === undefined ||
      (Array.isArray(value.parameterTypeClasses) &&
        value.parameterTypeClasses.length <= MAX_CALLABLE_FLOW_PARAMETERS &&
        value.parameterTypeClasses.every(isRecord))) &&
    (value.isConst === undefined || typeof value.isConst === 'boolean')
  );
}

function isValidBoundedStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_CALLABLE_FLOW_PARAMETERS &&
      // '' is a legitimate entry meaning "unknown type" — the same convention
      // as ReferenceSite.argumentTypes. C++ emits it for cv-qualifier-only or
      // ERROR-recovered parameter types, so requiring non-empty here rejected
      // real extractor output (#2522 review).
      value.every(
        (entry) => typeof entry === 'string' && entry.length <= MAX_CALLABLE_FLOW_NAME_LENGTH,
      ))
  );
}

function isValidRange(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.startLine) &&
    isNonNegativeInteger(value.startCol) &&
    isNonNegativeInteger(value.endLine) &&
    isNonNegativeInteger(value.endCol)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_CALLABLE_FLOW_NAME_LENGTH
  );
}

function isOptionalBoundedString(value: unknown): boolean {
  return value === undefined || isBoundedString(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafeIndex(value: unknown): boolean {
  return isNonNegativeInteger(value) && (value as number) <= MAX_CALLABLE_FLOW_PARAMETERS;
}

// ─── Durable, content-addressed sibling store (warm-cache coverage) ──────────
//
// Layout: `<durableDir>/<chunkHash>/<chunkHash>-w<tid>-<seq>.v8` plus a
// top-level `<durableDir>/index.json` that records each chunk hash's actual
// persisted file-path coverage. One subdir per chunk hash so a chunk's
// (possibly several) shards collect and prune as a unit. Warm hits snapshot
// these files into the run store before worker dispatch is skipped.

interface DurableParsedFileIndex {
  version: string;
  entries: Record<string, string[]>;
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

/**
 * Synchronous durable-shard writer for use INSIDE a parse worker, alongside
 * {@link persistParsedFileShardSync}. Writes the SAME bytes to a content-addressed
 * durable location keyed by the parse chunk hash so a future warm hit can reuse
 * them. `chunkHash`+`threadId`+`shardSeq` is collision-free across the
 * N-shards-per-chunk fan-out and across worker-death retries — the same
 * uniqueness that makes the run-scoped `w<tid>-<seq>` name safe, prefixed by
 * content. No-op for an empty chunk.
 */

const createdDurableDirs = new Set<string>();

export const persistDurableParsedFileShardSync = (
  durableDir: string,
  chunkHash: string,
  threadId: number,
  shardSeq: number,
  parsedFiles: readonly ParsedFile[],
): boolean => {
  if (parsedFiles.length === 0) return true;
  const dir = durableChunkDir(durableDir, chunkHash);
  if (!createdDurableDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    createdDurableDirs.add(dir);
  }
  const dest = path.join(dir, `${chunkHash}-w${threadId}-${shardSeq}.v8`);
  return writeV8CacheFileSync(dest, parsedFiles, shardFilePaths(parsedFiles));
};

/**
 * Validate and snapshot one durable chunk into the run store. Every envelope
 * must be runtime-compatible and integrity-valid, and together they must match
 * the path coverage recorded when the durable index was published. Linking
 * before returning pins the inodes against concurrent branch-cache rotation.
 */
export const durableChunkHasShards = async (
  runStoragePath: string,
  chunkHash: string,
  expectedPaths: ReadonlySet<string>,
): Promise<boolean> => {
  const sourceDir = durableChunkDir(getDurableParsedFileDir(runStoragePath), chunkHash);
  const shards = await listV8Shards(sourceDir);
  if (shards.length === 0 || expectedPaths.size === 0) return false;

  const runDir = getParsedFileStoreDir(runStoragePath);
  try {
    await fs.mkdir(runDir, { recursive: true });
  } catch {
    return false;
  }
  const restored: string[] = [];
  const covered = new Set<string>();
  const rollback = async (): Promise<boolean> => {
    await Promise.all(restored.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    return false;
  };

  for (const sourcePath of shards) {
    const name = path.basename(sourcePath);
    const destinationPath = path.join(runDir, name);
    try {
      await linkOrCopyFile(sourcePath, destinationPath);
      restored.push(destinationPath);
    } catch {
      return rollback();
    }
    const inspected = await inspectV8Cache(destinationPath);
    if (!inspected) return rollback();
    for (const filePath of inspected.paths) {
      if (!expectedPaths.has(filePath)) return rollback();
      covered.add(filePath);
    }
  }

  if (covered.size !== expectedPaths.size) return rollback();
  return true;
};

export const loadDurableParsedFileIndex = async (
  durableDir: string,
  expectedVersion: string,
): Promise<Map<string, ReadonlySet<string>>> => {
  try {
    const raw = await fs.readFile(path.join(durableDir, DURABLE_INDEX_FILENAME), 'utf-8');
    const idx: unknown = JSON.parse(raw);
    if (!isRecord(idx) || idx.version !== expectedVersion || !isRecord(idx.entries)) {
      return new Map();
    }
    const entries = new Map<string, ReadonlySet<string>>();
    for (const [key, paths] of Object.entries(idx.entries)) {
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.some((filePath) => typeof filePath !== 'string')
      ) {
        return new Map();
      }
      entries.set(key, new Set(paths));
    }
    return entries;
  } catch {
    return new Map();
  }
};

/**
 * Prune the durable store to `keepKeys` and rewrite its index. `keepKeys` must
 * be the parse cache's surviving on-disk keys (so the two stores stay coherent:
 * a chunk is "cached" iff BOTH its parse-cache shard and its durable shards
 * exist; a quarantined chunk — no parse-cache shard — drops its durable subdir
 * here and re-dispatches next run). Only chunks whose envelopes all validate
 * are indexed, together with their exact persisted path coverage (never vouch
 * for a missing/corrupt shard). The index write is tmp+rename atomic.
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
  const survivors: Record<string, string[]> = {};
  for (const name of entries) {
    if (name === DURABLE_INDEX_FILENAME) continue;
    const full = path.join(durableDir, name);
    if (keepKeys.has(name)) {
      try {
        const shards = await listV8Shards(full);
        if (shards.length > 0) {
          const covered = new Set<string>();
          let valid = true;
          for (const shard of shards) {
            const inspected = await inspectV8Cache(shard);
            if (!inspected) {
              valid = false;
              break;
            }
            for (const filePath of inspected.paths) covered.add(filePath);
          }
          if (valid && covered.size > 0) {
            survivors[name] = [...covered].sort();
            continue;
          }
        }
      } catch {
        /* not a readable dir → drop below */
      }
    }
    await fs.rm(full, { recursive: true, force: true });
  }
  const idx: DurableParsedFileIndex = { version, entries: survivors };
  const tmp = path.join(durableDir, `${DURABLE_INDEX_FILENAME}.tmp`);
  await fs.mkdir(durableDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(idx), 'utf-8');
  await fs.rename(tmp, path.join(durableDir, DURABLE_INDEX_FILENAME));
};

/**
 * Overlay this run's staged durable ParsedFile chunks onto the live store,
 * then prune the live tree to `keepKeys`. Live chunks this run did not rewrite
 * (other branches, unused hashes) stay until prune. No-op overlay when the
 * staged dir is missing.
 */
export const mergeStagedDurableParsedFileStore = async (
  liveStoragePath: string,
  stagedStoragePath: string,
  version: string,
  keepKeys: ReadonlySet<string>,
): Promise<void> => {
  const liveDir = getDurableParsedFileDir(liveStoragePath);
  if (stagedStoragePath === liveStoragePath) {
    await pruneAndSaveDurableParsedFileStore(liveDir, version, keepKeys);
    return;
  }
  const stagedDir = getDurableParsedFileDir(stagedStoragePath);
  await fs.mkdir(liveDir, { recursive: true });
  let stagedEntries: string[] = [];
  try {
    stagedEntries = await fs.readdir(stagedDir);
  } catch {
    await pruneAndSaveDurableParsedFileStore(liveDir, version, keepKeys);
    return;
  }
  for (const name of stagedEntries) {
    if (name === DURABLE_INDEX_FILENAME) continue;
    const from = path.join(stagedDir, name);
    const to = path.join(liveDir, name);
    await replaceDurableChunkDir(from, to);
  }
  await pruneAndSaveDurableParsedFileStore(liveDir, version, keepKeys);
};

/** Move `from` onto `to` without deleting `to` until the new tree is in place. */
const replaceDurableChunkDir = async (from: string, to: string): Promise<void> => {
  try {
    await fs.rename(from, to);
    return;
  } catch {
    /* dest exists, or the rename is cross-device */
  }
  const backup = `${to}.replacing`;
  await fs.rm(backup, { recursive: true, force: true });
  let backedUp = false;
  try {
    await fs.rename(to, backup);
    backedUp = true;
  } catch {
    /* dest was missing */
  }
  try {
    try {
      await fs.rename(from, to);
    } catch {
      await fs.cp(from, to, { recursive: true });
      await fs.rm(from, { recursive: true, force: true });
    }
  } catch (err) {
    if (backedUp) {
      await fs.rm(to, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backup, to).catch(() => {});
    }
    throw err;
  }
  if (backedUp) {
    await fs.rm(backup, { recursive: true, force: true });
  }
};
