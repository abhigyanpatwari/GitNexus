/**
 * Locks the worker bound of the in-process Vitest runs (U7 vitest-run.ts; the scenario-map CLI's
 * `--concurrency` bounds them as it bounds Stryker): `maxWorkers` reaches the options runVitest
 * gives `createVitest` (a fake, so no Vitest instance starts), and inProcessVitestOptions, which
 * path-coverage/run-coverage.ts shares, sets it only when given.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliOptions } from 'vitest/node';
import {
  inProcessVitestOptions,
  runVitest,
  type CreateVitest,
} from '../../../tools/scenario-map/mutation/vitest-run.js';

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scenario-vitest-run-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A createVitest that records its options and returns an instance without projects. */
function fakeCreateVitest(seen: CliOptions[]): CreateVitest {
  return (options) => {
    seen.push(options);
    return Promise.resolve({
      projects: [],
      close: () => Promise.resolve(),
      collectTests: () => Promise.reject(new Error('not collected')),
      runTestSpecifications: () => Promise.reject(new Error('not run')),
    });
  };
}

describe('runVitest worker bound', () => {
  it('passes prepared-run instrumentation to Vite without enabling it for ordinary runs', async () => {
    const plugin = { name: 'fixture-capture-regression' };
    const create: CreateVitest = async (_options, overrides) => {
      expect(overrides.plugins).toEqual([plugin]);
      return {
        projects: [],
        close: async () => {},
        collectTests: async () => {
          throw new Error('unused');
        },
        runTestSpecifications: async () => {
          throw new Error('unused');
        },
      };
    };
    await expect(
      runVitest(
        {
          packageDir: tempDir(),
          testIds: ['test/unit/a.test.ts#a'],
          vitest: { configFile: 'vitest.config.ts', project: 'p' },
          workDir: tempDir(),
          plugins: [plugin],
        },
        create,
      ),
    ).rejects.toThrow(/expected one Vitest project named p/);
  });
  it.each([
    ['the given bound', 3, 3],
    ['no bound (Vitest default)', undefined, undefined],
  ])('passes %s to createVitest', async (_title, maxWorkers, expected) => {
    const seen: CliOptions[] = [];
    const run = runVitest(
      {
        packageDir: tempDir(),
        testIds: ['test/unit/a.test.ts#a > b'],
        vitest: { configFile: 'vitest.config.ts', project: 'p' },
        workDir: path.join(tempDir(), 'work'),
        maxWorkers,
      },
      fakeCreateVitest(seen),
    );
    await expect(run).rejects.toThrow(/expected one Vitest project named p/);
    expect(seen.map((options) => [options.maxWorkers, options.project, options.watch])).toEqual([
      [expected, ['p'], false],
    ]);
  });
});

describe('inProcessVitestOptions', () => {
  it('bounds the workers and keeps the repeats of a coverage run', () => {
    expect(
      inProcessVitestOptions({ root: '/p', configFile: 'c.config.ts', maxWorkers: 2, repeats: 1 }),
    ).toEqual({
      root: '/p',
      config: path.join('/p', 'c.config.ts'),
      project: undefined,
      watch: false,
      cache: false,
      fsModuleCache: false,
      repeats: 1,
      maxWorkers: 2,
      reporters: [],
    });
  });

  it('leaves the worker count to Vitest without a bound', () => {
    const options = inProcessVitestOptions({ root: '/p', configFile: 'c.config.ts' });
    expect(['maxWorkers' in options, 'repeats' in options]).toEqual([false, false]);
  });
});
