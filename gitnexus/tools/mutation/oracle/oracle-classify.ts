/**
 * The oracle's own outcome classifier (U13, KTD15, KTD17) and the record format it reads.
 *
 * The oracle shares no code with the vitest5 runner (tools/mutation/runner/); this module applies
 * the KTD17 table to the oracle's own observations so gate 3 can compare two independent
 * classifications. It may use the prepare step's report types (KTD18).
 *
 * Record file: command-wrapper.ts writes one {@link OracleRunRecord} (schemaVersion 1) per Vitest
 * run to `<reportDir>/<key>.attempt-<n>.json`, where `<key>` is `dry-run` or `mutant-<local id>`
 * and `<n>` counts the runs of that key from 1 (Stryker reruns a mutant only after a rejected run).
 * Vitest's own JSON report of the same run sits next to it as `<key>.attempt-<n>.vitest.json`.
 *   kind, mutantId          `dry-run` (no active mutant) or `mutant` with Stryker's local id
 *   attempt, pid, root      attempt number, wrapper pid, the Vitest root (the Stryker sandbox)
 *   configFile              absolute Vitest config file
 *   vitestVersion           Vitest version that ran ('' when Vitest did not start)
 *   exitCode, wallClockMs   the wrapper's exit code (Vitest's) and its run time
 *   wrapperError            why Vitest could not run, or null
 *   run                     {@link OracleObservedRun} from oracle-reporter.ts, or null when the
 *                           reporter saw no run end
 *   vitestJson              totals of Vitest's JSON report, or null when it is missing
 *   vitestJsonFile          path of that JSON report
 *
 * KTD17 rows as the oracle observes them:
 *   failed test, first error `AssertionError`                        killed-by-test:assertion
 *   failed test or hook, Vitest's testTimeout/hookTimeout error      timeout
 *   failed test, another error                                       killed-by-test:runtime
 *   failed `beforeEach`, or failed `afterEach` after a passing body   killed-by-test:hook
 *   failed `beforeAll` (its suite's tests skipped)                   killed-outside-test:hook,
 *                                                                    attributed to the suite's
 *                                                                    baseline tests
 *   failed `afterAll`, or another suite-level error                  killed-outside-test:hook,
 *                                                                    no attribution
 *   file error and no test ran (import or collection)               killed-outside-test:collection
 *   unhandled error, interrupted run, reporter or exit-code mismatch infrastructure
 *   an executed test with `retry` above zero                         inconclusive
 *   zero tests ran, a test set different from the baseline, a test
 *   or file that did not finish                                      invalid
 *   every executed test passed                                       survived
 * A failed hook is one whose start Vitest reported without an end (oracle-reporter.ts).
 *
 * Mutant-level precedence: infrastructure, invalid, inconclusive, then the strongest kill
 * (assertion, runtime, test hook, outside-test hook, collection), then timeout, then survived.
 * Before the record is read, Stryker's raw status decides: Timeout is timeout (Stryker's timer,
 * KTD17), NoCoverage is survived (KTD13), a missing record of a run Stryker reports as Killed,
 * Survived or RuntimeError is infrastructure, and a mutant Stryker never ran (Ignored, Pending,
 * CompileError) is invalid (zero tests). A Killed status with exit code 0, or Survived with a
 * non-zero exit, is infrastructure. Kill sets (`killedBy`, `assertionKilledBy`) are filled only for
 * kill classes; gates 3 and 4 count `assertionKilledBy` alone.
 *
 * Test ids follow KTD3: `<file>#<full name>`, a `:<line>:<column>` suffix for full names shared
 * inside a file, and `:<row>` (the 0-based index among all tests at that location) when the
 * location is shared too.
 */
import type { MutantStatus, MutationReport } from '../prepare/mutant-identity.js';

export const ORACLE_RECORD_SCHEMA_VERSION = 1;

