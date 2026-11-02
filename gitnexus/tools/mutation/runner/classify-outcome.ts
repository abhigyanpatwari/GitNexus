/**
 * The KTD17 outcome-class table, applied by the vitest5 runner to one Vitest run.
 *
 * | Observation                                             | Class                           | Status   |
 * | ------------------------------------------------------- | ------------------------------- | -------- |
 * | Test fails with `AssertionError`                        | killed-by-test:assertion        | killed   |
 * | Test or hook fails with Vitest testTimeout/hookTimeout  | timeout                         | timeout  |
 * | Test fails with another error                           | killed-by-test:runtime          | killed   |
 * | `beforeEach`/`afterEach` fails for a test               | killed-by-test:hook             | killed   |
 * | `beforeAll` fails; suite tests skipped                  | killed-outside-test:hook        | killed, attributed to the suite's tests |
 * | `afterAll` fails; tests stay passing                    | killed-outside-test:hook        | killed, no attribution |
 * | Test file fails to import or collect                    | killed-outside-test:collection  | killed, no attribution |
 * | Unhandled error during the run                          | infrastructure                  | error    |
 * | A selected test has `retry` above zero                  | inconclusive                    | error    |
 * | Hit limit reached                                       | timeout                         | timeout  |
 * | Zero tests, or a test set different from the request    | invalid                         | error    |
 * | No selected test fails                                  | survived                        | survived |
 *
 * Stryker's own timer is not seen here: Stryker kills the process and no sidecar is written.
 * Precedence for the run status: hit limit, then infrastructure, invalid, inconclusive, then any
 * kill, then a Vitest timeout, then survived. Only `killed-by-test:assertion` rows count for the
 * gate 3 and gate 4 kill sets; Stryker sees Killed for every killed row.
 *
 * This module is pure: the plugin turns Vitest's results into an {@link ObservedRun}.
 */

export type OutcomeClass =
  | 'killed-by-test:assertion'
  | 'killed-by-test:runtime'
  | 'killed-by-test:hook'
  | 'killed-outside-test:hook'
  | 'killed-outside-test:collection'
  | 'timeout'
  | 'infrastructure'
  | 'inconclusive'
  | 'invalid'
  | 'survived';

export type RunnerStatus = 'killed' | 'survived' | 'timeout' | 'error';

export interface ObservedError {
  name: string;
  message: string;
}

export type TestHook = 'beforeEach' | 'afterEach';
export type SuiteHook = 'beforeAll' | 'afterAll';

export interface ObservedTest {
  taskId: string;
  fullName: string;
  state: 'passed' | 'failed' | 'skipped' | 'pending';
  /** In Vitest's order: the body or `beforeEach` error first, an `afterEach` error last. */
  errors: readonly ObservedError[];
  /** Hooks that started for this test and did not finish (the setup file reads `result.hooks`). */
  failedHooks: readonly TestHook[];
  retry: number;
}

export interface ObservedSuite {
  taskId: string;
  failedHooks: readonly SuiteHook[];
  errors: readonly ObservedError[];
  /** Every test below the suite, at any depth. */
  testTaskIds: readonly string[];
}

export interface ObservedModule {
  /** Package-relative POSIX path. */
  file: string;
  /** The runner's setup file finished its file-level hook, so collection succeeded. */
  collected: boolean;
  /** Collection errors, or errors of file-level `beforeAll`/`afterAll` hooks. */
  errors: readonly ObservedError[];
  failedHooks: readonly SuiteHook[];
  suites: readonly ObservedSuite[];
  tests: readonly ObservedTest[];
  hitCount: number | undefined;
}

export interface RequestedTest {
  /** Stryker id (KTD3). */
  id: string;
  taskId: string;
  fullName: string;
  file: string;
}

export interface ObservedRun {
  requested: readonly RequestedTest[];
  modules: readonly ObservedModule[];
  unhandledErrors: readonly ObservedError[];
  hitLimit: number | undefined;
}

export interface TestOutcome {
  id: string;
  outcome: OutcomeClass;
  message: string | undefined;
}

export interface OutsideTestOutcome {
  file: string;
  /** Undefined for the file itself. */
  suiteTaskId: string | undefined;
  outcome: OutcomeClass;
  /** Stryker ids that Stryker sees as killers; empty when the row has no test attribution. */
  attributedTo: string[];
  message: string;
}

