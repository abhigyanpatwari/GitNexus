/**
 * Locks the oracle's own KTD17 classifier (U13): synthetic wrapper records (Vitest observations
 * from the oracle reporter plus Vitest's JSON totals) and Stryker statuses read from a
 * `mutation.json` text map to the outcome classes, per-test rows and kill sets.
 */
import { describe, expect, it } from 'vitest';
import {
  parseMutationReport,
  type MutantStatus,
} from '../../../tools/mutation/prepare/mutant-identity.js';
import {
  ORACLE_CLASSES,
  assignTestIds,
  classifyMutant,
  classifyRun,
  isUnusableClass,
  parseOracleRunRecord,
  parseRecordFileName,
  recordFileName,
  strykerStatuses,
  toOracleError,
  type OracleError,
  type OracleModuleRecord,
  type OracleObservedRun,
  type OracleRunRecord,
  type OracleSuiteRecord,
  type OracleTestRecord,
  type VitestJsonTotals,
} from '../../../tools/mutation/oracle/oracle-classify.js';

const FILE = 'test/unit/a.test.ts';
const T0 = `${FILE}#S > t0`;
const T1 = `${FILE}#S > t1`;
const EXPECTED: readonly string[] = [T0, T1];

const error = (name: string, message: string): OracleError => ({ name, message });
const assertionError = toOracleError({
  message: 'expected 1 to be 2',
  stack: 'AssertionError: expected 1 to be 2\n    at test/unit/a.test.ts:12:15',
});
const typeError = error('TypeError', "Cannot read properties of undefined (reading 'x')");
const testTimeout = error(
  'Error',
  'Test timed out in 30000ms.\nIf this is a long-running test, pass a timeout value as the last ' +
    'argument or configure it globally with "testTimeout".',
);
const hookTimeout = error(
  'Error',
  'Hook timed out in 120000ms.\nIf this is a long-running hook, pass a timeout value as the last ' +
    'argument or configure it globally with "hookTimeout".',
);

const test = (index: number, overrides: Partial<OracleTestRecord> = {}): OracleTestRecord => ({
  fullName: `S > t${index}`,
  location: { line: 10 + index, column: 3 },
  state: 'passed',
  errors: [],
  failedHooks: [],
  retry: 0,
  retryCount: 0,
  ...overrides,
});

const suite = (tests: readonly number[], overrides: Partial<OracleSuiteRecord> = {}) => ({
  fullName: 'S',
  errors: [],
  failedHooks: [],
  tests: [...tests],
  ...overrides,
});

const module = (
  tests: OracleTestRecord[],
  overrides: Partial<OracleModuleRecord> = {},
): OracleModuleRecord => ({
  file: FILE,
  state: 'passed',
  errors: [],
  failedHooks: [],
  suites: [suite(tests.map((_, index) => index))],
  tests,
  ...overrides,
});

const observed = (
  modules: OracleModuleRecord[],
  overrides: Partial<OracleObservedRun> = {},
): OracleObservedRun => ({ reason: 'passed', unhandledErrors: [], modules, ...overrides });

/** What Vitest's own JSON reporter counts for the same run. */
const totals = (run: OracleObservedRun): VitestJsonTotals => {
  const all = run.modules.flatMap((entry) => entry.tests);
  return {
    numTotalTests: all.length,
    numPassedTests: all.filter((entry) => entry.state === 'passed').length,
    numFailedTests: all.filter((entry) => entry.state === 'failed').length,
  };
};

const record = (
  run: OracleObservedRun,
  exitCode: number,
  overrides: Partial<OracleRunRecord> = {},
): OracleRunRecord => ({
  schemaVersion: 1,
  kind: 'mutant',
  mutantId: '7',
  attempt: 1,
  pid: 4242,
  root: '/sandbox',
  configFile: '/sandbox/tools/mutation/vitest.mutation.config.ts',
  vitestVersion: '5.0.5',
  exitCode,
  wallClockMs: 1500,
  wrapperError: null,
  run,
  vitestJson: totals(run),
  vitestJsonFile: '/reports/mutant-7.attempt-1.vitest.json',
  ...overrides,
});

const classify = (run: OracleObservedRun, exitCode: number) =>
  classifyMutant({
    strykerStatus: exitCode === 0 ? 'Survived' : 'Killed',
    record: record(run, exitCode),
    expected: EXPECTED,
  });