export const ORACLE_CLASSES = [
  'killed-by-test:assertion',
  'killed-by-test:runtime',
  'killed-by-test:hook',
  'killed-outside-test:hook',
  'killed-outside-test:collection',
  'timeout',
  'infrastructure',
  'inconclusive',
  'invalid',
  'survived',
] as const;

export type OracleClass = (typeof ORACLE_CLASSES)[number];

/** Kill classes, strongest first. */
export const KILL_ORDER: readonly OracleClass[] = ORACLE_CLASSES.slice(0, 5);

export const isKillClass = (outcome: OracleClass): boolean => KILL_ORDER.includes(outcome);

export type TestHookName = 'beforeEach' | 'afterEach';
export type SuiteHookName = 'beforeAll' | 'afterAll';
export type OracleTestState = 'passed' | 'failed' | 'skipped' | 'pending';

export interface OracleError {
  name: string;
  message: string;
}

export interface OracleTestLocation {
  line: number;
  column: number;
}

export interface OracleTestRecord {
  /** Vitest's full name: suite and test titles joined with `' > '`. */
  fullName: string;
  location: OracleTestLocation | null;
  state: OracleTestState;
  /** In Vitest's order: the body or `beforeEach` error first. */
  errors: OracleError[];
  failedHooks: TestHookName[];
  /** The test's configured `retry` count. */
  retry: number;
  /** Retries Vitest made. */
  retryCount: number;
}

export interface OracleSuiteRecord {
  fullName: string;
  errors: OracleError[];
  failedHooks: SuiteHookName[];
  /** Indexes into the module's tests: every test below the suite, at any depth. */
  tests: number[];
}

export interface OracleModuleRecord {
  /** Package-relative POSIX path. */
  file: string;
  /** Vitest's module state (`passed`, `failed`, `skipped`, `pending` or `queued`). */
  state: string;
  /** Import, collection and file-level hook errors. */
  errors: OracleError[];
  failedHooks: SuiteHookName[];
  suites: OracleSuiteRecord[];
  /** Every test of the file in collection order. */
  tests: OracleTestRecord[];
}

export interface OracleObservedRun {
  reason: 'passed' | 'interrupted' | 'failed';
  unhandledErrors: OracleError[];
  modules: OracleModuleRecord[];
}

/** The totals of Vitest's own JSON report that the classifier cross-checks. */
export interface VitestJsonTotals {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
}

export type RecordKind = 'dry-run' | 'mutant';

export interface OracleRunRecord {
  schemaVersion: typeof ORACLE_RECORD_SCHEMA_VERSION;
  kind: RecordKind;
  mutantId: string | null;
  attempt: number;
  pid: number;
  root: string;
  configFile: string;
  vitestVersion: string;
  exitCode: number;
  wallClockMs: number;
  wrapperError: string | null;
  run: OracleObservedRun | null;
  vitestJson: VitestJsonTotals | null;
  vitestJsonFile: string | null;
}

// ── record files ─────────────────────────────────────────────────────────────

const MUTANT_ID = /^\d+$/;
const RECORD_FILE = /^(?:dry-run|mutant-(\d+))\.attempt-([1-9]\d*)\.json$/;

export function isMutantId(value: string): boolean {
  return MUTANT_ID.test(value);
}

const recordKey = (kind: RecordKind, mutantId: string | null): string => {
  if (kind === 'dry-run') return 'dry-run';
  if (mutantId === null || !isMutantId(mutantId)) {
    throw new Error(`oracle record: invalid mutant id ${JSON.stringify(mutantId)}`);
  }
  return `mutant-${mutantId}`;
};

export function recordFileName(kind: RecordKind, mutantId: string | null, attempt: number): string {
  return `${recordKey(kind, mutantId)}.attempt-${attempt}.json`;
}

export function vitestJsonFileName(
  kind: RecordKind,
  mutantId: string | null,
  attempt: number,
): string {
  return `${recordKey(kind, mutantId)}.attempt-${attempt}.vitest.json`;
}

