/**
 * Chunk-level content-addressed parse cache.
 *
 * The pipeline always parses every file (correctness invariant: cross-file
 * resolution and downstream phases need full graph data). What this cache
 * does is skip the tree-sitter worker dispatch when a chunk's contents
 * haven't changed since the last run.
 *
 * Granularity: chunk-level. The parse phase chunks files into ~20MB byte
 * budgets. The cache key is `sha256(joined(filePath:contentHash for each
 * file in the chunk, sorted))`. A change to a single file invalidates only
 * that file's chunk — typically 1 of ~50 chunks on a 1000-file repo.
 *
 * Why not per-file:
 * - Workers process sub-batches and emit aggregated `ParseWorkerResult`s.
 *   Splitting back to per-file would require reworking the worker contract.
 * - Chunk-level invalidation gives a useful speedup floor (98% on a single
 *   1-of-50 invalidated chunk) without touching the worker.
 *
 * Survives `--force` because it's content-addressed: the same bytes always
 * produce the same key. `--force` only matters for the LadybugDB writeback;
 * the cache itself is always safe to reuse.
 */

import { createHash } from 'crypto';
import { createRequire } from 'module';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ParseWorkerResult } from '../core/ingestion/workers/parse-worker.js';

/**
 * Cache version composed of:
 *   - A schema bump knob (`SCHEMA_BUMP`) for hand-controlled invalidation
 *     when ParseWorkerResult shape or upstream parse semantics change.
 *   - The current `gitnexus` npm package version, read at module load.
 *     Any release that ships an updated tree-sitter grammar or revised
 *     extractor logic implies a version bump in package.json, which
 *     automatically invalidates the on-disk cache. Without this, a user
 *     running `npm i -g gitnexus@latest` after a parser-affecting
 *     release would silently replay pre-upgrade ParseWorkerResults
 *     against the new graph schema (Bugbot/Claude review on #1479).
 *
 * On version mismatch, `loadParseCache` returns an empty cache and the
 * next save overwrites the on-disk file with the new version baked in.
 */
// Bumped to 4 in #1983: on-disk parse-cache shards omit legacy DAG fields
// (`calls`, `assignments`, `constructorBindings`) unused after RING4-1 (#942)
// and the worker `parsedFiles` (the worker writes those to the disk ParsedFile
// store instead). #2038 added a DURABLE, content-addressed ParsedFile store
// (`parsedfile-cache/`, see parsedfile-store.ts) keyed by chunk hash that
// mirrors THIS cache's lifecycle — version-gated by PARSE_CACHE_VERSION, pruned
// in lockstep to the surviving keys. On a warm parse-cache hit the chunk's
// ParsedFiles are restored from it, so scope-resolution does NOT re-extract on
// the main thread (the #1983 OOM). Because the two stores share this version,
// any future change to the `ParsedFile` serialization shape MUST bump
// SCHEMA_BUMP so both invalidate in lockstep.
const SCHEMA_BUMP = 8; // #2288: ParseWorkerResult gained `springTypes` (Spring interface-inheritance) + `decoratorRoutes` semantics changed (interface routes suppressed at extraction, inherited routes appended in parse-impl)
const GITNEXUS_PKG_VERSION = (() => {
  try {
    // package.json sits at gitnexus/package.json — two levels up from
    // gitnexus/src/storage/parse-cache.ts (or its dist/ equivalent).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, '..', '..', 'package.json'), // src/storage → gitnexus/
      path.join(here, '..', '..', '..', 'package.json'), // dist/storage → gitnexus/
    ];
    const requireCJS = createRequire(import.meta.url);
    for (const c of candidates) {
      try {
        const pkg = requireCJS(c);
        if (typeof pkg?.version === 'string') return pkg.version;
      } catch {
        /* try next candidate */
      }
    }
  } catch {
    /* fall through to fallback */
  }
  return '0.0.0-unknown';
})();
export const PARSE_CACHE_VERSION = `${SCHEMA_BUMP}+${GITNEXUS_PKG_VERSION}`;

const LEGACY_CACHE_FILENAME = 'parse-cache.json';
const CACHE_DIRNAME = 'parse-cache';
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
  version: string;
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
   * When set, chunk payloads are loaded from / flushed to sharded files on
   * demand instead of retaining every chunk in `entries` for the whole run
   * (#1983 — Linux kernel OOM from duplicate in-memory cache + graph).
   */
  storagePath?: string;
  /** Index of chunk hashes known to exist under `storagePath/parse-cache/`. */
  onDiskKeys?: Set<string>;
}

