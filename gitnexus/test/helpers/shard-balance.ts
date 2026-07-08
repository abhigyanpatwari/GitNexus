import fs from 'node:fs';

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
 * wall-clock, so they carry the heavy base weight. File size is a cheap
 * (stat-only, no parse) secondary signal for finer balance and a stable
 * tiebreak. Deterministic: the same repo checkout yields identical weights on
 * every shard runner, which is what keeps sharding a complete partition.
 */
export function specWeight(spec: WeightableSpec): number {
  const sequential = spec.project.config.fileParallelism === false;
  let sizeKb = 0;
  try {
    sizeKb = fs.statSync(spec.moduleId).size / 1024;
  } catch {
    /* virtual / unresolved module id → treat as size 0 */
  }
  return (sequential ? 1000 : 1) + sizeKb;
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