/** The kind, mutant id and attempt of a record file name; null for any other file. */
export function parseRecordFileName(
  name: string,
): { kind: RecordKind; mutantId: string | null; attempt: number } | null {
  const match = RECORD_FILE.exec(name);
  if (match === null) return null;
  const [, mutantId, attempt] = match;
  return mutantId === undefined
    ? { kind: 'dry-run', mutantId: null, attempt: Number(attempt) }
    : { kind: 'mutant', mutantId, attempt: Number(attempt) };
}

// ── record parsing ───────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(at: string, detail: string): never {
  throw new Error(`oracle record: ${at} ${detail}`);
}

function field(data: JsonObject, key: string, at: string): unknown {
  if (!(key in data)) fail(`${at}.${key}`, 'is missing');
  return data[key];
}

function str(data: JsonObject, key: string, at: string): string {
  const value = field(data, key, at);
  return typeof value === 'string' ? value : fail(`${at}.${key}`, 'must be a string');
}

function nullableStr(data: JsonObject, key: string, at: string): string | null {
  const value = field(data, key, at);
  if (value === null) return null;
  return typeof value === 'string' ? value : fail(`${at}.${key}`, 'must be a string or null');
}

function int(data: JsonObject, key: string, at: string): number {
  const value = field(data, key, at);
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : fail(`${at}.${key}`, 'must be an integer');
}

function list(data: JsonObject, key: string, at: string): unknown[] {
  const value = field(data, key, at);
  return Array.isArray(value) ? value : fail(`${at}.${key}`, 'must be an array');
}

function object(value: unknown, at: string): JsonObject {
  return isObject(value) ? value : fail(at, 'must be an object');
}

function oneOf<T extends string>(value: string, allowed: readonly T[], at: string): T {
  const found = allowed.find((entry) => entry === value);
  return found ?? fail(at, `must be one of ${allowed.join(', ')}`);
}

const TEST_STATES: readonly OracleTestState[] = ['passed', 'failed', 'skipped', 'pending'];
const TEST_HOOKS: readonly TestHookName[] = ['beforeEach', 'afterEach'];
const SUITE_HOOKS: readonly SuiteHookName[] = ['beforeAll', 'afterAll'];
const RUN_REASONS: readonly OracleObservedRun['reason'][] = ['passed', 'interrupted', 'failed'];

const parseErrors = (data: JsonObject, key: string, at: string): OracleError[] =>
  list(data, key, at).map((value, index) => {
    const entry = object(value, `${at}.${key}[${index}]`);
    return {
      name: str(entry, 'name', `${at}.${key}[${index}]`),
      message: str(entry, 'message', `${at}.${key}[${index}]`),
    };
  });

const parseHooks = <T extends string>(data: JsonObject, at: string, allowed: readonly T[]): T[] =>
  list(data, 'failedHooks', at).map((value, index) =>
    oneOf(typeof value === 'string' ? value : '', allowed, `${at}.failedHooks[${index}]`),
  );

function parseTest(value: unknown, at: string): OracleTestRecord {
  const data = object(value, at);
  const location = field(data, 'location', at);
  return {
    fullName: str(data, 'fullName', at),
    location:
      location === null
        ? null
        : {
            line: int(object(location, `${at}.location`), 'line', `${at}.location`),
            column: int(object(location, `${at}.location`), 'column', `${at}.location`),
          },
    state: oneOf(str(data, 'state', at), TEST_STATES, `${at}.state`),
    errors: parseErrors(data, 'errors', at),
    failedHooks: parseHooks(data, at, TEST_HOOKS),
    retry: int(data, 'retry', at),
    retryCount: int(data, 'retryCount', at),
  };
}

function parseSuite(value: unknown, at: string, testCount: number): OracleSuiteRecord {
  const data = object(value, at);
  return {
    fullName: str(data, 'fullName', at),
    errors: parseErrors(data, 'errors', at),
    failedHooks: parseHooks(data, at, SUITE_HOOKS),
    tests: list(data, 'tests', at).map((index, i) =>
      typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < testCount
        ? index
        : fail(`${at}.tests[${i}]`, 'must index a test of the module'),
    ),
  };
}

