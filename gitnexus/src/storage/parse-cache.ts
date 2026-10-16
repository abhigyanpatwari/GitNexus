/**
 * Chunk-level content-addressed parse cache.
 *
 * The pipeline always parses every file (correctness invariant: cross-file
 * resolution and downstream phases need full graph data). What this cache
 * does is skip the tree-sitter worker dispatch when a chunk's contents
 * haven't changed since the last run.
 *
 * Granularity: chunk-level. Files are assigned to a stable
 * `(language, hash(path) mod 128)` bucket, then packed to a 2 MiB (or
 * operator) byte budget *inside* that bucket. Membership does not depend
 * on worker count. Each chunk key binds the resolved parser identity and
 * sorted (filePath, contentHash) pairs, plus PDG identity/options when enabled.
 * A content edit invalidates only that file's pack; add/delete/rename only
 * the affected bucket.
 *
 * Why not per-file:
 * - Workers process sub-batches and emit aggregated `ParseWorkerResult`s.
 *   Splitting back to per-file would require reworking the worker contract.
 * - Chunk-level invalidation gives a useful speedup floor (98% on a single
 *   1-of-50 invalidated chunk) without touching the worker.
 *
 * `--force` still reuses content-addressed shards (it only rebuilds graph/FTS).
 * `useParseCache: false` reparses every file, writes a staging generation, and
 * publishes onto this cache only after a successful analysis.
 */

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { compareCodeUnits } from '../lib/utils.js';
import type { ParseCacheIdentity } from '../core/parse-cache-identity.js';
import type { ParseWorkerResult } from '../core/ingestion/workers/parse-worker.js';
import { copyV8CacheIfPresent, tryLoadV8Cache, writeV8CacheFile } from './v8-sidecar.js';

/** SHA-256 hex of a string or buffer (paths for bucket ids, contents for cache keys). */
const sha256Hex = (input: Buffer | string): string =>
  createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input) : input)
    .digest('hex');

/** Stable parse-cache bucket count (#3088). Membership changes are covered by the parser identity. */
export const PARSE_CACHE_BUCKET_COUNT = 128;

/** Bucket id for cache membership: `sha256(path) mod N` without IEEE-754 truncation. */
export const parseCacheBucketId = (filePath: string): number =>
  Number(BigInt(`0x${sha256Hex(filePath)}`) % BigInt(PARSE_CACHE_BUCKET_COUNT));

export type ParseCachePackFile = { path: string; size: number; language: string };

/**
 * Pack files into parse-cache chunks: group by (language, bucket id), sort
 * paths inside the group, then cut at `byteBudget`. Bucket visit order is
 * the lexicographic order of `${language}\\0${bucketId}` keys (deterministic,
 * independent of scan order and worker count).
 */
export const packParseCacheChunks = (
  files: readonly ParseCachePackFile[],
  byteBudget: number,
): string[][] => {
  const buckets = new Map<string, ParseCachePackFile[]>();
  for (const file of files) {
    const key = `${file.language}\0${parseCacheBucketId(file.path)}`;
    const list = buckets.get(key);
    if (list) list.push(file);
    else buckets.set(key, [file]);
  }
  const chunks: string[][] = [];
  for (const key of [...buckets.keys()].sort()) {
    const group = buckets.get(key)!;
    group.sort((a, b) => compareCodeUnits(a.path, b.path));
    let current: string[] = [];
    let bytes = 0;
    for (const file of group) {
      if (current.length > 0 && bytes + file.size > byteBudget) {
        chunks.push(current);
        current = [];
        bytes = 0;
      }
      current.push(file.path);
      bytes += file.size;
    }
    if (current.length > 0) chunks.push(current);
  }
  return chunks;
};

