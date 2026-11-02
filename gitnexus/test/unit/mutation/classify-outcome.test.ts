/**
 * Locks the KTD17 outcome-class table of the vitest5 runner: every observation row maps to its
 * class and to the status the runner reports to Stryker, from synthetic task results.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRun,
  type ObservedError,
  type ObservedModule,
  type ObservedRun,
  type ObservedTest,
  type RequestedTest,
} from '../../../tools/mutation/runner/classify-outcome.js';

const FILE = 'test/unit/a.test.ts';

const requested = (index: number, file = FILE): RequestedTest => ({
  id: `${file}#S > t${index}`,
  taskId: `${file}_${index}`,
  fullName: `S > t${index}`,
  file,
});

const error = (name: string, message: string): ObservedError => ({ name, message });

const test = (index: number, overrides: Partial<ObservedTest> = {}, file = FILE): ObservedTest => ({
  taskId: `${file}_${index}`,
  fullName: `S > t${index}`,
  state: 'passed',
  errors: [],
  failedHooks: [],
  retry: 0,
  ...overrides,
});

const module = (
  tests: ObservedTest[],
  overrides: Partial<ObservedModule> = {},
): ObservedModule => ({
  file: FILE,
  collected: true,
  errors: [],
  failedHooks: [],
  suites: [
    { taskId: 'suite-S', failedHooks: [], errors: [], testTaskIds: tests.map((t) => t.taskId) },
  ],
  tests,
  hitCount: 0,
  ...overrides,
});

const run = (modules: ObservedModule[], overrides: Partial<ObservedRun> = {}): ObservedRun => ({
  requested: [requested(0), requested(1)],
  modules,
  unhandledErrors: [],
  hitLimit: 1000,
  ...overrides,
});

const assertionError = error('AssertionError', 'expected 1 to be 2');

describe('classifyRun: killed-by-test rows', () => {
  it.each([
    [
      'an AssertionError',
      test(1, { state: 'failed', errors: [assertionError] }),
      'killed-by-test:assertion',
    ],
    [
      'another error',
      test(1, { state: 'failed', errors: [error('TypeError', 'x is not a function')] }),
      'killed-by-test:runtime',
    ],
    [
      'a failing beforeEach',
      test(1, { state: 'failed', errors: [assertionError], failedHooks: ['beforeEach'] }),
      'killed-by-test:hook',
    ],
    [
      'a failing afterEach after a passing body',
      test(1, { state: 'failed', errors: [error('Error', 'cleanup')], failedHooks: ['afterEach'] }),
      'killed-by-test:hook',
    ],
    [
      'a failing body followed by a failing afterEach',
      test(1, {
        state: 'failed',
        errors: [assertionError, error('Error', 'cleanup')],
        failedHooks: ['afterEach'],
      }),
      'killed-by-test:assertion',
    ],
  ])('classifies a test that fails with %s', (_label, failing, outcome) => {
    const result = classifyRun(run([module([test(0), failing])]));

    expect(result).toMatchObject({ status: 'killed', outcome, killedBy: [`${FILE}#S > t1`] });
    expect(result.tests).toEqual([
      { id: `${FILE}#S > t0`, outcome: 'survived', message: undefined },
      { id: `${FILE}#S > t1`, outcome, message: failing.errors[0].message },
    ]);
  });

  it('reports every failing test as a killer', () => {
    const failing = { state: 'failed', errors: [assertionError] } as const;

    expect(classifyRun(run([module([test(0, failing), test(1, failing)])])).killedBy).toEqual([
      `${FILE}#S > t0`,
      `${FILE}#S > t1`,
    ]);
  });
});

describe('classifyRun: killed-outside-test rows', () => {
  it('attributes a suite beforeAll failure to the suite tests that it skipped', () => {
    const skipped = { state: 'skipped' } as const;
    const result = classifyRun(
      run([
        module([test(0, skipped), test(1, skipped)], {
          suites: [
            {
              taskId: 'suite-S',
              failedHooks: ['beforeAll'],
              errors: [error('Error', 'connect failed')],
              testTaskIds: [`${FILE}_0`, `${FILE}_1`],
            },
          ],
        }),
      ]),
    );

    expect(result).toMatchObject({
      status: 'killed',
      outcome: 'killed-outside-test:hook',
      killedBy: [`${FILE}#S > t0`, `${FILE}#S > t1`],
      outsideTest: [
        {
          file: FILE,
          suiteTaskId: 'suite-S',
          outcome: 'killed-outside-test:hook',
          attributedTo: [`${FILE}#S > t0`, `${FILE}#S > t1`],
          message: 'connect failed',
        },
      ],
    });
  });

  it('attributes a file-level beforeAll failure to every requested test of the file', () => {
    const skipped = { state: 'skipped' } as const;
    const result = classifyRun(
      run([
        module([test(0, skipped), test(1, skipped)], {
          failedHooks: ['beforeAll'],
          errors: [error('Error', 'file setup failed')],
        }),
      ]),
    );

    expect(result).toMatchObject({
      status: 'killed',
      killedBy: [`${FILE}#S > t0`, `${FILE}#S > t1`],
    });
  });

  it('kills without test attribution when afterAll fails and the tests stay passing', () => {
    const result = classifyRun(
      run([
        module([test(0), test(1)], {
          suites: [
            {
              taskId: 'suite-S',
              failedHooks: ['afterAll'],
              errors: [error('Error', 'teardown failed')],
              testTaskIds: [`${FILE}_0`, `${FILE}_1`],
            },
          ],
        }),
      ]),
    );

    expect(result).toMatchObject({
      status: 'killed',
      outcome: 'killed-outside-test:hook',
      killedBy: [],
      outsideTest: [{ suiteTaskId: 'suite-S', attributedTo: [], message: 'teardown failed' }],
    });
  });

  it('kills without test attribution when a test file fails to import', () => {
    const result = classifyRun(
      run([
        module([], {
          collected: false,
          suites: [],
          errors: [error('SyntaxError', 'Unexpected token')],
          hitCount: undefined,
        }),
      ]),
    );

    expect(result).toMatchObject({
      status: 'killed',
      outcome: 'killed-outside-test:collection',
      killedBy: [],
      nrOfTests: 0,
      outsideTest: [{ file: FILE, outcome: 'killed-outside-test:collection', attributedTo: [] }],
    });
  });
});

describe('classifyRun: timeout rows', () => {
  it('reports Timeout when the summed hit count passes the hit limit, even with passing tests', () => {
    const result = classifyRun(
      run(
        [
          module([test(0)], { hitCount: 60 }),
          module([test(1)], { file: 'test/unit/b.test.ts', hitCount: 50 }),
        ],
        {
          requested: [requested(0), { ...requested(1), file: 'test/unit/b.test.ts' }],
          hitLimit: 100,
        },
      ),
    );

    expect(result).toMatchObject({
      status: 'timeout',
      outcome: 'timeout',
      reason: 'Hit limit reached (110/100)',
    });
  });

  it('reports Timeout when the hit-limit error stopped collection', () => {
    const result = classifyRun(
      run([
        module([], {
          collected: false,
          suites: [],
          errors: [error('Error', 'Stryker: Hit count limit reached (101)')],
          hitCount: undefined,
        }),
      ]),
    );

    expect(result).toMatchObject({ status: 'timeout', outcome: 'timeout' });
  });

  it.each([
    ['testTimeout', 'Test timed out in 5000ms.\nIf this is a long-running test, ...'],
    ['hookTimeout', 'Hook timed out in 10000ms.\nIf this is a long-running hook, ...'],
  ])('reports Timeout for a test that fails with Vitest %s', (_label, message) => {
    const result = classifyRun(
      run([module([test(0), test(1, { state: 'failed', errors: [error('Error', message)] })])]),
    );

    expect(result).toMatchObject({ status: 'timeout', outcome: 'timeout', killedBy: [] });
    expect(result.tests[1]).toEqual({ id: `${FILE}#S > t1`, outcome: 'timeout', message });
  });

  it('reports Timeout for a beforeAll that hits Vitest hookTimeout', () => {
    const skipped = { state: 'skipped' } as const;
    const result = classifyRun(
      run([
        module([test(0, skipped), test(1, skipped)], {
          suites: [
            {
              taskId: 'suite-S',
              failedHooks: ['beforeAll'],
              errors: [error('Error', 'Hook timed out in 120000ms.')],
              testTaskIds: [`${FILE}_0`, `${FILE}_1`],
            },
          ],
        }),
      ]),
    );

    expect(result).toMatchObject({ status: 'timeout', outcome: 'timeout', killedBy: [] });
  });

  it('prefers a kill over a Vitest timeout in another test', () => {
    const result = classifyRun(
      run([
        module([
          test(0, { state: 'failed', errors: [error('Error', 'Test timed out in 5000ms.')] }),
          test(1, { state: 'failed', errors: [assertionError] }),
        ]),
      ]),
    );

    expect(result).toMatchObject({ status: 'killed', killedBy: [`${FILE}#S > t1`] });
  });
});

describe('classifyRun: error rows', () => {
  it('reports an unhandled error as infrastructure', () => {
    const result = classifyRun(
      run([module([test(0), test(1)])], {
        unhandledErrors: [error('Error', 'socket hang up')],
      }),
    );

    expect(result).toMatchObject({ status: 'error', outcome: 'infrastructure' });
    expect(result.reason).toContain('socket hang up');
  });

  it('reports a selected test with retry above zero as inconclusive', () => {
    const result = classifyRun(run([module([test(0), test(1, { retry: 2 })])]));

    expect(result).toMatchObject({ status: 'error', outcome: 'inconclusive' });
    expect(result.reason).toContain('retry');
  });

  it.each([
    ['zero requested tests', run([module([test(0), test(1)])], { requested: [] }), /zero tests/],
    [
      'a requested test that did not run',
      run([module([test(0), test(1, { state: 'skipped' })])]),
      /did not run/,
    ],
    [
      'a test that ran without being requested',
      run([module([test(0), test(1), test(2)])]),
      /not requested/,
    ],
    [
      'a task id whose full name changed',
      run([module([test(0), test(1, { fullName: 'S > renamed' })])]),
      /full name/,
    ],
    ['a requested file that produced no module', run([]), /did not run/],
  ])('reports %s as invalid', (_label, observed, reason) => {
    const result = classifyRun(observed);

    expect(result).toMatchObject({ status: 'error', outcome: 'invalid' });
    expect(result.reason).toMatch(reason);
  });
});

describe('classifyRun: survived row', () => {
  it('reports Survived when every requested test passes', () => {
    expect(classifyRun(run([module([test(0), test(1)])]))).toEqual({
      status: 'survived',
      outcome: 'survived',
      reason: undefined,
      killedBy: [],
      failureMessage: undefined,
      nrOfTests: 2,
      hitCount: 0,
      tests: [
        { id: `${FILE}#S > t0`, outcome: 'survived', message: undefined },
        { id: `${FILE}#S > t1`, outcome: 'survived', message: undefined },
      ],
      outsideTest: [],
    });
  });

  it('ignores tests that the selection skipped', () => {
    const result = classifyRun(
      run([module([test(0), test(1), test(2, { state: 'skipped' })])], {
        requested: [requested(0), requested(1)],
      }),
    );

    expect(result).toMatchObject({ status: 'survived', nrOfTests: 2 });
  });
});