function parseModule(value: unknown, at: string): OracleModuleRecord {
  const data = object(value, at);
  const tests = list(data, 'tests', at).map((test, i) => parseTest(test, `${at}.tests[${i}]`));
  return {
    file: str(data, 'file', at),
    state: str(data, 'state', at),
    errors: parseErrors(data, 'errors', at),
    failedHooks: parseHooks(data, at, SUITE_HOOKS),
    suites: list(data, 'suites', at).map((suite, i) =>
      parseSuite(suite, `${at}.suites[${i}]`, tests.length),
    ),
    tests,
  };
}

function parseRun(value: unknown): OracleObservedRun | null {
  if (value === null) return null;
  const data = object(value, 'run');
  return {
    reason: oneOf(str(data, 'reason', 'run'), RUN_REASONS, 'run.reason'),
    unhandledErrors: parseErrors(data, 'unhandledErrors', 'run'),
    modules: list(data, 'modules', 'run').map((entry, i) =>
      parseModule(entry, `run.modules[${i}]`),
    ),
  };
}

function parseTotals(value: unknown): VitestJsonTotals | null {
  if (value === null) return null;
  const data = object(value, 'vitestJson');
  return {
    numTotalTests: int(data, 'numTotalTests', 'vitestJson'),
    numPassedTests: int(data, 'numPassedTests', 'vitestJson'),
    numFailedTests: int(data, 'numFailedTests', 'vitestJson'),
  };
}

/** Parses and validates the text of a record file. */
export function parseOracleRunRecord(text: string): OracleRunRecord {
  const data = object(JSON.parse(text), 'root');
  if (field(data, 'schemaVersion', 'root') !== ORACLE_RECORD_SCHEMA_VERSION) {
    fail('root.schemaVersion', `must be ${ORACLE_RECORD_SCHEMA_VERSION}`);
  }
  const kind = oneOf(str(data, 'kind', 'root'), ['dry-run', 'mutant'] as const, 'root.kind');
  const mutantId = nullableStr(data, 'mutantId', 'root');
  if ((kind === 'mutant') !== (mutantId !== null && isMutantId(mutantId))) {
    fail('root.mutantId', `does not fit kind ${kind}`);
  }
  return {
    schemaVersion: ORACLE_RECORD_SCHEMA_VERSION,
    kind,
    mutantId,
    attempt: int(data, 'attempt', 'root'),
    pid: int(data, 'pid', 'root'),
    root: str(data, 'root', 'root'),
    configFile: str(data, 'configFile', 'root'),
    vitestVersion: str(data, 'vitestVersion', 'root'),
    exitCode: int(data, 'exitCode', 'root'),
    wallClockMs: int(data, 'wallClockMs', 'root'),
    wrapperError: nullableStr(data, 'wrapperError', 'root'),
    run: parseRun(field(data, 'run', 'root')),
    vitestJson: parseTotals(field(data, 'vitestJson', 'root')),
    vitestJsonFile: nullableStr(data, 'vitestJsonFile', 'root'),
  };
}

/** Stryker's raw status per local mutant id, from `mutation.json`. */
export function strykerStatuses(report: MutationReport): Map<string, MutantStatus> {
  const statuses = new Map<string, MutantStatus>();
  for (const [file, entry] of Object.entries(report.files)) {
    for (const mutant of entry.mutants) {
      if (statuses.has(mutant.id)) {
        throw new Error(`mutation report: local id ${mutant.id} appears twice (${file})`);
      }
      statuses.set(mutant.id, mutant.status);
    }
  }
  return statuses;
}

// ── errors and test identity ─────────────────────────────────────────────────

const MESSAGE_LIMIT = 2000;
const STACK_ERROR_NAME = /^\s*([A-Za-z_$][\w$]*)(?:\s*\[[^\]\n]*\])?:/;
const VITEST_TIMEOUT =
  /^(?:(?:Test|Hook) timed out in \d+ms|The (?:setup|teardown) phase of "around(?:Each|All)" hook timed out after \d+ms)/;
