/**
 * Dev-mode (`PROF_SCOPE_RESOLUTION=1`) cache hit/miss counters for the
 * cross-phase scope-captures parse cache. A module-level `PROF` const folds
 * increments to dead code in production so `captures.ts` stays branch-free.
 * Mirror of `languages/swift/cache-stats.ts`.
 */

const PROF = process.env.PROF_SCOPE_RESOLUTION === '1';

let CACHE_HITS = 0;
let CACHE_MISSES = 0;

export function recordCacheHit(): void {
  if (PROF) CACHE_HITS++;
}

export function recordCacheMiss(): void {
  if (PROF) CACHE_MISSES++;
}

export function getDartCaptureCacheStats(): { hits: number; misses: number } {
  return { hits: CACHE_HITS, misses: CACHE_MISSES };
}

export function resetDartCaptureCacheStats(): void {
  CACHE_HITS = 0;
  CACHE_MISSES = 0;
}
