/**
 * Dev-mode counters for the TypeScript cross-phase scope-captures parse cache.
 *
 * Gated by `PROF_SCOPE_RESOLUTION=1`. In production the module-level `PROF`
 * constant is `false` and V8 folds every increment site into dead code, so the
 * hot path in `captures.ts` stays branch-free.
 *
 * Extracted from `captures.ts` so the production hot-path module doesn't carry
 * a module-global counter and its reset/export surface.
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

export function getTypescriptCaptureCacheStats(): { hits: number; misses: number } {
  return { hits: CACHE_HITS, misses: CACHE_MISSES };
}

export function resetTypescriptCaptureCacheStats(): void {
  CACHE_HITS = 0;
  CACHE_MISSES = 0;
}