const NO_TESTS = /^No test found in suite/;

const clip = (text: string): string =>
  text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}...` : text;

/**
 * A Vitest error as the oracle records it. Without a `name`, the name comes from the first word
 * of the stack (`AssertionError: ...`, `AssertionError [ERR_ASSERTION]: ...`), else `Error`.
 */
export function toOracleError(error: {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}): OracleError {
  const fromStack =
    typeof error.stack === 'string' ? STACK_ERROR_NAME.exec(error.stack)?.[1] : undefined;
  const name =
    typeof error.name === 'string' && error.name !== '' ? error.name : (fromStack ?? 'Error');
  const message = typeof error.message === 'string' ? error.message : String(error.message ?? '');
  return { name, message: clip(message) };
}

export const isVitestTimeout = (error: OracleError): boolean => VITEST_TIMEOUT.test(error.message);

export interface OracleTestKey {
  file: string;
  fullName: string;
  location: OracleTestLocation | null;
}

/** KTD3 test ids for tests in collection order (see the module comment). */
export function assignTestIds(tests: readonly OracleTestKey[]): string[] {
  const at = (test: OracleTestKey): string =>
    test.location === null ? '?:?' : `${test.location.line}:${test.location.column}`;
  const count = (keys: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };
  const byName = count(tests.map((test) => `${test.file}#${test.fullName}`));
  const byNameAndPlace = count(tests.map((test) => `${test.file}#${test.fullName}:${at(test)}`));
  const nextRow = new Map<string, number>();
  return tests.map((test) => {
    const place = `${test.file}\0${at(test)}`;
    const row = nextRow.get(place) ?? 0;
    nextRow.set(place, row + 1);
    const base = `${test.file}#${test.fullName}`;
    if ((byName.get(base) ?? 0) < 2) return base;
    const placed = `${base}:${at(test)}`;
    return (byNameAndPlace.get(placed) ?? 0) < 2 ? placed : `${placed}:${row}`;
  });
}

const fileOfId = (id: string): string => id.slice(0, Math.max(0, id.indexOf('#')));

// ── classification ───────────────────────────────────────────────────────────

export interface TestOutcome {
  id: string;
  file: string;
  fullName: string;
  outcome: OracleClass;
  message: string | null;
}

export interface OutsideTestOutcome {
  file: string;
  /** Full name of the suite; null for the file itself. */
  suite: string | null;
  outcome: OracleClass;
  /** Test ids the row kills; empty when the row has no test attribution. */
  attributedTo: string[];
  message: string;
}

export interface RunClassification {
  outcome: OracleClass;
  reason: string | null;
  /** Ids of the tests that ran (passed or failed), in collection order. */
  executed: string[];
  /** Every executed test, and every test a failed `beforeAll` skipped. */
  tests: TestOutcome[];
  outsideTest: OutsideTestOutcome[];
  /** Kill classes only: tests with a kill row and the tests outside-test rows attribute to. */
  killedBy: string[];
  /** Kill classes only: tests killed with an assertion. */
  assertionKilledBy: string[];
}

export interface ClassifyRunOptions {
  /** The wrapper's (Vitest's) exit code. */
  exitCode: number;
  /** Executed test ids of the baseline (dry) run; null when classifying the baseline itself. */
  expected: readonly string[] | null;
  vitestJson: VitestJsonTotals | null;
}

const describeErrors = (errors: readonly OracleError[]): string =>
  errors.map((error) => `${error.name}: ${error.message}`).join('\n');

function classifyFailedTest(test: OracleTestRecord): OracleClass {
  const [first] = test.errors;
  if (first === undefined) return 'killed-by-test:runtime';
  if (isVitestTimeout(first)) return 'timeout';
  const hookFailed =
    test.failedHooks.includes('beforeEach') ||
    (test.failedHooks.includes('afterEach') && test.errors.length === 1);
  if (hookFailed) return 'killed-by-test:hook';
  return first.name === 'AssertionError' ? 'killed-by-test:assertion' : 'killed-by-test:runtime';
}