const LEGACY_CACHE_FILENAME = 'parse-cache.json';
const CACHE_DIRNAME = 'parse-cache';
/**
 * Per-run staging root for newly produced parse results. Parse-cache shards and the
 * ParsedFile stores write here so a crash cannot mix a new generation into the
 * live `.gitnexus/parse-cache` / `parsedfile-cache` trees. `saveParseCache`
 * publishes onto the live `storagePath` only after a successful analysis.
 */
export const COLD_PARSE_REBUILD_DIRNAME = 'parse-rebuild';

/** Deterministic staging path — tests only. Production uses {@link createColdParseRebuildDir}. */
export const getColdParseRebuildDir = (storagePath: string): string =>
  path.join(storagePath, COLD_PARSE_REBUILD_DIRNAME);

/**
 * Unique per analyze process so concurrent `--no-parse-cache` runs on
 * different branch slots (shared `.gitnexus`, separate index locks) do not
 * delete each other's staging tree.
 */
export const createColdParseRebuildDir = async (storagePath: string): Promise<string> => {
  await fs.mkdir(storagePath, { recursive: true });
  return fs.mkdtemp(path.join(storagePath, `${COLD_PARSE_REBUILD_DIRNAME}.`));
};
const CACHE_INDEX_FILENAME = 'index.json';

/** Keys on disk always come from `computeChunkHash` — 64-char lowercase hex. */
const CHUNK_CACHE_KEY_HEX_RE = /^[a-f0-9]{64}$/;

const isValidChunkCacheKey = (chunkHash: string): boolean => CHUNK_CACHE_KEY_HEX_RE.test(chunkHash);

/** On-disk shape for the legacy single-file format. */
interface ParseCacheFile {
  version: string;
  /** key = chunk hash (hex) → cached chunk result list. */
  entries: Record<string, ParseWorkerResult[]>;
}

/** On-disk shape for the sharded directory format. */
interface ShardedParseCacheIndex {
  version: string;
  keys: string[];
}

/** Runtime view: keyed Map for fast lookup; mutated in place during a run. */
export interface ParseCache {
  identity: ParseCacheIdentity;
  entries: Map<string, ParseWorkerResult[]>;
  /**
   * Hashes referenced (hit OR miss-and-stored) by the current run.
   * The parse phase populates this as it processes chunks; the orchestrator
   * uses it as input to `pruneCache` before saving so entries that no
   * longer correspond to any chunk in the current scan are discarded.
   * Transient — never serialized to disk.
   */
  usedKeys: Set<string>;
  /**
   * Hashes this run decided it cannot vouch for — its durable generation could
   * not be reset, or its chunk was worker-quarantined (#3204). `saveParseCache`
   * refuses them, so neither a pre-existing `.v8` nor the chunk's durable
   * directory survives into the next run. Kept separate from `usedKeys`
   * because the orchestrator re-adds keys to that set after the parse phase
   * (#2106 sibling fold), which would undo a deletion.
   * Transient — never serialized to disk.
   */
  staleKeys?: Set<string>;
  /** Live generation used for compatible cache reads. */
  storagePath?: string;
  /** Run-owned generation receiving newly produced or repaired shards. */
  writeStoragePath?: string;
  /** Keys admitted by the identity-validated live index. */
  onDiskKeys?: Set<string>;
  /** Keys successfully written beneath writeStoragePath in this run. */
  stagedKeys?: Set<string>;
}

/** Stable hash of a single file's contents — used by callers to compose a chunk hash. */
export const fileContentHash = (content: Buffer | string): string => sha256Hex(content);

/**
 * Compute the canonical cache key for a chunk's contents.
 *
 * `entries` is the list of (filePath, file content hash) for every file
 * in the chunk. We sort by filePath before hashing so chunks composed of
 * the same files in different order produce the same key.
 */
