/**
 * Build counter for the per-file-set Python import-resolution index
 * (`getPythonFileIndex` in `import-target.ts`).
 *
 * A "build" is a `WeakMap` cache MISS that materializes a fresh
 * `PythonFileIndex` (O(files)). Unlike `cache-stats.ts` (which gates its
 * counters behind `PROF_SCOPE_RESOLUTION` because they sit on the per-capture
 * hot path), this counter is always live: an index build happens at most once
 * per resolution run, so the single increment is negligible and an unconditional
 * counter avoids env-var load-order fragility in tests.
 *
 * Used by `test/integration/python-import-index-reuse.test.ts` to assert the
 * index is reused across imports (built once per run) rather than rebuilt per
 * import — the regression guard for PR #1918 review finding P1.
 */

let INDEX_BUILDS = 0;

export function recordPythonFileIndexBuild(): void {
  INDEX_BUILDS++;
}

export function getPythonFileIndexBuildCount(): number {
  return INDEX_BUILDS;
}

export function resetPythonFileIndexBuildCount(): void {
  INDEX_BUILDS = 0;
}
