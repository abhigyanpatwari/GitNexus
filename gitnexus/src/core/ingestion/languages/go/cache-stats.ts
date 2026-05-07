let hits = 0;
let misses = 0;

export function recordGoCacheHit(): void {
  hits++;
}
export function recordGoCacheMiss(): void {
  misses++;
}

export function getGoCaptureCacheStats(): { readonly hits: number; readonly misses: number } {
  return { hits, misses };
}

export function resetGoCaptureCacheStats(): void {
  hits = 0;
  misses = 0;
}
