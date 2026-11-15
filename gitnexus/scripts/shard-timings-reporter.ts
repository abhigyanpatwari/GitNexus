import path from 'node:path';
import type { TestModule, TestRunEndReason, Vitest } from 'vitest/node';
import { TimingsReporter } from 'vitest-shard-balancer';
import { ALL_CROSS_PLATFORM } from './cross-platform-tests.js';
import { shardTimingKey, shardTimingsFile } from './shard-timings.js';

export default class ShardTimingsReporter extends TimingsReporter {
  private context!: Vitest;

  constructor() {
    // The package's whole-config check cannot describe our native subset.
    // Check the exact cohort below, before excluding skipped modules from learning.
    super({ timingsFile: shardTimingsFile(), requireAllFiles: false });
  }

  override onInit(context: Vitest): void {
    this.context = context;
    super.onInit(context);
  }

  override async onTestRunEnd(
    modules: readonly TestModule[],
    errors: readonly unknown[] = [],
    reason: TestRunEndReason = 'interrupted',
  ): Promise<void> {
    if (!this.context.config.mergeReports) return;
    if (errors.length || reason !== 'passed') {
      throw new Error('Refusing to learn shard timings from an unsuccessful test run');
    }
    const root = this.context.config.root;
    const native = (process.env.GITNEXUS_SHARD_PROFILE ?? 'coverage') !== 'coverage';
    const nativeFiles = new Set<string>(ALL_CROSS_PLATFORM);
    const specs = (await this.context.globTestSpecifications()).filter(
      (spec) =>
        !native || nativeFiles.has(path.relative(root, spec.moduleId).split(path.sep).join('/')),
    );
    const expected = new Set(
      specs.map((spec) => shardTimingKey(root, spec.moduleId, spec.project.name)),
    );
    const actual = new Set<string>();
    for (const module of modules) {
      const key = shardTimingKey(root, module.moduleId, module.project.name);
      if (actual.has(key) || !expected.has(key)) {
        throw new Error(`Duplicate or unexpected test module in shard reports: ${key}`);
      }
      actual.add(key);
    }
    const missing = [...expected].filter((key) => !actual.has(key));
    if (!actual.size || missing.length) {
      throw new Error(
        `Incomplete shard reports; missing ${missing.length} test modules: ${missing.join(', ')}`,
      );
    }
    // A platform-specific skip must not turn a previously expensive file into zero work.
    await super.onTestRunEnd(modules.filter((module) => module.state() === 'passed'));
  }
}
