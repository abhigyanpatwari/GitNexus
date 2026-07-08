import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { assignShards, specWeight } from './shard-balance.js';

/**
 * Cost-balanced shard sequencer (wired via `sequence.sequencer` in
 * vitest.config.ts).
 *
 * Overrides only `shard()` — `sort()` keeps the base behaviour so the projects'
 * `groupOrder` and duration-cache ordering are untouched. Instead of vitest's
 * default hash split (balanced by file COUNT, which piled the spawn-heavy suites
 * onto one runner), it balances by estimated WORK (see `specWeight`): the
 * fileParallelism:false spawn-heavy files are spread evenly across shards, so the
 * slowest shard's wall-clock drops and no single runner carries all the
 * contention. The partition stays complete and disjoint (see `assignShards`).
 */
export default class PerfSequencer extends BaseSequencer {
  override async shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return specs;
    const groups = assignShards(specs, shard.count, specWeight, (spec) => spec.moduleId);
    return groups[shard.index - 1] ?? [];
  }
}
