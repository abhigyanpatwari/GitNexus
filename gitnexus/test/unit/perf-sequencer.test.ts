import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestSpecification, Vitest } from 'vitest/node';
import PerfSequencer from '../helpers/perf-sequencer.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-shards-'));
  roots.push(root);
  mkdirSync(path.join(root, '.vitest/timings'), { recursive: true });
  const specs = ['a', 'b', 'c', 'd'].map((name) => {
    const moduleId = path.join(root, `${name}.test.ts`);
    writeFileSync(moduleId, '// same size\n');
    return {
      moduleId,
      project: { name: 'native', config: { fileParallelism: false } },
    } as unknown as TestSpecification;
  });
  const history = (profile: string, weights: number[]) =>
    writeFileSync(
      path.join(root, '.vitest/timings', `${profile}.json`),
      JSON.stringify(
        Object.fromEntries(
          specs.map((spec, i) => [`native:${path.basename(spec.moduleId)}`, weights[i]]),
        ),
      ),
    );
  const split = async () =>
    Promise.all(
      [1, 2].map(async (index) => {
        const ctx = { config: { root, shard: { index, count: 2 } } } as Vitest;
        return new PerfSequencer(ctx).shard(specs);
      }),
    );
  return { root, specs, history, split };
}

describe('timing-based CI sharding', () => {
  it('learns from measured durations instead of putting both slow files on one shard', async () => {
    const { specs, history, split } = fixture();
    history('coverage', [10000, 10, 9000, 10]);
    const bins = await split();
    expect(bins.some((bin) => bin.includes(specs[0]) && bin.includes(specs[2]))).toBe(false);
    expect(
      bins
        .flat()
        .map((spec) => spec.moduleId)
        .sort(),
    ).toEqual(specs.map((spec) => spec.moduleId).sort());
  });

  it('keeps platform histories separate and gives independent runners identical partitions', async () => {
    const { specs, history, split } = fixture();
    history('windows-latest', [10000, 10, 9000, 10]);
    history('macos-latest', [9000, 10000, 10, 10]);
    vi.stubEnv('GITNEXUS_SHARD_PROFILE', 'windows-latest');
    const windows = await split();
    expect(await split()).toEqual(windows);
    expect(windows.some((bin) => bin.includes(specs[0]) && bin.includes(specs[2]))).toBe(false);
    vi.stubEnv('GITNEXUS_SHARD_PROFILE', 'macos-latest');
    const mac = await split();
    expect(mac.some((bin) => bin.includes(specs[0]) && bin.includes(specs[1]))).toBe(false);
    expect(mac).not.toEqual(windows);
  });

  it('still schedules new files and cold starts as complete disjoint partitions', async () => {
    const { specs, history, split } = fixture();
    const cold = await split();
    expect(cold.map((bin) => bin.length)).toEqual([2, 2]);
    history('coverage', [10000]);
    const warm = await split();
    expect(new Set(warm.flat()).size).toBe(specs.length);
    expect(warm.flat().length).toBe(specs.length);
  });
});
