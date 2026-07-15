/**
 * Capture-cache hit/miss counters for Solidity scope emission.
 */

let hits = 0;
let misses = 0;

export function recordCacheHit(): void {
  hits += 1;
}

export function recordCacheMiss(): void {
  misses += 1;
}

export function getSolidityCaptureCacheStats(): { hits: number; misses: number } {
  return { hits, misses };
}

export function resetSolidityCaptureCacheStats(): void {
  hits = 0;
  misses = 0;
}
