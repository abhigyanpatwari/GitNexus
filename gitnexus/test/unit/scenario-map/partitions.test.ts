/**
 * Locks the sequential and parallel partitions of scenario-map Vitest runs
 * (tools/scenario-map/path-coverage/partitions.ts): the include patterns of the base config's
 * `fileParallelism: false` projects,
 * glob matching, the split, the merge of partial runs, the partitioned runner and the build output
 * copied into a prepared package.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  VitestRunOptions,
  VitestRunResult,
} from '../../../tools/scenario-map/mutation/vitest-run.js';
import {
  copyBuildOutput,
  mergeVitestRuns,
  partitionFiles,
  runVitestPartitioned,
  sequentialMatcher,
  sequentialMatcherFor,
  sequentialPatterns,
} from '../../../tools/scenario-map/path-coverage/partitions.js';

const SEQ = 'test/integration/lbug-pool.test.ts#pool > opens';
const PAR = 'test/unit/a.test.ts#a > adds';

const run = (overrides: Partial<VitestRunResult>): VitestRunResult => ({
  tests: [],
  status: 'survived',
  outcome: 'survived',
  reason: null,
  outsideTest: [],
  problems: [],
  unhandledErrors: [],
  wallClockMs: 10,
  ...overrides,
});

const test = (id: string): VitestRunResult['tests'][number] => ({
  id,
  taskId: null,
  fullName: null,
  location: null,
  state: 'passed',
  outcome: 'survived',
  message: null,
});

describe('sequential patterns', () => {
  it('reads the includes of every fileParallelism: false project and nothing else', () => {
    const config = {
      test: {
        projects: [
          {
            test: {
              name: 'lbug-db',
              include: ['test/integration/lbug-*.test.ts', 7],
              fileParallelism: false,
            },
          },
          { test: { name: 'default', include: ['test/**/*.test.ts'] } },
          {
            test: {
              name: 'cli-e2e',
              include: ['test/integration/e2e.test.ts'],
              fileParallelism: false,
            },
          },
        ],
      },
    };
    expect(sequentialPatterns(config)).toEqual([
      'test/integration/lbug-*.test.ts',
      'test/integration/e2e.test.ts',
    ]);
  });

  it.each([
    { file: 'test/integration/lbug-pool.test.ts', match: true },
    { file: 'test/integration/nested/lbug-pool.test.ts', match: false },
    { file: 'test/integration/xlbug-pool.test.ts', match: false },
  ])('matches a single-segment glob: $file is $match', ({ file, match }) => {
    expect(sequentialMatcher(['test/integration/lbug-*.test.ts'])(file)).toBe(match);
  });

  it('matches like Vitest: a ** segment may be empty', () => {
    expect(sequentialMatcher(['test/**/*.test.ts'])('test/a.test.ts')).toBe(true);
  });

  it('puts the base config sequential files apart, keeping their order', () => {
    const files = [
      'test/unit/a.test.ts',
      'test/integration/lbug-pool.test.ts',
      'test/integration/rename-provider-ts.test.ts',
      'test/integration/skills-e2e.test.ts',
    ];
    expect(partitionFiles(files, sequentialMatcherFor('normal'))).toEqual({
      sequential: [
        'test/integration/lbug-pool.test.ts',
        'test/integration/rename-provider-ts.test.ts',
        'test/integration/skills-e2e.test.ts',
      ],
      parallel: ['test/unit/a.test.ts'],
    });
  });
});

describe('mergeVitestRuns', () => {
  it('keeps request order and lets the first run that did not survive decide', () => {
    const merged = mergeVitestRuns(
      [SEQ, PAR],
      [
        run({ tests: [test(PAR)], problems: ['p1'] }),
        run({
          tests: [test(SEQ)],
          status: 'killed',
          outcome: 'killed-by-test:assertion',
          reason: 'failed',
          unhandledErrors: ['e'],
        }),
      ],
    );
    expect([
      merged.tests.map((entry) => entry.id),
      merged.outcome,
      merged.reason,
      merged.problems,
      merged.unhandledErrors,
      merged.wallClockMs,
    ]).toEqual([[SEQ, PAR], 'killed-by-test:assertion', 'failed', ['p1'], ['e'], 20]);
  });
});

describe('runVitestPartitioned', () => {
  const options: VitestRunOptions = {
    packageDir: '/p',
    testIds: [PAR, SEQ],
    vitest: { configFile: 'c.ts', project: 'mutation' },
    workDir: '/w',
    maxWorkers: 4,
  };
  const isSequential = (file: string): boolean => file.startsWith('test/integration/');

  it('runs the sequential tests with one worker first, then the rest, and merges them', async () => {
    const calls: [readonly string[], number | undefined, string][] = [];
    const result = await runVitestPartitioned(
      async (call) => {
        calls.push([call.testIds, call.maxWorkers, call.workDir]);
        return run({ tests: call.testIds.map(test) });
      },
      options,
      isSequential,
    );
    expect([calls, result.tests.map((entry) => entry.id)]).toEqual([
      [
        [[SEQ], 1, '/w/sequential'],
        [[PAR], 4, '/w/parallel'],
      ],
      [PAR, SEQ],
    ]);
  });

  it('runs a request without sequential tests as it is', async () => {
    const calls: VitestRunOptions[] = [];
    await runVitestPartitioned(
      async (call) => {
        calls.push(call);
        return run({});
      },
      { ...options, testIds: [PAR] },
      isSequential,
    );
    expect(calls).toEqual([{ ...options, testIds: [PAR] }]);
  });
});