const hookRowOutcome = (error: OracleError | undefined): OracleClass =>
  error !== undefined && isVitestTimeout(error) ? 'timeout' : 'killed-outside-test:hook';

const ran = (test: OracleTestRecord): boolean => test.state === 'passed' || test.state === 'failed';

interface Scope {
  suite: string | null;
  errors: OracleError[];
  failedHooks: SuiteHookName[];
  tests: number[];
}

/** Classifies one observed Vitest run; pure. See the module comment for the rules. */
export function classifyRun(
  run: OracleObservedRun,
  options: ClassifyRunOptions,
): RunClassification {
  const infrastructure: string[] = [];
  const invalid: string[] = [];
  const inconclusive: string[] = [];
  const tests: TestOutcome[] = [];
  const outsideTest: OutsideTestOutcome[] = [];
  const executed: string[] = [];
  const explained = new Set<string>();
  const collectionFailed = new Set<string>();
  const expected = options.expected === null ? null : new Set(options.expected);

  if (run.unhandledErrors.length > 0) {
    infrastructure.push(`unhandled errors during the run: ${describeErrors(run.unhandledErrors)}`);
  }
  if (run.reason === 'interrupted') infrastructure.push('the Vitest run was interrupted');

  const all = run.modules.flatMap((module) => module.tests);
  const observedTotals: VitestJsonTotals = {
    numTotalTests: all.length,
    numPassedTests: all.filter((test) => test.state === 'passed').length,
    numFailedTests: all.filter((test) => test.state === 'failed').length,
  };
  if (options.vitestJson === null) {
    infrastructure.push('the Vitest JSON report is missing');
  } else {
    const keys = ['numTotalTests', 'numPassedTests', 'numFailedTests'] as const;
    const differing = keys.filter((key) => options.vitestJson?.[key] !== observedTotals[key]);
    if (differing.length > 0) {
      infrastructure.push(
        `the Vitest JSON report disagrees with the oracle reporter on ${differing
          .map((key) => `${key} (${options.vitestJson?.[key]} vs ${observedTotals[key]})`)
          .join(', ')}`,
      );
    }
  }

  for (const module of run.modules) {
    const ids = assignTestIds(
      module.tests.map((test) => ({
        file: module.file,
        fullName: test.fullName,
        location: test.location,
      })),
    );
    const noTests = [...module.errors, ...module.suites.flatMap((suite) => suite.errors)].filter(
      (error) => NO_TESTS.test(error.message),
    );
    for (const error of noTests) invalid.push(`${module.file}: ${error.message}`);
    const loadErrors = module.errors.filter((error) => !NO_TESTS.test(error.message));
    if (loadErrors.length > 0 && module.failedHooks.length === 0 && !module.tests.some(ran)) {
      collectionFailed.add(module.file);
      outsideTest.push({
        file: module.file,
        suite: null,
        outcome: 'killed-outside-test:collection',
        attributedTo: [],
        message: describeErrors(loadErrors),
      });
      continue;
    }
    if (module.state === 'pending' || module.state === 'queued') {
      invalid.push(`${module.file} did not finish (state ${module.state})`);
    }

    const scopes: Scope[] = [
      {
        suite: null,
        errors: loadErrors,
        failedHooks: module.failedHooks,
        tests: module.tests.map((_, index) => index),
      },
      ...module.suites.map((suite) => ({
        suite: suite.fullName,
        errors: suite.errors.filter((error) => !NO_TESTS.test(error.message)),
        failedHooks: suite.failedHooks,
        tests: suite.tests,
      })),
    ];
    const skippedByHook = new Set<number>();
    for (const scope of scopes) {
      if (scope.failedHooks.includes('beforeAll')) {
        const error = scope.errors[0];
        const outcome = hookRowOutcome(error);
        const message = error === undefined ? 'beforeAll failed' : describeErrors([error]);
        const attributed = scope.tests.filter(
          (index) =>
            !ran(module.tests[index]) && (expected === null || expected.has(ids[index] ?? '')),
        );
        for (const index of attributed.filter((entry) => !skippedByHook.has(entry))) {
          skippedByHook.add(index);
          explained.add(ids[index]);
          tests.push({
            id: ids[index],
            file: module.file,
            fullName: module.tests[index].fullName,
            outcome,
            message,
          });
        }
        outsideTest.push({
          file: module.file,
          suite: scope.suite,
          outcome,
          attributedTo: outcome === 'timeout' ? [] : attributed.map((index) => ids[index]),
          message,
        });
      }
      if (scope.failedHooks.includes('afterAll')) {
        const error = scope.errors.at(-1);
        outsideTest.push({
          file: module.file,
          suite: scope.suite,
          outcome: hookRowOutcome(error),
          attributedTo: [],
          message: error === undefined ? 'afterAll failed' : describeErrors([error]),
        });
      }
      if (scope.failedHooks.length === 0 && scope.errors.length > 0) {
        outsideTest.push({
          file: module.file,
          suite: scope.suite,
          outcome: hookRowOutcome(scope.errors[0]),
          attributedTo: [],
          message: describeErrors(scope.errors),
        });
      }
    }

    module.tests.forEach((test, index) => {
      const id = ids[index];
      if (skippedByHook.has(index)) return;
      if (test.state === 'pending') {
        invalid.push(`test ${id} did not finish`);
        return;
      }
      if (!ran(test)) return;
      executed.push(id);
      if (test.retry > 0) inconclusive.push(`${id} has retry ${test.retry}`);
      tests.push({
        id,
        file: module.file,
        fullName: test.fullName,
        outcome: test.state === 'passed' ? 'survived' : classifyFailedTest(test),
        message: test.state === 'passed' ? null : (test.errors[0]?.message ?? null),
      });
    });
  }

  if (expected !== null) {
    const ranSet = new Set(executed);
    for (const id of expected) {
      const accounted = ranSet.has(id) || explained.has(id) || collectionFailed.has(fileOfId(id));
      if (!accounted) invalid.push(`baseline test ${id} did not run`);
    }
    for (const id of executed.filter((entry) => !expected.has(entry))) {
      invalid.push(`test ${id} ran but is not in the baseline`);
    }
  }
  const outsideDecides = outsideTest.some(
    (row) => isKillClass(row.outcome) || row.outcome === 'timeout',
  );
  if (executed.length === 0 && !outsideDecides) invalid.push('zero tests ran');

  const failureObserved =
    run.unhandledErrors.length > 0 ||
    all.some((test) => test.state === 'failed') ||
    run.modules.some(
      (module) =>
        module.errors.length > 0 || module.suites.some((suite) => suite.errors.length > 0),
    );
  if (options.exitCode === 0 && failureObserved) {
    infrastructure.push('Vitest exited 0 although the run failed');
  }
  if (options.exitCode !== 0 && !failureObserved && invalid.length === 0) {
    infrastructure.push(`Vitest exited ${options.exitCode} but the oracle reporter saw no failure`);
  }

  const rows = [...tests.map((test) => test.outcome), ...outsideTest.map((row) => row.outcome)];
  const decide = (outcome: OracleClass, reason: string | null): RunClassification => {
    const kill = isKillClass(outcome);
    return {
      outcome,
      reason,
      executed,
      tests,
      outsideTest,
      killedBy: kill
        ? [
            ...new Set([
              ...tests.filter((test) => isKillClass(test.outcome)).map((test) => test.id),
              ...outsideTest.flatMap((row) => row.attributedTo),
            ]),
          ]
        : [],
      assertionKilledBy: kill
        ? tests.filter((test) => test.outcome === 'killed-by-test:assertion').map((test) => test.id)
        : [],
    };
  };
  if (infrastructure.length > 0) return decide('infrastructure', infrastructure.join('; '));
  if (invalid.length > 0) return decide('invalid', invalid.join('; '));
  if (inconclusive.length > 0) {
    return decide('inconclusive', `executed tests use retry: ${inconclusive.join('; ')}`);
  }
  const kill = KILL_ORDER.find((outcome) => rows.includes(outcome));
  if (kill !== undefined) return decide(kill, null);
  if (rows.includes('timeout')) {
    const timedOut = [...tests, ...outsideTest].find((row) => row.outcome === 'timeout');
    return decide('timeout', timedOut?.message ?? 'a Vitest timeout');
  }
  return decide('survived', null);
}