/** SHA-256 hex of a single string or buffer. */
const sha256Hex = (input: Buffer | string): string =>
  createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input) : input)
    .digest('hex');

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
  pdg: boolean | PdgCacheKey = false,
): string => {
  const sorted = [...entries].sort((a, b) => (a.filePath < b.filePath ? -1 : 1));
  const joined = sorted.map((e) => `${e.filePath}:${e.contentHash}`).join('\n');
  const opts: PdgCacheKey = typeof pdg === 'boolean' ? { pdg } : pdg;
  // pdg-off path keeps its pre-#2081 chunk-KEY format verbatim. Note this does
  // NOT mean caches survive the M1 upgrade: SCHEMA_BUMP 4→5 changed
  // PARSE_CACHE_VERSION, and both loadParseCache (below) and the durable
  // parsedfile-store index hard-invalidate on it — every user pays one full
  // cold re-parse on upgrade regardless of --pdg. Keeping the key format
  // stable only means no SECOND invalidation class is introduced here.
  if (!opts.pdg) return sha256Hex(joined);
  // Fold the worker-visible --pdg configuration into the key: the boolean
  // plus `maxFunctionLines` (decides which functions get a CFG at all, in the
  // worker). Without it a warm chunk built under one cap is served to a run
  // with a different cap → a stale/under-built CFG: the #2038-class
  // option-blind-key trap. `def` marks an unset (default) value so two
  // default-cap runs share a key. The emit-time edge cap is deliberately
  // absent — see the PdgCacheKey doc comment.
  //
  // NAMESPACE VERSION (`pdg:5`): bumped when the worker-emitted
  // `cfgSideChannel` SHAPE changes for pdg-mode runs only — pdg:1→2 in #2083
  // M3 U1 (TsHarvester emits taint `sites` on StatementFacts); pdg:2→3 in the
  // #2227 follow-up U1 (every C-family / TS harvester now stamps the call-site
  // anchor `SiteRecord.at`, which the resolved-callee-id join reads); pdg:3→4 in
  // the #2227 tri-review-2 U4 (the Rust harvester now emits a `kind:'new'` site
  // for `struct_expression`, a new worker-output site the join consumes); pdg:4→5
  // in the FU-C call-summary soundness fix (the TS harvester now stamps
  // `BindingEntry.formalIndex` on param bindings so the PDG call-summary keys
  // return-flow on the enclosing FORMAL position, not the flattened binding
  // ordinal — a warm chunk lacking it would route the harvest to its conservative
  // empty-summary fallback). A warm chunk built by a worker predating the relevant
  // change carries a stale site shape, so the join skips it and
  // `BasicBlock.calleeIds` is silently empty (or missing the struct constructor)
  // even though `callees` is populated — exactly the #2225-class shape skew this
  // version token exists to prevent. Invalidates pdg-mode chunks and their durable
  // parsedfile-cache entries; flag-off chunk keys never reach this line and stay
  // byte-identical, so non-pdg users pay nothing. Deliberately NOT a SCHEMA_BUMP —
  // that gates the whole cache version and would force a full cold re-parse on
  // EVERY user (the M1 bump comment above records that cost).
  const ns = `pdg:5;maxFn=${opts.maxFunctionLines ?? 'def'}`;
  return sha256Hex(`${ns}\n${joined}`);
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
  path.join(getCacheDirPath(storagePath), `${chunkHash}.json`);

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
    const chunkRaw = await fs.readFile(getCacheChunkPath(storagePath, chunkHash), 'utf-8');
    const chunkData = JSON.parse(chunkRaw, mapReviver) as ParseWorkerResult[];
    return Array.isArray(chunkData) ? chunkData : undefined;
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

/**
 * Persist one chunk shard and avoid retaining it in RAM for the rest of the
 * run. Falls back to `cache.entries` when `storagePath` is unset (unit tests).
 */
export const persistParseCacheChunk = async (
  cache: ParseCache,
  chunkHash: string,
  chunkResults: readonly ParseWorkerResult[],
): Promise<void> => {
  const slim = slimParseWorkerResultsForCache(chunkResults);
  if (cache.storagePath) {
    const cacheDir = getCacheDirPath(cache.storagePath);
    if (!createdCacheDirs.has(cacheDir)) {
      await fs.mkdir(cacheDir, { recursive: true });
      createdCacheDirs.add(cacheDir);
    }
    const payload = JSON.stringify(slim, mapReplacer);
    await fs.writeFile(getCacheChunkPath(cache.storagePath, chunkHash), payload, 'utf-8');
    cache.onDiskKeys ??= new Set<string>();
    cache.onDiskKeys.add(chunkHash);
    cache.entries.delete(chunkHash);
    return;
  }
  cache.entries.set(chunkHash, slim);
};

const loadLegacyParseCache = async (storagePath: string): Promise<ParseCache> => {
  const cachePath = getLegacyCachePath(storagePath);
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const data = JSON.parse(raw, mapReviver) as ParseCacheFile;
    if (
      typeof data !== 'object' ||
      data === null ||
      data.version !== PARSE_CACHE_VERSION ||
      typeof data.entries !== 'object' ||
      data.entries === null
    ) {
      return emptyCache(storagePath);
    }
    const entries = new Map<string, ParseWorkerResult[]>();
    for (const [k, v] of Object.entries(data.entries)) {
      if (Array.isArray(v)) entries.set(k, v as ParseWorkerResult[]);
    }
    return { version: PARSE_CACHE_VERSION, entries, usedKeys: new Set<string>(), storagePath };
  } catch {
    return emptyCache(storagePath);
  }
};

