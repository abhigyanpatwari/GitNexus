import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Ubuntu coverage run 39060755951: sequential suites taking >=30 seconds,
// rounded up. These committed hints keep every runner's partition identical.
// File size alone misses generated suites: a 100-byte rename wrapper can run
// for 98 seconds, while a 17KB database suite finishes in one second. Refresh
// from CI measurements when suites grow; these are not timing assertions.
const SEQUENTIAL_COVERAGE_SECONDS: Readonly<Record<string, number>> = {
  'test/integration/fts-extension-e2e.test.ts': 62,
  'test/integration/mcp-index-generation.test.ts': 46,
  'test/integration/parse-cache-identity-lifecycle.test.ts': 147,
  'test/integration/parse-cache-identity-package.test.ts': 67,
  'test/integration/rename-provider-c.test.ts': 52,
  'test/integration/rename-provider-cpp.test.ts': 88,
  'test/integration/rename-provider-csharp.test.ts': 71,
  'test/integration/rename-provider-dart.test.ts': 98,
  'test/integration/rename-provider-go.test.ts': 79,
  'test/integration/rename-provider-java.test.ts': 36,
  'test/integration/rename-provider-javascript.test.ts': 39,
  'test/integration/rename-provider-kotlin.test.ts': 93,
  'test/integration/rename-provider-objective-c.test.ts': 82,
  'test/integration/rename-provider-python.test.ts': 91,
  'test/integration/rename-provider-swift.test.ts': 72,
  'test/integration/rename-provider-typescript.test.ts': 173,
  'test/integration/rename-provider-vue.test.ts': 48,
  'test/integration/rename-provider-zig.test.ts': 36,
  'test/integration/shared-store-adoption.test.ts': 147,
  'test/integration/shared-store-analyze.test.ts': 70,
  'test/integration/shared-store-clean.test.ts': 41,
  'test/integration/shared-store-clone-optin.test.ts': 103,
  'test/integration/shared-store-seed.test.ts': 74,
  'test/integration/skills-e2e.test.ts': 71,
  'test/integration/skip-fts.test.ts': 44,
  'test/unit/incremental-index-extension-dml-gate.test.ts': 67,
  'test/unit/incremental-orchestration.test.ts': 488,
  'test/unit/incremental-write-integrity.test.ts': 114,
};

/**
 * Minimal shape of a vitest `TestSpecification` that {@link specWeight} needs.
 * Kept structural (no `vitest/node` import) so this module stays pure and
 * unit-testable without pulling in the vitest node runtime.
 */
export interface WeightableSpec {
  moduleId: string;
  project: { config: { fileParallelism?: boolean } };
}

/**
 * Estimated per-file cost, used to balance shards by work instead of file count.
 *
 * The spawn-heavy suites are already isolated into `fileParallelism: false`
 * projects (`cli-e2e`, `lbug-db`) — they run one file at a time and dominate
 * wall-clock. Charge measured slow suites proportionally, with the existing
 * 1000-point fallback representing 20 seconds for unmeasured sequential work.
 * File size remains a cheap secondary signal. Deterministic: the same checkout
 * yields identical weights on every runner, keeping a complete partition.
 */
export function specWeight(spec: WeightableSpec): number {
  const sequential = spec.project.config.fileParallelism === false;
  const relativePath = path.relative(PACKAGE_ROOT, spec.moduleId).replaceAll('\\', '/');
  const seconds = SEQUENTIAL_COVERAGE_SECONDS[relativePath];
  let sizeKb = 0;
  try {
    sizeKb = fs.statSync(spec.moduleId).size / 1024;
  } catch {
    /* virtual / unresolved module id → treat as size 0 */
  }
  return (sequential ? (seconds ?? 20) * 50 : 1) + sizeKb;
}

/**
 * Greedy longest-processing-time bin-packing: place each spec (heaviest first)
 * into the currently-lightest shard, balancing total WEIGHT across `count`
 * shards rather than file COUNT. vitest's default hash split balances by count,
 * which clusters slow suites (e.g. Windows platform shard 1 ran ~4x the others).
 *
 * Deterministic — identical input yields identical bins on every runner, so the
 * union of `assignShards(...)[0..count-1]` is exactly the input with no spec
 * dropped or duplicated. Returns one array of specs per shard (index `i-1`).
 */
export function assignShards<T>(
  specs: readonly T[],
  count: number,
  weight: (spec: T) => number,
  key: (spec: T) => string,
): T[][] {
  // Weight each spec once (weight() may stat the file), then sort/assign on the
  // precomputed value — the comparator runs O(n log n) times.
  const scored = specs.map((spec) => ({ spec, w: weight(spec), k: key(spec) }));
  scored.sort((a, b) => {
    const delta = b.w - a.w;
    if (delta !== 0) return delta;
    return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
  });
  const bins = Array.from({ length: count }, () => ({ total: 0, specs: [] as T[] }));
  for (const { spec, w } of scored) {
    let lightest = bins[0];
    for (const bin of bins) {
      if (bin.total < lightest.total) lightest = bin;
    }
    lightest.specs.push(spec);
    lightest.total += w;
  }
  return bins.map((bin) => bin.specs);
}