/** How a mutant's class was decided. */
export type OutcomeSource =
  | 'report'
  | 'stryker-timeout'
  | 'no-coverage'
  | 'missing-report'
  | 'not-run';

export interface ClassifyMutantInput {
  /** Stryker's raw status (`mutation.json`). */
  strykerStatus: MutantStatus;
  /** The latest record of the mutant, or null when there is none. */
  record: OracleRunRecord | null;
  /** Executed test ids of the baseline run; null when no baseline is known. */
  expected: readonly string[] | null;
}

export interface MutantClassification extends RunClassification {
  source: OutcomeSource;
}

/** Statuses of runs the command runner finished: each one must have left a record. */
const RAN_STATUSES: ReadonlySet<MutantStatus> = new Set(['Killed', 'Survived', 'RuntimeError']);

const noRun = (
  outcome: OracleClass,
  source: OutcomeSource,
  reason: string,
): MutantClassification => ({
  outcome,
  source,
  reason,
  executed: [],
  tests: [],
  outsideTest: [],
  killedBy: [],
  assertionKilledBy: [],
});

/** Classifies a record; a record without an observed run is infrastructure. */
export function classifyRecord(
  record: OracleRunRecord,
  expected: readonly string[] | null,
): RunClassification {
  if (record.wrapperError !== null || record.run === null) {
    return noRun(
      'infrastructure',
      'report',
      record.wrapperError ?? 'the oracle reporter saw no end of the Vitest run',
    );
  }
  return classifyRun(record.run, {
    exitCode: record.exitCode,
    expected,
    vitestJson: record.vitestJson,
  });
}