const loadShardedParseCache = async (storagePath: string): Promise<ParseCache | null> => {
  const indexPath = getCacheIndexPath(storagePath);
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const data = JSON.parse(raw) as ShardedParseCacheIndex;
    if (
      typeof data !== 'object' ||
      data === null ||
      data.version !== PARSE_CACHE_VERSION ||
      !Array.isArray(data.keys)
    ) {
      return emptyCache(storagePath);
    }

    const onDiskKeys = new Set<string>();
    for (const chunkHash of data.keys) {
      if (typeof chunkHash === 'string' && isValidChunkCacheKey(chunkHash)) {
        onDiskKeys.add(chunkHash);
      }
    }

    // Lazy: index only — load individual shards on cache hit (#1983).
    return {
      version: PARSE_CACHE_VERSION,
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(),
      storagePath,
      onDiskKeys,
    };
  } catch {
    return null;
  }
};

/**
 * Load the parse cache. Returns an empty cache on any failure (missing
 * file, corrupt JSON, version mismatch). Never throws on a normal load.
 */
export const loadParseCache = async (storagePath: string): Promise<ParseCache> => {
  const sharded = await loadShardedParseCache(storagePath);
  if (sharded) return sharded;
  return loadLegacyParseCache(storagePath);
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

  const keys = [...cache.usedKeys].filter(isValidChunkCacheKey).sort();
  // Track hashes whose shard was actually written/copied this save. A hash can
  // be in `usedKeys` without a backing shard — its in-memory serialize threw, or
  // its on-disk copy failed/was-absent (e.g. a worker-quarantined chunk added to
  // usedKeys but never persisted). Writing such a hash into `index.keys` would
  // make the next load reference a shard that doesn't exist (#1983). Build the
  // index from what we persisted, not from the raw usedKeys snapshot.
  const writtenKeys: string[] = [];
  for (const chunkHash of keys) {
    const chunkPath = path.join(tmpDir, `${chunkHash}.json`);
    const inMemory = cache.entries.get(chunkHash);
    if (inMemory !== undefined) {
      let payload: string;
      try {
        payload = JSON.stringify(inMemory, mapReplacer);
      } catch {
        continue;
      }
      await fs.writeFile(chunkPath, payload, 'utf-8');
      writtenKeys.push(chunkHash);
      continue;
    }
    const existingPath = getCacheChunkPath(storagePath, chunkHash);
    try {
      await fs.copyFile(existingPath, chunkPath);
      writtenKeys.push(chunkHash);
    } catch {
      /* shard missing — skip; next run treats as cache miss */
    }
  }

  const index: ShardedParseCacheIndex = {
    version: cache.version,
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

const emptyCache = (storagePath?: string): ParseCache => ({
  version: PARSE_CACHE_VERSION,
  entries: new Map<string, ParseWorkerResult[]>(),
  usedKeys: new Set<string>(),
  storagePath,
  onDiskKeys: storagePath ? new Set<string>() : undefined,
});