/** A one-file Stryker report holding a mutant with local id 7 and the given status. */
const mutationJson = (status: MutantStatus): string =>
  JSON.stringify({
    schemaVersion: '1.0',
    files: {
      'src/x.ts': {
        language: 'typescript',
        source: 'export const x = 1;\n',
        mutants: [
          {
            id: '7',
            mutatorName: 'BooleanLiteral',
            replacement: 'false',
            location: { start: { line: 1, column: 18 }, end: { line: 1, column: 19 } },
            status,
          },
        ],
      },
    },
  });

const statusOf = (status: MutantStatus): MutantStatus =>
  strykerStatuses(parseMutationReport(mutationJson(status))).get('7') ?? 'Pending';

describe('oracle classifier: KTD17 rows from a wrapper record', () => {
  it('classifies one failing test with an AssertionError stack as killed-by-test, assertion', () => {
    const result = classify(
      observed([module([test(0, { state: 'failed', errors: [assertionError] }), test(1)])]),
      1,
    );
    expect(assertionError.name).toBe('AssertionError');
    expect(result).toMatchObject({
      outcome: 'killed-by-test:assertion',
      source: 'report',
      killedBy: [T0],
      assertionKilledBy: [T0],
      executed: [T0, T1],
    });
    expect(result.tests).toEqual([
      {
        id: T0,
        file: FILE,
        fullName: 'S > t0',
        outcome: 'killed-by-test:assertion',
        message: 'expected 1 to be 2',
      },
      { id: T1, file: FILE, fullName: 'S > t1', outcome: 'survived', message: null },
    ]);
  });

  it('classifies a file-level error with no tests as killed-outside-test, collection', () => {
    const result = classify(
      observed([
        module([], {
          state: 'failed',
          errors: [error('SyntaxError', 'Unexpected token')],
          suites: [],
        }),
      ]),
      1,
    );
    expect(result).toMatchObject({
      outcome: 'killed-outside-test:collection',
      killedBy: [],
      assertionKilledBy: [],
      executed: [],
    });
    expect(result.outsideTest).toEqual([
      {
        file: FILE,
        suite: null,
        outcome: 'killed-outside-test:collection',
        attributedTo: [],
        message: 'SyntaxError: Unexpected token',
      },
    ]);
  });

  it('classifies a missing report with a non-zero exit and no Timeout status as infrastructure', () => {
    expect(
      classifyMutant({ strykerStatus: 'Killed', record: null, expected: EXPECTED }),
    ).toMatchObject({
      outcome: 'infrastructure',
      source: 'missing-report',
      killedBy: [],
    });
  });

  it('classifies a Stryker Timeout with no report as timeout, read from mutation.json', () => {
    const strykerStatus = statusOf('Timeout');
    expect(strykerStatus).toBe('Timeout');
    expect(classifyMutant({ strykerStatus, record: null, expected: EXPECTED })).toMatchObject({
      outcome: 'timeout',
      source: 'stryker-timeout',
      killedBy: [],
    });
  });

  it('classifies a Stryker Timeout as timeout even when a report shows a kill', () => {
    const run = observed([
      module([test(0, { state: 'failed', errors: [assertionError] }), test(1)]),
    ]);
    expect(
      classifyMutant({ strykerStatus: 'Timeout', record: record(run, 1), expected: EXPECTED }),
    ).toMatchObject({ outcome: 'timeout', source: 'stryker-timeout', assertionKilledBy: [] });
  });

  it('classifies a report with zero executed tests as invalid', () => {
    const skipped = { state: 'skipped' as const };
    const result = classify(observed([module([test(0, skipped), test(1, skipped)])]), 0);
    expect(result.outcome).toBe('invalid');
    expect(result.reason).toContain('zero tests ran');
  });

  it('classifies a TypeError as killed-by-test, runtime', () => {
    const result = classify(
      observed([module([test(0, { state: 'failed', errors: [typeError] }), test(1)])]),
      1,
    );
    expect(result).toMatchObject({
      outcome: 'killed-by-test:runtime',
      killedBy: [T0],
      assertionKilledBy: [],
    });
  });

  it('classifies a beforeEach failure as killed-by-test, hook', () => {
    const failed = test(0, { state: 'failed', errors: [typeError], failedHooks: ['beforeEach'] });
    const result = classify(observed([module([failed, test(1)])]), 1);
    expect(result).toMatchObject({
      outcome: 'killed-by-test:hook',
      killedBy: [T0],
      assertionKilledBy: [],
    });
  });

  it('attributes a beforeAll failure to the skipped suite tests as killed-outside-test, hook', () => {
    const skipped = { state: 'skipped' as const };
    const result = classify(
      observed([
        module([test(0, skipped), test(1, skipped)], {
          state: 'failed',
          suites: [suite([0, 1], { failedHooks: ['beforeAll'], errors: [typeError] })],
        }),
      ]),
      1,
    );
    expect(result).toMatchObject({
      outcome: 'killed-outside-test:hook',
      killedBy: [T0, T1],
      assertionKilledBy: [],
      executed: [],
    });
    expect(result.outsideTest).toEqual([
      {
        file: FILE,
        suite: 'S',
        outcome: 'killed-outside-test:hook',
        attributedTo: [T0, T1],
        message: `TypeError: ${typeError.message}`,
      },
    ]);
    expect(result.tests.map((row) => row.outcome)).toEqual([
      'killed-outside-test:hook',
      'killed-outside-test:hook',
    ]);
  });

  it("classifies Vitest's own testTimeout error as timeout", () => {
    const result = classify(
      observed([module([test(0, { state: 'failed', errors: [testTimeout] }), test(1)])]),
      1,
    );
    expect(result).toMatchObject({ outcome: 'timeout', killedBy: [] });
  });

  it('classifies a beforeAll hookTimeout error as timeout without attribution', () => {
    const skipped = { state: 'skipped' as const };
    const result = classify(
      observed([
        module([test(0, skipped), test(1, skipped)], {
          state: 'failed',
          suites: [suite([0, 1], { failedHooks: ['beforeAll'], errors: [hookTimeout] })],
        }),
      ]),
      1,
    );
    expect(result).toMatchObject({ outcome: 'timeout', killedBy: [] });
    expect(result.outsideTest[0]?.attributedTo).toEqual([]);
  });

  it('classifies an all-passing report as survived', () => {
    expect(classify(observed([module([test(0), test(1)])]), 0)).toMatchObject({
      outcome: 'survived',
      reason: null,
      killedBy: [],
      executed: [T0, T1],
    });
  });

  it('classifies NoCoverage as survived, read from mutation.json', () => {
    expect(
      classifyMutant({ strykerStatus: statusOf('NoCoverage'), record: null, expected: EXPECTED }),
    ).toMatchObject({ outcome: 'survived', source: 'no-coverage' });
  });
});