function statusProblem(status: MutantStatus, exitCode: number): string | null {
  if (status === 'Killed') {
    return exitCode === 0 ? 'Stryker reports Killed but the wrapper exited 0' : null;
  }
  if (status === 'Survived') {
    return exitCode === 0 ? null : `Stryker reports Survived but the wrapper exited ${exitCode}`;
  }
  return `Stryker reports ${status} for a run that left a record`;
}

/** Classifies one mutant from its Stryker status and latest record; pure. */
export function classifyMutant(input: ClassifyMutantInput): MutantClassification {
  const { strykerStatus, record, expected } = input;
  if (strykerStatus === 'Timeout') {
    const observed = record === null ? null : classifyRecord(record, expected);
    return {
      ...(observed ?? noRun('timeout', 'stryker-timeout', '')),
      outcome: 'timeout',
      source: 'stryker-timeout',
      reason:
        observed === null
          ? 'Stryker timed out the run; no record was written'
          : `Stryker timed out the run; its record classifies as ${observed.outcome}`,
      killedBy: [],
      assertionKilledBy: [],
    };
  }
  if (strykerStatus === 'NoCoverage') {
    return noRun('survived', 'no-coverage', 'Stryker found no test covering the mutant');
  }
  if (record === null) {
    return RAN_STATUSES.has(strykerStatus)
      ? noRun(
          'infrastructure',
          'missing-report',
          `no record for a run Stryker reports as ${strykerStatus}`,
        )
      : noRun('invalid', 'not-run', `Stryker did not run the mutant (status ${strykerStatus})`);
  }
  const classified = classifyRecord(record, expected);
  const problem = statusProblem(strykerStatus, record.exitCode);
  if (problem !== null) {
    return {
      ...classified,
      outcome: 'infrastructure',
      source: 'report',
      reason: problem,
      killedBy: [],
      assertionKilledBy: [],
    };
  }
  return { ...classified, source: 'report' };
}
