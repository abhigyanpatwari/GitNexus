let hits = 0;
let misses = 0;

export function recordRubyCacheHit(): void {
  hits++;
}
export function recordRubyCacheMiss(): void {
  misses++;
}

export function getRubyCaptureCacheStats(): { readonly hits: number; readonly misses: number } {
  return { hits, misses };
}

export function resetRubyCaptureCacheStats(): void {
  hits = 0;
  misses = 0;
}
