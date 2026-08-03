/**
 * Pins the weight-aware split behind the cross-platform matrix (#2449).
 *
 * The regression this guards is specific and was expensive: three CHEAP files
 * were registered in `SPAWN_CLI`, vitest re-partitioned the list by file COUNT,
 * and the reshuffle clustered `cli-e2e` (361 s on Windows) with `cli-limit-e2e`
 * (75 s) and `analyze-heap-oom-e2e` (23 s) on one shard, which then blew the
 * 20-minute watchdog. The added files cost nothing; the COUNT-split did it.
 *
 * So the load-bearing case here is not "the split is even" — it is
 * "adding a cheap file does not move a heavy one". A partition that merely
 * balanced totals could still reshuffle everything on every insertion and would
 * reproduce the outage exactly.
 */

import { describe, it, expect } from 'vitest';
import {
  shardFiles,
  shardWeight,
  weightOf,
  WINDOWS_WEIGHTS_SEC,
} from '../../scripts/cross-platform-shard.js';
import { ALL_CROSS_PLATFORM } from '../../scripts/cross-platform-tests.js';

const SHARD_TOTAL = 3;

/** Every shard of a split, as file lists. */
const allShards = (files: readonly string[], total: number): readonly (readonly string[])[] =>
  Array.from({ length: total }, (_unused, i) => shardFiles(files, i + 1, total));

describe('cross-platform shard partition', () => {
  it('covers every file exactly once, with no overlap between shards', () => {
    const shards = allShards(ALL_CROSS_PLATFORM, SHARD_TOTAL);
    const seen = shards.flatMap((s) => [...s]);

    expect(seen.slice().sort()).toEqual([...ALL_CROSS_PLATFORM].sort());
    expect(new Set(seen).size).toBe(ALL_CROSS_PLATFORM.length);
  });

  it('keeps each shard within a shard of the ideal weight', () => {
    const shards = allShards(ALL_CROSS_PLATFORM, SHARD_TOTAL);
    const weights = shards.map(shardWeight);
    const ideal = shardWeight(ALL_CROSS_PLATFORM) / SHARD_TOTAL;

    // LPT's guarantee is 4/3 of optimal, and optimal is at least the ideal
    // average. A hard 1.34x ceiling on the busiest shard is what keeps the
    // matrix inside its watchdog no matter how the list is edited.
    expect(Math.max(...weights)).toBeLessThanOrEqual(ideal * 1.34);
  });

  it('never puts the two heaviest suites on the same shard', () => {
    // The exact shape of the outage: cli-e2e and worker-pool are 361 s and
    // 222 s, so together they are most of a shard's budget before anything else
    // is scheduled.
    const shards = allShards(ALL_CROSS_PLATFORM, SHARD_TOTAL);
    const withBoth = shards.filter(
      (s) =>
        s.includes('test/integration/cli-e2e.test.ts') &&
        s.includes('test/integration/worker-pool.test.ts'),
    );

    expect(withBoth).toEqual([]);
  });

  it('does not move a heavy file when a cheap file is added — the #2449 regression', () => {
    const heavy = Object.keys(WINDOWS_WEIGHTS_SEC);
    const placementOf = (files: readonly string[]): ReadonlyMap<string, number> => {
      const shards = allShards(files, SHARD_TOTAL);
      return new Map(
        heavy
          .map((f) => [f, shards.findIndex((s) => s.includes(f))] as const)
          .filter(([, i]) => i >= 0),
      );
    };

    const before = placementOf(ALL_CROSS_PLATFORM);

    // The inserted names sort EARLY, and there is a case that is NOT a multiple
    // of the shard count. Both details are load-bearing, and getting them wrong
    // made earlier versions of this test vacuous:
    //  - names that sort last cannot disturb anything under any scheme;
    //  - adding exactly `total` files leaves an equal-weight round-robin in the
    //    same rotation, so a count-split would pass too.
    // Under the real weighted split, heavy files are scheduled before every
    // light one, so no number of cheap insertions can move them.
    const afterOne = placementOf([...ALL_CROSS_PLATFORM, 'test/aaa-new-cheap-a.test.ts']);
    const afterTwo = placementOf([
      ...ALL_CROSS_PLATFORM,
      'test/aaa-new-cheap-a.test.ts',
      'test/aaa-new-cheap-b.test.ts',
    ]);

    expect(Object.fromEntries(afterOne)).toMatchObject(Object.fromEntries(before));
    expect(Object.fromEntries(afterTwo)).toMatchObject(Object.fromEntries(before));
  });

  it('is deterministic, so every runner computes the same split independently', () => {
    // Each matrix job resolves its own slice on its own machine with no shared
    // state, so an unstable sort would silently drop or duplicate files.
    const once = allShards(ALL_CROSS_PLATFORM, SHARD_TOTAL).map((s) => [...s]);
    const twice = allShards([...ALL_CROSS_PLATFORM].reverse(), SHARD_TOTAL).map((s) =>
      [...s].sort(),
    );

    expect(twice).toEqual(once.map((s) => [...s].sort()));
  });

  it('returns every file for a single-shard run, and rejects an out-of-range shard', () => {
    expect(shardFiles(ALL_CROSS_PLATFORM, 1, 1)).toEqual([...ALL_CROSS_PLATFORM]);
    expect(() => shardFiles(ALL_CROSS_PLATFORM, 0, 3)).toThrow(/shard index/);
    expect(() => shardFiles(ALL_CROSS_PLATFORM, 4, 3)).toThrow(/shard index/);
    expect(() => shardFiles(ALL_CROSS_PLATFORM, 1, 0)).toThrow(/shard total/);
  });

  it('charges every file the per-file floor, so light files are never free', () => {
    // Without this, the balancer isolates the monsters and then piles all the
    // light files onto the remaining shards — a count imbalance that costs just
    // as much wall clock as the runtime one it just fixed.
    expect(weightOf('test/unit/zzz-does-not-exist.test.ts')).toBeGreaterThan(0);
    expect(weightOf('test/integration/cli-e2e.test.ts')).toBeGreaterThan(
      WINDOWS_WEIGHTS_SEC['test/integration/cli-e2e.test.ts'] ?? 0,
    );
  });

  it('weights only files that are actually registered', () => {
    // A weight entry for a file no longer in the list is dead config that the
    // balancer silently ignores; catching it here keeps the table honest.
    const registered = new Set(ALL_CROSS_PLATFORM);
    const stale = Object.keys(WINDOWS_WEIGHTS_SEC).filter((f) => !registered.has(f));

    expect(stale).toEqual([]);
  });
});