describe('oracle classifier: further KTD17 rows and integrity checks', () => {
  it('classifies an unhandled error as infrastructure', () => {
    const run = observed([module([test(0), test(1)])], {
      reason: 'failed',
      unhandledErrors: [error('Error', 'socket hang up')],
    });
    expect(classify(run, 1)).toMatchObject({ outcome: 'infrastructure', killedBy: [] });
  });

  it('classifies an executed test with retry above zero as inconclusive', () => {
    const result = classify(observed([module([test(0, { retry: 2 }), test(1)])]), 0);
    expect(result.outcome).toBe('inconclusive');
    expect(result.reason).toContain(`${T0} has retry 2`);
  });

  it('classifies a test set different from the baseline as invalid', () => {
    const result = classify(observed([module([test(0), test(2)])]), 0);
    expect(result.outcome).toBe('invalid');
    expect(result.reason).toContain(`baseline test ${T1} did not run`);
    expect(result.reason).toContain(`test ${FILE}#S > t2 ran but is not in the baseline`);
  });

  it('classifies an afterAll failure with passing tests as killed-outside-test, hook, unattributed', () => {
    const result = classify(
      observed([
        module([test(0), test(1)], {
          state: 'failed',
          suites: [suite([0, 1], { failedHooks: ['afterAll'], errors: [typeError] })],
        }),
      ]),
      1,
    );
    expect(result).toMatchObject({
      outcome: 'killed-outside-test:hook',
      killedBy: [],
      executed: [T0, T1],
    });
  });

  it.each([
    ['a passing body and a failing afterEach', [typeError], 'killed-by-test:hook'],
    [
      'a failing body and a failing afterEach',
      [assertionError, typeError],
      'killed-by-test:assertion',
    ],
  ] as const)('classifies %s by the first failure', (_label, errors, expected) => {
    const failed = test(0, { state: 'failed', errors: [...errors], failedHooks: ['afterEach'] });
    expect(classify(observed([module([failed, test(1)])]), 1).outcome).toBe(expected);
  });

  it('prefers an assertion kill over a runtime kill in the same run', () => {
    const result = classify(
      observed([
        module([
          test(0, { state: 'failed', errors: [typeError] }),
          test(1, { state: 'failed', errors: [assertionError] }),
        ]),
      ]),
      1,
    );
    expect(result).toMatchObject({
      outcome: 'killed-by-test:assertion',
      killedBy: [T0, T1],
      assertionKilledBy: [T1],
    });
  });

  it.each([
    ['exit 0 with a failed test', 0, test(0, { state: 'failed', errors: [assertionError] })],
    ['a non-zero exit with every test passing', 1, test(0)],
  ] as const)('classifies %s as infrastructure', (_label, exitCode, first) => {
    const run = observed([module([first, test(1)])]);
    const result = classifyRun(run, { exitCode, expected: EXPECTED, vitestJson: totals(run) });
    expect(result.outcome).toBe('infrastructure');
    expect(result.reason).toContain(`Vitest exited ${exitCode}`);
  });

  it('classifies a disagreement with the Vitest JSON totals as infrastructure', () => {
    const run = observed([module([test(0), test(1)])]);
    const result = classifyRun(run, {
      exitCode: 0,
      expected: EXPECTED,
      vitestJson: { numTotalTests: 2, numPassedTests: 1, numFailedTests: 1 },
    });
    expect(result.outcome).toBe('infrastructure');
    expect(result.reason).toContain('Vitest JSON report');
  });

  it.each([
    ['Killed', 0],
    ['Survived', 1],
  ] as const)(
    'classifies Stryker status %s with wrapper exit %i as infrastructure',
    (strykerStatus, exitCode) => {
      const run = observed([module([test(0), test(1)])]);
      expect(
        classifyMutant({ strykerStatus, record: record(run, exitCode), expected: EXPECTED })
          .outcome,
      ).toBe('infrastructure');
    },
  );

  it('classifies a record whose wrapper could not start Vitest as infrastructure', () => {
    const run = observed([]);
    const broken = record(run, 1, {
      run: null,
      vitestJson: null,
      wrapperError: 'config failed to load',
    });
    expect(
      classifyMutant({ strykerStatus: 'Killed', record: broken, expected: EXPECTED }),
    ).toMatchObject({
      outcome: 'infrastructure',
      reason: 'config failed to load',
    });
  });

  it('classifies a mutant Stryker never ran as invalid', () => {
    expect(
      classifyMutant({ strykerStatus: 'Ignored', record: null, expected: EXPECTED }),
    ).toMatchObject({
      outcome: 'invalid',
      source: 'not-run',
    });
  });
});