export interface RunClassification {
  status: RunnerStatus;
  outcome: OutcomeClass;
  reason: string | undefined;
  killedBy: string[];
  failureMessage: string | undefined;
  /** Requested tests that ran (passed or failed). */
  nrOfTests: number;
  hitCount: number;
  tests: TestOutcome[];
  outsideTest: OutsideTestOutcome[];
}

const VITEST_TIMEOUT =
  /^(?:(?:Test|Hook) timed out in \d+ms|The (?:setup|teardown) phase of "around(?:Each|All)" hook timed out after \d+ms)/;
const HIT_LIMIT = /Stryker: Hit count limit reached/;

export const isVitestTimeoutError = (error: ObservedError): boolean =>
  VITEST_TIMEOUT.test(error.message);

export const isHitLimitError = (error: ObservedError): boolean => HIT_LIMIT.test(error.message);

const KILL_PRIORITY: readonly OutcomeClass[] = [
  'killed-by-test:assertion',
  'killed-by-test:runtime',
  'killed-by-test:hook',
  'killed-outside-test:hook',
  'killed-outside-test:collection',
];

const isKill = (outcome: OutcomeClass): boolean => KILL_PRIORITY.includes(outcome);

function classifyFailedTest(test: ObservedTest): OutcomeClass {
  const first = test.errors[0];
  if (first === undefined) return 'killed-by-test:runtime';
  if (isVitestTimeoutError(first) || isHitLimitError(first)) return 'timeout';
  const hookOnly =
    test.failedHooks.includes('beforeEach') ||
    (test.failedHooks.includes('afterEach') && test.errors.length === 1);
  if (hookOnly) return 'killed-by-test:hook';
  return first.name === 'AssertionError' ? 'killed-by-test:assertion' : 'killed-by-test:runtime';
}

const hookOutcome = (error: ObservedError | undefined): OutcomeClass =>
  error !== undefined && (isVitestTimeoutError(error) || isHitLimitError(error))
    ? 'timeout'
    : 'killed-outside-test:hook';

const describeErrors = (errors: readonly ObservedError[]): string =>
  errors.map((error) => `${error.name}: ${error.message}`).join('\n');

