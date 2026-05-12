/**
 * Dev-mode counters for the cross-phase scope-captures parse cache
 * (Java mirror of `languages/csharp/cache-stats.ts`).
 *
 * Gated by `PROF_SCOPE_RESOLUTION=1`. Production builds fold every
 * increment into dead code via the module-level `PROF` constant, so
 * the hot path in `captures.ts` stays branch-free.
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

export function getJavaCaptureCacheStats(): { hits: number; misses: number } {
  return { hits: CACHE_HITS, misses: CACHE_MISSES };
}

export function resetJavaCaptureCacheStats(): void {
  CACHE_HITS = 0;
  CACHE_MISSES = 0;
}
