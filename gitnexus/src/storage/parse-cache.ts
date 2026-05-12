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
const SCHEMA_BUMP = 1;
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

const CACHE_FILENAME = 'parse-cache.json';

/** On-disk shape. */
interface ParseCacheFile {
  version: string;
  /** key = chunk hash (hex) → cached chunk result list. */
  entries: Record<string, ParseWorkerResult[]>;
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
export const computeChunkHash = (
  entries: Array<{ filePath: string; contentHash: string }>,
): string => {
  const sorted = [...entries].sort((a, b) => (a.filePath < b.filePath ? -1 : 1));
  const joined = sorted.map((e) => `${e.filePath}:${e.contentHash}`).join('\n');
  return sha256Hex(joined);
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

const mapReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) return { [MAP_TAG]: Array.from(value.entries()) };
  if (value instanceof Set) return { [SET_TAG]: Array.from(value.values()) };
  return value;
};

const mapReviver = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v[MAP_TAG])) return new Map(v[MAP_TAG] as [unknown, unknown][]);
    if (Array.isArray(v[SET_TAG])) return new Set(v[SET_TAG] as unknown[]);
  }
  return value;
};

/**
 * Load the parse cache. Returns an empty cache on any failure (missing
 * file, corrupt JSON, version mismatch). Never throws on a normal load.
 */
export const loadParseCache = async (storagePath: string): Promise<ParseCache> => {
  const cachePath = path.join(storagePath, CACHE_FILENAME);
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
      return emptyCache();
    }
    const entries = new Map<string, ParseWorkerResult[]>();
    for (const [k, v] of Object.entries(data.entries)) {
      if (Array.isArray(v)) entries.set(k, v as ParseWorkerResult[]);
    }
    return { version: PARSE_CACHE_VERSION, entries, usedKeys: new Set<string>() };
  } catch {
    return emptyCache();
  }
};

/**
 * Persist the cache to disk atomically (write-and-rename) so a crash
 * mid-write doesn't leave a corrupt file.
 */
export const saveParseCache = async (storagePath: string, cache: ParseCache): Promise<void> => {
  await fs.mkdir(storagePath, { recursive: true });
  const cachePath = path.join(storagePath, CACHE_FILENAME);
  const tmpPath = `${cachePath}.tmp`;
  const out: ParseCacheFile = {
    version: cache.version,
    entries: Object.fromEntries(cache.entries),
  };
  // Compact JSON; this file can be tens of MB on a large repo and pretty-
  // printing roughly doubles size for no value.
  await fs.writeFile(tmpPath, JSON.stringify(out, mapReplacer), 'utf-8');
  await fs.rename(tmpPath, cachePath);
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
  return removed;
};

const emptyCache = (): ParseCache => ({
  version: PARSE_CACHE_VERSION,
  entries: new Map<string, ParseWorkerResult[]>(),
  usedKeys: new Set<string>(),
});
