/**
 * Locks the sequential and parallel partitions of scenario-map Vitest runs
 * (tools/scenario-map/path-coverage/partitions.ts): the base config's `lbug-db` include patterns,
 * glob matching, the split, the merge of partial runs and the partitioned runner.
 */
import { describe, expect, it } from 'vitest';
import type {
  VitestRunOptions,
  VitestRunResult,
} from '../../../tools/scenario-map/mutation/vitest-run.js';
import {
  baseSequentialMatcher,
  mergeVitestRuns,
  partitionFiles,
  runVitestPartitioned,
  sequentialMatcher,
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
  it('reads the lbug-db project includes and nothing else', () => {
    const config = {
      test: {
        projects: [
          { test: { name: 'lbug-db', include: ['test/integration/lbug-*.test.ts', 7] } },
          { test: { name: 'default', include: ['test/**/*.test.ts'] } },
        ],
      },
    };
    expect(sequentialPatterns(config)).toEqual(['test/integration/lbug-*.test.ts']);
  });

  it.each([
    { file: 'test/integration/lbug-pool.test.ts', match: true },
    { file: 'test/integration/nested/lbug-pool.test.ts', match: false },
    { file: 'test/integration/xlbug-pool.test.ts', match: false },
  ])('matches a single-segment glob: $file is $match', ({ file, match }) => {
    expect(sequentialMatcher(['test/integration/lbug-*.test.ts'])(file)).toBe(match);
  });

  it('puts the base config sequential files apart, keeping their order', () => {
    const files = [
      'test/unit/a.test.ts',
      'test/integration/lbug-pool.test.ts',
      'test/integration/rename-provider-ts.test.ts',
    ];
    expect(partitionFiles(files, baseSequentialMatcher())).toEqual({
      sequential: [
        'test/integration/lbug-pool.test.ts',
        'test/integration/rename-provider-ts.test.ts',
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
