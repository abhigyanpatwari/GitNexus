import { statSync } from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { partition, readTimings } from 'vitest-shard-balancer';
import { shardTimingKey, shardTimingsFile } from '../../scripts/shard-timings.js';

/**
 * Cost-balanced shard sequencer (wired via `sequence.sequencer` in
 * vitest.config.ts).
 *
 * Uses the package's duration partitioner with the frozen CI timing snapshot.
 * Only shard() changes; BaseSequencer keeps groupOrder and local sorting.
 * On a cold start, spread sequential/native work using a generic size estimate
 * instead of the count split that previously clustered the slowest suites.
 */
export default class PerfSequencer extends BaseSequencer {
  override async shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return specs;
    const root = this.ctx.config.root;
    const keyed = new Map(
      specs.map((spec) => [shardTimingKey(root, spec.moduleId, spec.project.name), spec]),
    );
    if (keyed.size !== specs.length) throw new Error('Duplicate test specification in shard input');
    const keys = [...keyed.keys()];
    const timings = readTimings(path.resolve(root, shardTimingsFile()));
    let groups = partition(keys, timings, shard.count);
    if (!groups) {
      const estimates = Object.fromEntries(
        [...keyed].map(([key, spec]) => {
          let sizeKb = 0;
          try {
            sizeKb = statSync(spec.moduleId).size / 1024;
          } catch {
            /* Virtual test module. */
          }
          const config = spec.project.config;
          const sequential = 'fileParallelism' in config && config.fileParallelism === false;
          // Keep all cold weights on the same scale: 1,000 points represents
          // 20 seconds of sequential work. A millisecond value here would
          // dwarf file size and pile the parallel cohort onto fewer shards.
          return [key, (sequential ? 1_000 : 1) + sizeKb];
        }),
      );
      groups = partition(keys, estimates, shard.count);
    }
    const selected = new Set(groups?.[shard.index - 1] ?? []);
    return specs.filter((spec) =>
      selected.has(shardTimingKey(root, spec.moduleId, spec.project.name)),
    );
  }
}
