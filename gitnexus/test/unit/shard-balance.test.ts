/**
 * Locks the cost-balanced shard partition used by PerfSequencer
 * (test/helpers/shard-balance.ts). The load-bearing property is that the union
 * of all shards equals the input exactly — a drop/dup here silently changes what
 * CI runs — so that is asserted directly, plus balance and determinism.
 */
import { describe, it, expect } from 'vitest';
import { assignShards, specWeight } from '../helpers/shard-balance.js';

const key = (s: { id: string }) => s.id;
const weight = (s: { w: number }) => s.w;
const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, w: (i % 5) + 1 }));

describe('assignShards', () => {
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
