/**
 * Parse Cache — content-addressed cache for per-file Tree-sitter parse results.
 * Keyed by SHA-256 of file content. Unchanged files skip re-parsing on subsequent runs.
 */

import type { ParseWorkerResult } from '../core/ingestion/workers/parse-worker.js';
import { sha256, loadJsonCache, saveJsonCache, deleteJsonCache } from './cache-io.js';

export const PARSE_CACHE_VERSION = 1;
const FILENAME = 'parse-cache.json';

export { sha256 as contentHash };

export interface ParseCacheEntry {
  hash: string;
  result: ParseWorkerResult;
}

export interface ParseCache {
  version: number;
  entries: Record<string, ParseCacheEntry>;
}

export function createEmptyCache(): ParseCache {
  return { version: PARSE_CACHE_VERSION, entries: {} };
}

export async function loadParseCache(storagePath: string): Promise<ParseCache> {
  return (await loadJsonCache<ParseCache>(storagePath, FILENAME, PARSE_CACHE_VERSION)) ?? createEmptyCache();
}

export const saveParseCache = (storagePath: string, cache: ParseCache) =>
  saveJsonCache(storagePath, FILENAME, cache);

export const deleteParseCache = (storagePath: string) =>
  deleteJsonCache(storagePath, FILENAME);

export function pruneCache(cache: ParseCache, currentPaths: Set<string>): number {
  let removed = 0;
  for (const key of Object.keys(cache.entries)) {
    if (!currentPaths.has(key)) {
      delete cache.entries[key];
      removed++;
    }
  }
  return removed;
}
