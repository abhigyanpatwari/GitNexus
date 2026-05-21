let hits = 0;
let misses = 0;

export function recordKotlinCacheHit(): void {
  hits += 1;
}

export function recordKotlinCacheMiss(): void {
  misses += 1;
}

export function getKotlinCaptureCacheStats(): { readonly hits: number; readonly misses: number } {
  return { hits, misses };
}

export function resetKotlinCaptureCacheStats(): void {
  hits = 0;
  misses = 0;
}