/** PDG/CFG cache namespace (#2081 M1) — every input that changes the
 *  WORKER-EMITTED `cfgSideChannel` must be folded into the chunk key, and
 *  ONLY those. The classification test for a future option: does the worker
 *  see it (workerData) and does it change the bytes the worker writes to the
 *  shard? `pdgMaxEdgesPerFunction` famously fails that test — it is applied
 *  at EMIT time on the main thread (scope-resolution run.ts), the worker
 *  never receives it, and the cached output is byte-identical across cap
 *  values; folding it in (as a prior review round did) only forced a
 *  spurious full re-parse on every cap change (#2099 F3). Options that
 *  change the PERSISTED GRAPH but not the shard belong in the RepoMeta pdg
 *  stamp (incremental-eligibility), not here. */
export interface PdgCacheKey {
  readonly pdg?: boolean;
  /** Per-function source-line cap (changes WHICH functions get a CFG —
   *  applied in the worker, so it shapes the cached shard). Callers must
   *  pass the RESOLVED value (the production call site in parse-impl.ts
   *  applies the worker's default before folding) so an explicit-default
   *  run shares the default run's keys — this function folds whatever it
   *  is given verbatim. */
  readonly maxFunctionLines?: number;
}

export const computeChunkHash = (
  entries: Array<{ filePath: string; contentHash: string }>,
  identity: ParseCacheIdentity,
  pdg: boolean | PdgCacheKey = false,
): string => {
  const sorted = [...entries].sort((a, b) => compareCodeUnits(a.filePath, b.filePath));
  const opts: PdgCacheKey = typeof pdg === 'boolean' ? { pdg } : pdg;
  // JSON framing avoids ambiguous path/content delimiters. Every
  // physical shard address binds the base identity; extraction-only changes
  // affect PDG keys without evicting ordinary parsing results.
  const components: unknown[] = ['gitnexus-parse-chunk-v1', identity.base];
  if (opts.pdg) {
    if (opts.maxFunctionLines === undefined) {
      throw new Error('PDG chunk keys require the resolved function-line cap');
    }
    components.push(identity.pdg, opts.maxFunctionLines);
  }
  components.push(sorted.map(({ filePath, contentHash }) => [filePath, contentHash]));
  return sha256Hex(JSON.stringify(components));
};

/**
 * JSON replacer that round-trips Map/Set instances through plain JSON.
 *
 * `ParseWorkerResult.parsedFiles[*].scopes[*].typeBindings` is a
 * `ReadonlyMap<string, TypeRef>`; without this transform it serializes
 * to `{}` and downstream code that iterates / `.get()`s on it crashes
 * with "is not iterable". Applied symmetrically by `mapReviver` on
 * load so the in-memory shape stays Map-typed.
 */
const MAP_TAG = '__$mapEntries$__';
const SET_TAG = '__$setValues$__';

export const mapReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) return { [MAP_TAG]: Array.from(value.entries()) };
  if (value instanceof Set) return { [SET_TAG]: Array.from(value.values()) };
  return value;
};

export const mapReviver = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v[MAP_TAG])) return new Map(v[MAP_TAG] as [unknown, unknown][]);
    if (Array.isArray(v[SET_TAG])) return new Set(v[SET_TAG] as unknown[]);
  }
  return value;
};

const getLegacyCachePath = (storagePath: string): string =>
  path.join(storagePath, LEGACY_CACHE_FILENAME);

const getCacheDirPath = (storagePath: string): string => path.join(storagePath, CACHE_DIRNAME);

const getCacheIndexPath = (storagePath: string): string =>
  path.join(getCacheDirPath(storagePath), CACHE_INDEX_FILENAME);

const getCacheChunkPath = (storagePath: string, chunkHash: string): string =>
  path.join(getCacheDirPath(storagePath), `${chunkHash}.v8`);

/**
 * Drop fields that are not replayed by `mergeChunkResults` / parse-impl after
 * RING4-1 (#942). Shrinks on-disk shards and peak RSS during cold runs.
 */
