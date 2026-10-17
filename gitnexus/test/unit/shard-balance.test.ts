/**
 * Locks the cost-balanced shard partition used by PerfSequencer
 * (test/helpers/shard-balance.ts). The load-bearing property is that the union
 * of all shards equals the input exactly — a drop/dup here silently changes what
 * CI runs — so that is asserted directly, plus balance and determinism.
 */
import { describe, it, expect } from 'vitest';
import { globSync } from 'glob';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vitestConfig from '../../vitest.config.js';
import { assignShards, specWeight } from '../helpers/shard-balance.js';

const key = (s: { id: string; w: number }) => s.id;
const weight = (s: { id: string; w: number }) => s.w;
const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, w: (i % 5) + 1 }));

describe('assignShards', () => {
  it('does not pack the slow database suites onto the same coverage shard', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const specs = (vitestConfig.test?.projects ?? []).flatMap((project) => {
      if (typeof project !== 'object' || !('test' in project) || !project.test) {
        throw new Error('Expected inline Vitest project configuration');
      }
      const config = project.test;
      return globSync(config.include ?? [], {
        cwd: root,
        absolute: true,
        nodir: true,
        ignore: config.exclude,
      }).map((moduleId) => ({ moduleId: path.resolve(moduleId), project: { config } }));
    });
    const workflow = readFileSync(path.join(root, '../.github/workflows/ci-tests.yml'), 'utf8');
    const count = Number(workflow.match(/^\s+COV_TOTAL=(\d+)\b/m)?.[1]);
    expect(count).toBeGreaterThan(0);
    const bins = assignShards(specs, count, specWeight, (spec) => spec.moduleId);
    const files = bins.flat().map((spec) => spec.moduleId);
    expect(files.slice().sort()).toEqual(specs.map((spec) => spec.moduleId).sort());
    expect(new Set(files).size).toBe(files.length);

    // Observed sequential time in run 39060755951, independent of scheduling
    // weights. The old size heuristic put all seven on shard 1 (1027 seconds),
    // before its remaining database tests and 149 parallel test files.
    const observedSeconds: Record<string, number> = {
      'test/unit/incremental-orchestration.test.ts': 487.202,
      'test/unit/incremental-write-integrity.test.ts': 113.583,
      'test/integration/shared-store-clone-optin.test.ts': 102.187,
      'test/integration/rename-provider-dart.test.ts': 97.973,
      'test/integration/rename-provider-objective-c.test.ts': 81.122,
      'test/integration/rename-provider-go.test.ts': 78.185,
      'test/integration/parse-cache-identity-package.test.ts': 66.863,
    };
    for (const file of Object.keys(observedSeconds)) {
      expect(files).toContain(path.join(root, file));
    }
    const loads = bins.map((bin) =>
      bin.reduce(
        (sum, spec) =>
          sum + (observedSeconds[path.relative(root, spec.moduleId).replaceAll('\\', '/')] ?? 0),
        0,
      ),
    );
    // Leave room for the rest of the suite and coverage in the unchanged
    // 25-minute job. This is a timing-profile replay, not a wall-clock test.
    expect(Math.max(...loads)).toBeLessThan(10 * 60);
  });

  it('assigns every spec exactly once across all shards (disjoint + complete)', () => {
    const specs = make(37);
    const shards = [1, 2, 3].map((i) => assignShards(specs, 3, weight, key)[i - 1]);
    expect(shards.flat().map(key).sort()).toEqual(specs.map(key).sort());
    expect(shards.reduce((n, s) => n + s.length, 0)).toBe(specs.length);
  });

  it('leaves no shard empty when specs outnumber shards', () => {
    const bins = assignShards(make(10), 3, weight, key);
    expect(bins.every((b) => b.length > 0)).toBe(true);
  });

  it('balances total weight within one item of optimal (greedy LPT)', () => {
    const totals = assignShards(make(30), 3, weight, key).map((b) =>
      b.reduce((t, s) => t + s.w, 0),
    );
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(5);
  });

  it('is deterministic — identical input yields identical bins', () => {
    const specs = make(20);
    const a = assignShards(specs, 4, weight, key).map((b) => b.map(key));
    const b = assignShards(specs, 4, weight, key).map((b2) => b2.map(key));
    expect(a).toEqual(b);
  });
});

describe('specWeight', () => {
  it('weights spawn-heavy (fileParallelism:false) files far above parallel ones', () => {
    const heavy = specWeight({
      moduleId: '/does/not/exist/heavy.test.ts',
      project: { config: { fileParallelism: false } },
    });
    const light = specWeight({
      moduleId: '/does/not/exist/light.test.ts',
      project: { config: { fileParallelism: true } },
    });
    expect(heavy).toBeGreaterThan(light + 500);
  });
});