describe('oracle test identity and record files', () => {
  it('suffixes duplicate full names with the location, then the row at that location', () => {
    const at = (line: number) => ({ line, column: 5 });
    expect(
      assignTestIds([
        { file: FILE, fullName: 'S > unique', location: at(1) },
        { file: FILE, fullName: 'S > dup', location: at(2) },
        { file: FILE, fullName: 'S > dup', location: at(3) },
        { file: FILE, fullName: 'S > row', location: at(4) },
        { file: FILE, fullName: 'S > row', location: at(4) },
        { file: FILE, fullName: 'S > other', location: at(4) },
        { file: 'test/unit/b.test.ts', fullName: 'S > unique', location: at(1) },
      ]),
    ).toEqual([
      `${FILE}#S > unique`,
      `${FILE}#S > dup:2:5`,
      `${FILE}#S > dup:3:5`,
      `${FILE}#S > row:4:5:0`,
      `${FILE}#S > row:4:5:1`,
      `${FILE}#S > other`,
      'test/unit/b.test.ts#S > unique',
    ]);
  });

  it.each([
    ['dry-run', null, 1, 'dry-run.attempt-1.json'],
    ['mutant', '42', 3, 'mutant-42.attempt-3.json'],
  ] as const)('names a %s record and parses the name back', (kind, mutantId, attempt, name) => {
    expect(recordFileName(kind, mutantId, attempt)).toBe(name);
    expect(parseRecordFileName(name)).toEqual({ kind, mutantId, attempt });
  });

  it.each(['mutant-42.attempt-3.vitest.json', '.mutant-42.attempt-3.json.tmp', 'notes.txt'])(
    'ignores the file name %s',
    (name) => {
      expect(parseRecordFileName(name)).toBeNull();
    },
  );

  it('round-trips a record through JSON and rejects a malformed one', () => {
    const original = record(observed([module([test(0), test(1)])]), 0);
    expect(parseOracleRunRecord(JSON.stringify(original))).toEqual(original);
    expect(() => parseOracleRunRecord(JSON.stringify({ ...original, schemaVersion: 2 }))).toThrow(
      /schemaVersion/,
    );
  });
});

describe('oracle classes without a verdict', () => {
  it('counts exactly infrastructure, inconclusive and invalid as unusable', () => {
    expect(ORACLE_CLASSES.filter(isUnusableClass)).toEqual([
      'infrastructure',
      'inconclusive',
      'invalid',
    ]);
  });
});