export function classifyRun(run: ObservedRun): RunClassification {
  const hitCount = run.modules.reduce((sum, module) => sum + (module.hitCount ?? 0), 0);
  const requestedByTaskId = new Map(run.requested.map((test) => [test.taskId, test]));
  const tests: TestOutcome[] = [];
  const outsideTest: OutsideTestOutcome[] = [];
  const invalid: string[] = [];
  const inconclusive: string[] = [];
  const accounted = new Set<string>();
  const flagged = new Set<string>();
  const collectionFailedFiles = new Set<string>();
  const allErrors: ObservedError[] = [...run.unhandledErrors];
  let nrOfTests = 0;

  for (const module of run.modules) {
    allErrors.push(...module.errors);
    if (!module.collected) {
      if (module.errors.length > 0) {
        collectionFailedFiles.add(module.file);
        outsideTest.push({
          file: module.file,
          suiteTaskId: undefined,
          outcome: module.errors.some(isHitLimitError)
            ? 'timeout'
            : 'killed-outside-test:collection',
          attributedTo: [],
          message: describeErrors(module.errors),
        });
      }
      continue;
    }

    const requestedOf = (taskIds: readonly string[]): RequestedTest[] =>
      taskIds.flatMap((taskId) => requestedByTaskId.get(taskId) ?? []);
    const scopes = [
      {
        suiteTaskId: undefined,
        failedHooks: module.failedHooks,
        errors: module.errors,
        testTaskIds: module.tests.map((test) => test.taskId),
      },
      ...module.suites.map((suite) => ({ ...suite, suiteTaskId: suite.taskId })),
    ];
    for (const scope of scopes) {
      if (scope.suiteTaskId !== undefined) allErrors.push(...scope.errors);
      if (scope.failedHooks.includes('beforeAll')) {
        const attributed = requestedOf(scope.testTaskIds);
        const error = scope.errors[0];
        const outcome = hookOutcome(error);
        for (const test of attributed) {
          accounted.add(test.taskId);
          tests.push({ id: test.id, outcome, message: error?.message });
        }
        outsideTest.push({
          file: module.file,
          suiteTaskId: scope.suiteTaskId,
          outcome,
          attributedTo: outcome === 'timeout' ? [] : attributed.map((test) => test.id),
          message: error?.message ?? 'beforeAll failed',
        });
      }
      if (scope.failedHooks.includes('afterAll')) {
        const error = scope.errors[scope.errors.length - 1];
        outsideTest.push({
          file: module.file,
          suiteTaskId: scope.suiteTaskId,
          outcome: hookOutcome(error),
          attributedTo: [],
          message: error?.message ?? 'afterAll failed',
        });
      }
    }

    for (const test of module.tests) {
      allErrors.push(...test.errors);
      const wanted = requestedByTaskId.get(test.taskId);
      const ran = test.state === 'passed' || test.state === 'failed';
      if (wanted === undefined) {
        if (ran) invalid.push(`test ${test.taskId} (${test.fullName}) ran but was not requested`);
        continue;
      }
      if (accounted.has(test.taskId)) continue;
      if (test.fullName !== wanted.fullName) {
        flagged.add(test.taskId);
        invalid.push(
          `task ${test.taskId} has full name ${JSON.stringify(test.fullName)}, the run manifest ` +
            `expects ${JSON.stringify(wanted.fullName)}`,
        );
        continue;
      }
      if (!ran) {
        flagged.add(test.taskId);
        invalid.push(`requested test ${wanted.id} did not run (state ${test.state})`);
        continue;
      }
      accounted.add(test.taskId);
      nrOfTests += 1;
      if (test.retry > 0) inconclusive.push(`${wanted.id} has retry ${test.retry}`);
      tests.push(
        test.state === 'passed'
          ? { id: wanted.id, outcome: 'survived', message: undefined }
          : { id: wanted.id, outcome: classifyFailedTest(test), message: test.errors[0]?.message },
      );
    }
  }

  for (const test of run.requested) {
    const explained =
      accounted.has(test.taskId) ||
      flagged.has(test.taskId) ||
      collectionFailedFiles.has(test.file);
    if (!explained) invalid.push(`requested test ${test.id} did not run (not reported by Vitest)`);
  }
  if (run.requested.length === 0) invalid.push('zero tests were requested');
  else if (
    nrOfTests === 0 &&
    !outsideTest.some((row) => isKill(row.outcome) || row.outcome === 'timeout')
  ) {
    invalid.push('zero tests ran');
  }

  const killedBy = [
    ...new Set([
      ...tests.filter((test) => isKill(test.outcome)).map((test) => test.id),
      ...outsideTest.flatMap((row) => row.attributedTo),
    ]),
  ];
  const failureMessage =
    tests.find((test) => isKill(test.outcome))?.message ??
    outsideTest.find((row) => isKill(row.outcome))?.message;
  const base = { hitCount, tests, outsideTest, nrOfTests };
  const decide = (
    status: RunnerStatus,
    outcome: OutcomeClass,
    reason: string | undefined,
  ): RunClassification => ({
    status,
    outcome,
    reason,
    killedBy: status === 'killed' ? killedBy : [],
    failureMessage: status === 'killed' ? failureMessage : undefined,
    ...base,
  });

  if (run.hitLimit !== undefined && hitCount > run.hitLimit) {
    return decide('timeout', 'timeout', `Hit limit reached (${hitCount}/${run.hitLimit})`);
  }
  const hitLimitError = allErrors.find(isHitLimitError);
  if (hitLimitError !== undefined) {
    return decide('timeout', 'timeout', `Hit limit reached: ${hitLimitError.message}`);
  }
  if (run.unhandledErrors.length > 0) {
    return decide(
      'error',
      'infrastructure',
      `unhandled error during the run: ${describeErrors(run.unhandledErrors)}`,
    );
  }
  if (invalid.length > 0) return decide('error', 'invalid', invalid.join('; '));
  if (inconclusive.length > 0) {
    return decide('error', 'inconclusive', `selected tests use retry: ${inconclusive.join('; ')}`);
  }
  const outcomes = [...tests.map((test) => test.outcome), ...outsideTest.map((row) => row.outcome)];
  const kill = KILL_PRIORITY.find((outcome) => outcomes.includes(outcome));
  if (kill !== undefined) return decide('killed', kill, undefined);
  if (outcomes.includes('timeout')) {
    return decide(
      'timeout',
      'timeout',
      [...tests, ...outsideTest].find((row) => row.outcome === 'timeout')?.message,
    );
  }
  return decide('survived', 'survived', undefined);
}