describe('copyBuildOutput', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('gives inventory guards a private index without sharing Git configuration or writes', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-git-inventory-'));
    temps.push(base);
    const checkout = path.join(base, 'checkout');
    const prepared = path.join(base, 'prepared');
    for (const root of [checkout, prepared]) {
      mkdirSync(path.join(root, 'gitnexus'), { recursive: true });
      writeFileSync(path.join(root, 'gitnexus', 'case.ts'), 'export const value = 1;');
    }
    writeFileSync(path.join(checkout, 'public-manifest.json'), '{}');
    writeFileSync(path.join(checkout, '.env'), 'fixture-only-private-value');
    writeFileSync(path.join(prepared, 'gitnexus', 'case.ts'), 'export const value = 2;');
    execFileSync('git', ['init', '--quiet', checkout]);
    const git = (root: string, ...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(checkout, 'add', '--force', '--', 'gitnexus/case.ts', 'public-manifest.json', '.env');
    git(checkout, 'remote', 'add', 'origin', 'https://example.com/source.git');
    copyBuildOutput('normal', path.join(checkout, 'gitnexus'), path.join(prepared, 'gitnexus'));
    expect(git(prepared, 'rev-parse', '--show-toplevel')).toBe(prepared.split(path.sep).join('/'));
    expect(git(prepared, 'ls-files', '--stage')).toBe(
      git(checkout, 'ls-files', '--stage', '--', 'gitnexus/case.ts', 'public-manifest.json'),
    );
    expect(git(prepared, 'remote')).toBe('');
    expect(existsSync(path.join(prepared, '.env'))).toBe(false);
    expect(readFileSync(path.join(prepared, 'public-manifest.json'), 'utf8')).toBe('{}');
    expect(readFileSync(path.join(prepared, 'gitnexus', 'case.ts'), 'utf8')).toContain('value = 2');
    git(prepared, 'update-index', '--force-remove', 'gitnexus/case.ts');
    expect(git(checkout, 'ls-files').split('\n')).toEqual([
      '.env',
      'gitnexus/case.ts',
      'public-manifest.json',
    ]);
  });

  it('preserves repository contract fixtures needed during test collection', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-contract-fixtures-'));
    temps.push(base);
    const checkout = path.join(base, 'checkout', 'gitnexus');
    const prepared = path.join(base, 'prepared', 'gitnexus');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(prepared, { recursive: true });
    const fixtures = [
      '.github/workflows/ci-tests.yml',
      '.claude/skills/gitnexus-plan/SKILL.md',
      'gitnexus-factory-plugin/.factory-plugin/plugin.json',
      'Dockerfile.cli',
      'render.yaml',
      'AGENTS.md',
      'CLAUDE.md',
      'eval/workflow_bench/run-evolution.sh',
      'gitnexus/prebuilds/bundled/manifest.json',
    ];
    for (const file of fixtures) {
      const target = path.join(checkout, '..', file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file);
    }
    writeFileSync(path.join(checkout, '..', '.env'), 'private');
    execFileSync('git', ['init', '--quiet', path.dirname(checkout)]);
    execFileSync('git', ['add', '--force', '--', ...fixtures], { cwd: path.dirname(checkout) });
    copyBuildOutput('normal', checkout, prepared);
    expect(fixtures.map((file) => readFileSync(path.join(prepared, '..', file), 'utf8'))).toEqual(
      fixtures,
    );
    expect(existsSync(path.join(prepared, '..', '.env'))).toBe(false);
  });

  it('copies vendor/ and dist/ that the checkout has into a normal-mode copy only', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-build-output-'));
    temps.push(base);
    const checkout = path.join(base, 'checkout');
    const prepared = path.join(base, 'prepared');
    mkdirSync(path.join(checkout, 'vendor', 'leiden'), { recursive: true });
    mkdirSync(prepared);
    writeFileSync(path.join(checkout, 'vendor', 'leiden', 'index.cjs'), 'leiden');
    const controls = path.join(base, 'controls');
    mkdirSync(controls);
    copyBuildOutput('normal', checkout, prepared);
    copyBuildOutput('controls', checkout, controls);
    expect([
      readFileSync(path.join(prepared, 'vendor', 'leiden', 'index.cjs'), 'utf8'),
      existsSync(path.join(prepared, 'dist')),
      existsSync(path.join(controls, 'vendor')),
    ]).toEqual(['leiden', false, false]);
  });

  it('includes the sibling hook fixtures read by package tests', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-hook-fixtures-'));
    temps.push(base);
    const checkout = path.join(base, 'checkout', 'gitnexus');
    const prepared = path.join(base, 'prepared', 'gitnexus');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(prepared, { recursive: true });
    const hooks = [
      'gitnexus-claude-plugin',
      'gitnexus-cursor-integration',
      'gitnexus-factory-plugin',
    ];
    for (const plugin of hooks) {
      const dir = path.join(checkout, '..', plugin, 'hooks');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'registry-query.cjs'), plugin);
    }
    execFileSync('git', ['init', '--quiet', path.dirname(checkout)]);
    execFileSync('git', ['add', '--', ...hooks], { cwd: path.dirname(checkout) });
    copyBuildOutput('normal', checkout, prepared);
    expect(
      hooks.map((plugin) =>
        readFileSync(path.join(prepared, '..', plugin, 'hooks', 'registry-query.cjs'), 'utf8'),
      ),
    ).toEqual(hooks);
  });
});
