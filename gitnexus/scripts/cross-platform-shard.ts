/**
 * Weight-aware partitioning for the cross-platform test matrix.
 *
 * WHY THIS EXISTS. `run-cross-platform.ts` used to hand vitest the whole file
 * list plus `--shard=i/n`, and vitest partitions by file COUNT. Runtime on this
 * suite is wildly uneven — measured on the Windows runner, `cli-e2e` is 621 s
 * and `worker-pool` 221 s, while most files are under a second — so a
 * count-split routinely put several of the heaviest suites on one shard. That
 * is #2449, and this file's sibling header has documented the symptom ("the
 * heaviest spawn suites can cluster on one shard") since the watchdog was first
 * raised from 15 to 20 minutes.
 *
 * It went from a latent hazard to a red matrix when three CHEAP files (the
 * `dist/` module-load closure guards: 448 ms, 53 ms, sub-second) were added to
 * `SPAWN_CLI`. They cost nothing to run, but a count-split re-partitions on
 * every insertion, and the reshuffle happened to land `cli-e2e` + `cli-limit-e2e`
 * + `analyze-heap-oom-e2e` together on shard 1/3 — 32 files against 26 and 29 —
 * which blew the 20-minute budget with four files still queued. Nothing about
 * the added files caused it; they were simply the perturbation.
 *
 * So the split is done HERE, by weight, and only the chosen shard's files are
 * handed to vitest. Two properties follow, and both are pinned in
 * `test/unit/cross-platform-shard.test.ts`:
 *
 *  - the heaviest suites are spread across shards by construction, so the
 *    busiest shard tracks the ideal rather than the luck of the sort order;
 *  - adding or removing a CHEAP file cannot move a heavy one, so registering a
 *    new platform-sensitive test is no longer a CI-stability gamble. That is the
 *    property whose absence caused this.
 */

/**
 * Measured wall-clock on the WINDOWS runner (the slowest platform, so it is the
 * one that decides the budget), in seconds, from the last fully-green matrix run
 * plus the timed files of the run that failed.
 *
 * Only files heavy enough to matter are listed; everything else is carried by
 * {@link PER_FILE_OVERHEAD_SEC} alone. These are load-balancing hints, NOT
 * assertions — no
 * test asserts a runtime, and drift only makes the split slightly less even, so
 * a stale entry is harmless and refreshing them is optional. Deliberately not
 * auto-generated: a committed table is reviewable and works offline, and the
 * alternative (timing files at CI runtime to decide the split) would make the
 * partition depend on the very machine load it is trying to protect against.
 */
export const WINDOWS_WEIGHTS_SEC: Readonly<Record<string, number>> = {
  // Re-measured after the analyze --watch e2e landed in #3072. The previous
  // 361 s entry undercharged this suite and left shard 1 close to the watchdog.
  'test/integration/cli-e2e.test.ts': 621,
  'test/integration/worker-pool.test.ts': 222,
  'test/unit/incremental-vector-extension-ordering.test.ts': 87,
  // ESTIMATE, not a measurement (#2841): this suite drives more full
  // `runFullAnalysis` cycles than the VECTOR sibling above, so the 8 s
  // PER_FILE_OVERHEAD floor would badly under-charge it and skew the Windows
  // split — the failure mode that produced the job timeouts this table exists
  // to prevent. Scaled from the sibling's measured 87 s by analyze-run count.
  // Replace with a real figure after the first green Windows matrix run.
  'test/unit/incremental-index-extension-dml-gate.test.ts': 180,
  'test/integration/cli-limit-e2e.test.ts': 75,
  'test/unit/hooks.test.ts': 26,
  'test/integration/analyze-heap-oom-e2e.test.ts': 23,
  'test/unit/git-utils.test.ts': 18,
  'test/integration/hooks-e2e.test.ts': 15,
  'test/integration/tree-sitter-languages.test.ts': 9,
  'test/unit/repo-manager.test.ts': 9,
  'test/unit/detect-changes-worktree.test.ts': 9,
  'test/integration/antigravity-hook-e2e.test.ts': 7,
  'test/unit/index-lock.test.ts': 5,
  'test/unit/setup.test.ts': 5,
  // ESTIMATE, not a measurement. This file asserts almost nothing; it READS —
  // one 4893-file pass over every tracked text file, plus an 830-file pass over
  // `src/`. Measured at 2.3 s and 0.3 s per pass on a virtualised and a local
  // Linux filesystem respectively, so the cost is entirely per-file open
  // latency, which is the term Windows inflates most (NTFS plus Defender on
  // every read). Scaled from the slower Linux figure to keep the split
  // conservative rather than let the 8 s PER_FILE_OVERHEAD floor under-charge
  // a file that touches more paths than anything else here. Replace with a real
  // figure after the first green Windows matrix run.
  'test/unit/source-control-bytes.test.ts': 15,
};

/**
 * Fixed cost every file pays regardless of what it asserts: a pool worker start,
 * module graph evaluation, and (for most of this list) a native addon load.
 *
 * Added to EVERY file's weight, not just unmeasured ones, and that is the point.
 * Calibrated against the last green Windows matrix: its busiest shard ran 736 s
 * of wall clock over ~511 s of measured file time, so roughly 8 s per file is
 * unattributed setup. Without this term the balancer treats a light file as
 * nearly free and, having isolated the two monsters, piles every remaining file
 * onto the other shards — trading a runtime imbalance for a file-count one that
 * costs just as much. With it, the split balances runtime AND count together.
 */
const PER_FILE_OVERHEAD_SEC = 8;

/**
 * Scheduling weight for `file`: its measured runtime (0 if it was fast enough
 * that vitest printed no duration) plus the per-file floor above.
 */
export function weightOf(file: string): number {
  return (WINDOWS_WEIGHTS_SEC[file] ?? 0) + PER_FILE_OVERHEAD_SEC;
}

/**
 * Partition `files` into `total` shards and return the 1-based `index` one.
 *
 * Longest-processing-time first: sort by weight descending, then repeatedly give
 * the next file to the lightest shard so far. LPT is the standard greedy for
 * multiprocessor scheduling and is guaranteed within 4/3 of optimal — far more
 * than enough here, where the goal is only "no shard gets two monsters".
 *
 * Ties break on the file path so the partition is DETERMINISTIC: every shard
 * computes the same split independently, on a different machine, with no
 * coordination — which is what lets each runner select its own slice.
 *
 * Returns files in the input list's original order, not weight order, so failure
 * output and reruns stay readable.
 */
export function shardFiles(
  files: readonly string[],
  index: number,
  total: number,
): readonly string[] {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`shard total must be a positive integer, got ${total}`);
  }
  if (!Number.isInteger(index) || index < 1 || index > total) {
    throw new Error(`shard index must be in 1..${total}, got ${index}`);
  }
  if (total === 1) return [...files];

  const byWeightDesc = [...files].sort((a, b) => {
    const diff = weightOf(b) - weightOf(a);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const loads = Array.from({ length: total }, () => 0);
  const assigned = Array.from({ length: total }, () => new Set<string>());
  for (const file of byWeightDesc) {
    let lightest = 0;
    for (let i = 1; i < total; i++) {
      if (loads[i]! < loads[lightest]!) lightest = i;
    }
    assigned[lightest]!.add(file);
    loads[lightest]! += weightOf(file);
  }

  const mine = assigned[index - 1]!;
  return files.filter((f) => mine.has(f));
}

/** Total weight of a file set — the shard cost this balancer is minimising. */
export function shardWeight(files: readonly string[]): number {
  return files.reduce((sum, f) => sum + weightOf(f), 0);
}
