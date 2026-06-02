let hits = 0;
let misses = 0;

export function recordRustCacheHit(): void {
  hits++;
}
export function recordRustCacheMiss(): void {
  misses++;
}

export function getRustCaptureCacheStats(): { readonly hits: number; readonly misses: number } {
  return { hits, misses };
}

export function resetRustCaptureCacheStats(): void {
  hits = 0;
  misses = 0;
}
