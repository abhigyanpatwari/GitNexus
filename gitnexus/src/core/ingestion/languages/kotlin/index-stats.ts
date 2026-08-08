/**
 * Build counter for the per-file-set Kotlin import-resolution index
 * (`getKotlinFileIndex` in `import-target.ts`).
 *
 * A "build" is a `WeakMap` cache MISS that materializes a fresh
 * `KotlinFileIndex` (O(files)). Mirrors `../python/index-stats.ts`: the counter
 * is always live rather than gated behind a profiling env var, because an index
 * build happens at most once per resolution run, so the single increment is
 * negligible and an unconditional counter avoids env-var load-order fragility
 * in tests.
 *
 * Used by `test/integration/kotlin-import-index-reuse.test.ts` to assert the
 * index is reused across imports (built once per run) rather than rebuilt per
 * import — the regression guard for the quadratic resolution this replaced.
 */

let INDEX_BUILDS = 0;

export function recordKotlinFileIndexBuild(): void {
  INDEX_BUILDS++;
}

export function getKotlinFileIndexBuildCount(): number {
  return INDEX_BUILDS;
}

export function resetKotlinFileIndexBuildCount(): void {
  INDEX_BUILDS = 0;
}