export const slimParseWorkerResultsForCache = (
  chunkResults: readonly ParseWorkerResult[],
): ParseWorkerResult[] => {
  const slim: ParseWorkerResult[] = [];
  for (const result of chunkResults) {
    slim.push({
      ...result,
      calls: [],
      assignments: [],
      constructorBindings: [],
      parsedFiles: [],
      // #2112: a clone-safety skip list is per-run telemetry, not graph data —
      // replay ignores it. Drop it so it doesn't bloat the cached shard.
      skippedPaths: [],
    });
  }
  return slim;
};

const readParseCacheChunkFromDisk = async (
  storagePath: string,
  chunkHash: string,
): Promise<ParseWorkerResult[] | undefined> => {
  if (!isValidChunkCacheKey(chunkHash)) return undefined;
  try {
    const chunkPath = getCacheChunkPath(storagePath, chunkHash);
    const v8Hit = await tryLoadV8Cache(chunkPath);
    if (v8Hit?.kind === 'hit' && Array.isArray(v8Hit.value)) {
      return v8Hit.value as ParseWorkerResult[];
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/** Load one chunk shard. Does not retain it in `cache.entries`. */
export const loadParseCacheChunk = async (
  cache: ParseCache,
  chunkHash: string,
): Promise<ParseWorkerResult[] | undefined> => {
  const inMemory = cache.entries.get(chunkHash);
  if (inMemory !== undefined) return inMemory;
  if (cache.writeStoragePath && cache.stagedKeys?.has(chunkHash)) {
    return readParseCacheChunkFromDisk(cache.writeStoragePath, chunkHash);
  }
  if (cache.storagePath && cache.onDiskKeys?.has(chunkHash)) {
    return readParseCacheChunkFromDisk(cache.storagePath, chunkHash);
  }
  return undefined;
};

/**
 * Cache directories already created this process. `persistParseCacheChunk` runs
 * once per cache-miss chunk; without this guard every miss re-issues a redundant
 * `mkdir` syscall (hundreds on a large cold repo) (#1983). Storage paths are
 * process-scoped, so the Set stays bounded.
 */
const createdCacheDirs = new Set<string>();

/** Drop the mkdir memo after the staging tree is wiped so the next persist recreates it. */
export const forgetCreatedParseCacheDir = (storagePath: string): void => {
  createdCacheDirs.delete(getCacheDirPath(storagePath));
};

/**
 * Persist one chunk shard and avoid retaining it in RAM for the rest of the
 * run. Falls back to `cache.entries` when `writeStoragePath` is unset (unit tests).
 */
export const persistParseCacheChunk = async (
  cache: ParseCache,
  chunkHash: string,
  chunkResults: readonly ParseWorkerResult[],
): Promise<void> => {
  const slim = slimParseWorkerResultsForCache(chunkResults);
  if (cache.writeStoragePath) {
    const cacheDir = getCacheDirPath(cache.writeStoragePath);
    if (!createdCacheDirs.has(cacheDir)) {
      await fs.mkdir(cacheDir, { recursive: true });
      createdCacheDirs.add(cacheDir);
    }
    const chunkPath = getCacheChunkPath(cache.writeStoragePath, chunkHash);
    let ok = await writeV8CacheFile(chunkPath, slim);
    if (!ok) {
      await fs.mkdir(cacheDir, { recursive: true });
      createdCacheDirs.add(cacheDir);
      ok = await writeV8CacheFile(chunkPath, slim);
    }
    if (!ok) {
      cache.entries.set(chunkHash, slim);
      return;
    }
    cache.stagedKeys ??= new Set<string>();
    cache.stagedKeys.add(chunkHash);
    cache.entries.delete(chunkHash);
    return;
  }
  cache.entries.set(chunkHash, slim);
};

/**
 * Retire a chunk this run cannot vouch for — its durable ParsedFile generation
 * could not be reset, or its chunk was worker-quarantined (#3204).
 *
 * `saveParseCache` refuses a stale key, so no pre-existing `.v8` is copied
 * forward and the durable store — pruned to exactly the keys that save
 * returns — drops the chunk in the same step. Clear all lookup sets because
 * `loadParseCacheChunk` reads `entries`, `stagedKeys` and `onDiskKeys` without consulting
 * `staleKeys`: otherwise a second lookup of the same hash inside this run
 * would still serve the retired shard.
 */
export const markParseCacheChunkStale = (cache: ParseCache, chunkHash: string): void => {
  cache.staleKeys ??= new Set<string>();
  cache.staleKeys.add(chunkHash);
  cache.entries.delete(chunkHash);
  cache.onDiskKeys?.delete(chunkHash);
  cache.stagedKeys?.delete(chunkHash);
};

const loadLegacyParseCache = async (
  storagePath: string,
  identity: ParseCacheIdentity,
  writeStoragePath: string,
): Promise<ParseCache> => {
  const cachePath = getLegacyCachePath(storagePath);
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const data = JSON.parse(raw, mapReviver) as ParseCacheFile;
    if (
      typeof data !== 'object' ||
      data === null ||
      data.version !== identity.base ||
      typeof data.entries !== 'object' ||
      data.entries === null
    ) {
      return emptyParseCache(identity, { storagePath, writeStoragePath });
    }
    const entries = new Map<string, ParseWorkerResult[]>();
    for (const [k, v] of Object.entries(data.entries)) {
      if (Array.isArray(v)) entries.set(k, v as ParseWorkerResult[]);
    }
    return { ...emptyParseCache(identity, { storagePath, writeStoragePath }), entries };
  } catch {
    return emptyParseCache(identity, { storagePath, writeStoragePath });
  }
};

const loadShardedParseCache = async (
  storagePath: string,
  identity: ParseCacheIdentity,
  writeStoragePath: string,
): Promise<ParseCache | null> => {
  const indexPath = getCacheIndexPath(storagePath);
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const data = JSON.parse(raw) as ShardedParseCacheIndex;
    if (
      typeof data !== 'object' ||
      data === null ||
      data.version !== identity.base ||
      !Array.isArray(data.keys)
    ) {
      return emptyParseCache(identity, { storagePath, writeStoragePath });
    }

    const onDiskKeys = new Set<string>();
    for (const chunkHash of data.keys) {
      if (typeof chunkHash === 'string' && isValidChunkCacheKey(chunkHash)) {
        onDiskKeys.add(chunkHash);
      }
    }

    // Lazy: index only — load individual shards on cache hit (#1983).
    return {
      identity,
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(),
      storagePath,
      writeStoragePath,
      onDiskKeys,
      stagedKeys: new Set<string>(),
    };
  } catch {
    return null;
  }
};

/**
 * Load the parse cache. Returns an empty cache on any failure (missing
 * file, corrupt JSON, version mismatch). Never throws on a normal load.
 */
export const loadParseCache = async (
  storagePath: string,
  identity: ParseCacheIdentity,
  writeStoragePath: string,
): Promise<ParseCache> => {
  const sharded = await loadShardedParseCache(storagePath, identity, writeStoragePath);
  if (sharded) return sharded;
  return loadLegacyParseCache(storagePath, identity, writeStoragePath);
};

/**
 * Persist the cache to disk using a temp directory + rename.
 *
 * Writes shards under `${cacheDir}.tmp`, then removes the old `cacheDir` and
 * renames the temp directory into place. There is a crash window after
 * `rm(cacheDir)` and before `rename(tmpDir, cacheDir)` where no cache exists;
 * that is acceptable — `loadParseCache` yields empty and the next run
 * reparses. This is not a single atomic swap of the whole tree, but avoids
 * leaving a half-written shard set visible to readers.
 */
export const saveParseCache = async (storagePath: string, cache: ParseCache): Promise<string[]> => {
  await fs.mkdir(storagePath, { recursive: true });
  const cacheDir = getCacheDirPath(storagePath);
  const tmpDir = `${cacheDir}.tmp`;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });

  // A stale key is dropped here rather than at the failure site: the
  // orchestrator folds sibling-branch keys back into `usedKeys` after the parse
  // phase (#2106), so this is the last point that sees the final key set. The
  // exclusion also reaches the durable store, which prunes to the keys this
  // function returns — both stores drop the chunk together (#3204).
  const keys = [...cache.usedKeys]
    .filter((key) => isValidChunkCacheKey(key) && !cache.staleKeys?.has(key))
    .sort();
  // Track hashes whose shard was actually written/copied this save. A hash can
  // be in `usedKeys` without a backing shard — its in-memory serialize threw, or
  // its on-disk copy failed/was-absent (e.g. a worker-quarantined chunk added to
  // usedKeys but never persisted). Writing such a hash into `index.keys` would
  // make the next load reference a shard that doesn't exist (#1983). Build the
  // index from what we persisted, not from the raw usedKeys snapshot.
  const writtenKeys: string[] = [];
  for (const chunkHash of keys) {
    const chunkPath = path.join(tmpDir, `${chunkHash}.v8`);
    const inMemory = cache.entries.get(chunkHash);
    if (inMemory !== undefined) {
      if (await writeV8CacheFile(chunkPath, inMemory)) {
        writtenKeys.push(chunkHash);
      }
      continue;
    }
    // A key is eligible only if this run produced it or the loaded index
    // admitted it under this base identity. Sibling metadata alone cannot
    // reclassify a foreign shard. Never fall back to live data for a missing
    // staged repair: that would publish mismatched worker/durable generations.
    const sourceRoot = cache.stagedKeys?.has(chunkHash)
      ? cache.writeStoragePath
      : cache.onDiskKeys?.has(chunkHash)
        ? cache.storagePath
        : undefined;
    if (sourceRoot === undefined) continue;
    const sourcePath = getCacheChunkPath(sourceRoot, chunkHash);
    if (await copyV8CacheIfPresent(sourcePath, chunkPath)) {
      writtenKeys.push(chunkHash);
    }
  }

  const index: ShardedParseCacheIndex = {
    version: cache.identity.base,
    keys: writtenKeys,
  };
  await fs.writeFile(path.join(tmpDir, CACHE_INDEX_FILENAME), JSON.stringify(index), 'utf-8');

  await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.rename(tmpDir, cacheDir);
  await fs.rm(getLegacyCachePath(storagePath), { force: true });
  // The authoritative final key set actually backed by a shard on disk.
  // Callers (the durable ParsedFile store) prune to exactly these so the two
  // content-addressed stores stay coherent — a chunk is cached iff BOTH have it.
  return writtenKeys;
};

/**
 * Drop entries whose hashes are not in `usedHashes`. Called at the end
 * of a run so chunks that no longer correspond to any current chunk
 * don't keep their stale entries forever.
 */
export const pruneCache = (cache: ParseCache, usedHashes: ReadonlySet<string>): number => {
  let removed = 0;
  for (const k of cache.entries.keys()) {
    if (!usedHashes.has(k)) {
      cache.entries.delete(k);
      removed++;
    }
  }
  if (cache.onDiskKeys) {
    for (const k of cache.onDiskKeys) {
      if (!usedHashes.has(k)) {
        cache.onDiskKeys.delete(k);
        removed++;
      }
    }
  }
  return removed;
};

export const emptyParseCache = (
  identity: ParseCacheIdentity,
  locations: { storagePath?: string; writeStoragePath?: string } = {},
): ParseCache => ({
  identity,
  entries: new Map<string, ParseWorkerResult[]>(),
  usedKeys: new Set<string>(),
  ...locations,
  onDiskKeys: locations.storagePath ? new Set<string>() : undefined,
  stagedKeys: locations.writeStoragePath ? new Set<string>() : undefined,
});
