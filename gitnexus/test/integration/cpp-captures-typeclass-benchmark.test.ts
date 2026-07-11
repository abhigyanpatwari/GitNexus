/**
 * C++ capture-emit identifier-type-lookup scaling benchmark.
 *
 * Guards the #2432 fix: `emitCppScopeCaptures`'s identifier-argument type
 * lookups used to re-walk the AST per identifier — `isKnownEnumName` ran a
 * full-tree DFS for EVERY identifier argument of every call, and the
 * scope/parameter lookups re-scanned their scope per identifier —
 * O(calls × args × treeSize) per file (151s on a 194KB triton file that
 * tree-sitter parses in 46ms). They now query a lazily-built per-file index
 * (enum-name set, per-scope declaration maps, per-function parameter maps),
 * making extraction O(treeSize + identifiers).
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/cpp-captures-typeclass-benchmark.test.ts
 *
 * WHY DIRECT CALLS, NOT THE PIPELINE: `emitCppScopeCaptures` is the exported
 * per-file entry that owns the index lifetime; calling it directly isolates
 * exactly the regressed cost (parse + capture emit) from workers, chunking,
 * and scope resolution. Co-scaling enums, functions, and call sites with N
 * makes the OLD cost O(N²) and the NEW cost O(N); the wall ratio then
 * separates them cleanly (linear ≈ Nratio, quadratic ≈ Nratio²). The guard
 * sits at Nratio^1.5.
 */
import { describe, it, expect } from 'vitest';
import { emitCppScopeCaptures } from '../../src/core/ingestion/languages/cpp/captures.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

interface BenchResult {
  n: number;
  callSites: number;
  elapsedMs: number;
  captureCount: number;
}

/**
 * Generate one C++ file with N enums, N functions of 8 identifier-arg call
 * sites each. Every call passes locally-declared identifiers whose declared
 * type matches an enum name, forcing the full lookup chain per identifier:
 * scope-declaration lookup → classify → enum-name check (the old full-tree
 * DFS). Tree size and identifier count both scale with N.
 */
function generateFixture(n: number): string {
  const enums = Array.from(
    { length: n },
    (_, k) => `enum class Color${k} { Red${k}, Green${k}, Blue${k} };`,
  ).join('\n');
  const fns = Array.from({ length: n }, (_, k) => {
    const calls = Array.from(
      { length: 8 },
      (_, j) => `  sink(c${k}, x${k}, ${j});\n  other(x${k}, c${k});`,
    ).join('\n');
    return `void fn${k}(int p${k}) {\n  Color${k} c${k} = Color${k}::Red${k};\n  int x${k} = ${k};\n${calls}\n}`;
  }).join('\n');
  return `${enums}\n${fns}\n`;
}

function runBenchmark(n: number): BenchResult {
  const source = generateFixture(n);
  const start = Date.now();
  const captures = emitCppScopeCaptures(source, `bench_${n}.cpp`);
  return {
    n,
    callSites: n * 16,
    elapsedMs: Date.now() - start,
    captureCount: captures.length,
  };
}

describe.skipIf(!BENCH_ENABLED)('C++ capture identifier-type-lookup benchmark', () => {
  it('capture emit scales sub-quadratically with co-scaled enums and call sites', () => {
    // Warm-up: parser + query compilation are lazy singletons; exclude their
    // one-time cost from the measured runs.
    runBenchmark(4);

    const scales = [50, 100, 200];
    const results = scales.map(runBenchmark);

    console.log('\nC++ capture identifier-type-lookup benchmark');
    for (const r of results) {
      console.log(
        `  n=${String(r.n).padStart(4)} callSites=${String(r.callSites).padStart(5)} ` +
          `wall=${String(r.elapsedMs).padStart(6)}ms captures=${r.captureCount}`,
      );
    }

    const first = results[0];
    const last = results[results.length - 1];
    const nRatio = last.n / first.n;

    // Linear ≈ nRatio, quadratic ≈ nRatio². nRatio^1.5 sits between them with
    // margin for timer/GC noise. Guard the ratio only when the base run is
    // measurable (>=20ms) — below that, timer noise dominates and the run is
    // itself proof the pathological cost is gone (old code: seconds at n=50).
    if (first.elapsedMs >= 20) {
      const wallRatio = last.elapsedMs / first.elapsedMs;
      expect(wallRatio).toBeLessThan(Math.pow(nRatio, 1.5));
    } else {
      expect(last.elapsedMs).toBeLessThan(5_000);
    }

    // Sanity: the fixture actually produced call captures at every scale.
    expect(first.captureCount).toBeGreaterThan(first.callSites);
    expect(last.captureCount).toBeGreaterThan(last.callSites);
  }, 300_000);
});
