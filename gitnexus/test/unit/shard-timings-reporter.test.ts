import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestModule, Vitest } from 'vitest/node';
import ShardTimingsReporter from '../../scripts/shard-timings-reporter.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-timings-'));
  roots.push(root);
  const file = path.join(root, '.vitest/timings/coverage.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ 'native:a.test.ts': 1000, 'native:b.test.ts': 500 }));
  const modules = ['a', 'b'].map((name) => ({
    moduleId: path.join(root, `${name}.test.ts`),
    project: { name: 'native' },
    state: () => 'passed',
    diagnostic: () => ({
      environmentSetupDuration: 10,
      prepareDuration: 20,
      setupDuration: 30,
      collectDuration: 40,
      duration: 100,
    }),
  })) as unknown as TestModule[];
  const reporter = new ShardTimingsReporter();
  reporter.onInit({
    config: { root, mergeReports: 'blobs' },
    globTestSpecifications: async () => modules,
  } as unknown as Vitest);
  return { file, modules, reporter };
}

describe('learning shard timings', () => {
  it('includes setup and collection, smooths measurements, and retains skipped-file history', async () => {
    const { file, modules, reporter } = fixture();
    modules[1].state = () => 'skipped';
    await reporter.onTestRunEnd(modules, [], 'passed');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      'native:a.test.ts': 600,
      'native:b.test.ts': 500,
    });
  });

  it.each(['missing', 'duplicate', 'unexpected'] as const)(
    'rejects %s modules without replacing history',
    async (kind) => {
      const { file, modules, reporter } = fixture();
      const before = readFileSync(file, 'utf8');
      const inputs =
        kind === 'missing'
          ? modules.slice(0, 1)
          : [
              ...modules,
              kind === 'duplicate'
                ? modules[0]
                : ({ ...modules[0], moduleId: '/unexpected.test.ts' } as unknown as TestModule),
            ];
      await expect(reporter.onTestRunEnd(inputs, [], 'passed')).rejects.toThrow(
        /Incomplete|Duplicate or unexpected/,
      );
      expect(readFileSync(file, 'utf8')).toBe(before);
    },
  );

  it.each(['failed', 'interrupted'] as const)('does not learn from a %s run', async (reason) => {
    const { file, modules, reporter } = fixture();
    const before = readFileSync(file, 'utf8');
    await expect(reporter.onTestRunEnd(modules, [], reason)).rejects.toThrow(/unsuccessful/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not learn when the runner reports an unhandled error', async () => {
    const { file, modules, reporter } = fixture();
    const before = readFileSync(file, 'utf8');
    await expect(
      reporter.onTestRunEnd(modules, [new Error('worker crashed')], 'passed'),
    ).rejects.toThrow(/unsuccessful/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
