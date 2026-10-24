/**
 * The oracle probe (U12, KTD15): what oracle-setup.ts observes inside the Vitest worker of one
 * single-test launch (launch-single.ts), written as JSON to the file named by
 * {@link PROBE_FILE_ENV}. Both sides import this module, so it holds no side effects and no
 * Vitest import.
 *
 * Probe file, schemaVersion 1:
 *   pid                       the worker's pid
 *   activation                checked by the setup file before the test file is imported:
 *     intended                the mutant id the launcher meant to install ({@link INTENDED_MUTANT_ENV};
 *                             null for an unmutated baseline launch)
 *     installed               `__STRYKER_ACTIVE_MUTANT__` in the worker's environment (null when
 *                             unset or empty); the instrumented code activates this id
 *     instrumentedBeforeSetup whether Stryker's namespace already existed, i.e. instrumented code
 *                             ran before the setup file
 *     namespaceActiveMutant   the namespace's active mutant at that point, or null
 *     matches                 installed equals intended and no instrumented code ran before
 *   hits                      null until the file's run ends (the setup file's file-level
 *                             `aroundAll` teardown); then the installed mutant's hits, counted
 *                             apart from activation, in three buckets:
 *     loadAndCollection       before the file's run started: module load and test collection
 *     hook                    during the run with no current test: `beforeAll`/`afterAll` hooks
 *                             (and `aroundAll`) of a suite
 *     perTest[]               {taskId, fullName, location, count} while a test is current: its
 *                             body, its `beforeEach`/`afterEach` hooks and fixtures
 *   complete                  true once `hits` is written
 *   coverage                  written with `hits` (absent in older probes): the ids of the mutants
 *                             whose coverage counter (the instrumenter's `stryCov`) ran, sorted
 *                             numerically, in the same three buckets: `loadAndCollection`, `hook`
 *                             and `test` (while any test was current). The instrumenter calls the
 *                             counter on every executed mutant site except the active mutant's own,
 *                             so an unmutated baseline launch records the test's full coverage;
 *                             the oracle freeze (freeze.ts) derives its strata populations from it.
 * A hit is one evaluation of the installed mutant's switch that selected the mutated code
 * (Stryker's instrumenter counts it in `hitCount`). The baseline launch has no hits.
 */

export const PROBE_SCHEMA_VERSION = 1;

/** Absolute probe file for the worker's setup file. */
export const PROBE_FILE_ENV = 'GITNEXUS_ORACLE_PROBE_FILE';
/** The mutant id the launcher means to install; empty for an unmutated baseline launch. */
export const INTENDED_MUTANT_ENV = 'GITNEXUS_ORACLE_INTENDED_MUTANT';

export interface ProbeActivation {
  intended: string | null;
  installed: string | null;
  instrumentedBeforeSetup: boolean;
  namespaceActiveMutant: string | null;
  matches: boolean;
}

export interface ProbeTestHits {
  /** Vitest task id of the test. */
  taskId: string;
  /** Suite and test titles joined with `' > '`. */
  fullName: string;
  location: { line: number; column: number } | null;
  count: number;
}

export interface ProbeHits {
  loadAndCollection: number;
  hook: number;
  perTest: ProbeTestHits[];
}

/** Mutant ids whose coverage counter ran, per bucket; sorted numerically. */
export interface ProbeCoverage {
  loadAndCollection: string[];
  hook: string[];
  test: string[];
}

export interface OracleProbe {
  schemaVersion: typeof PROBE_SCHEMA_VERSION;
  pid: number;
  activation: ProbeActivation;
  hits: ProbeHits | null;
  complete: boolean;
  /** Absent until the run ends, and in probes written before coverage was recorded. */
  coverage?: ProbeCoverage;
}

/** An environment value as a mutant id: unset and empty mean no mutant. */
export const mutantIdFromEnv = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

/** The activation check of the setup file; pure. */
export function checkActivation(input: {
  intended: string | null;
  installed: string | null;
  namespaceExists: boolean;
  namespaceActiveMutant: string | null;
}): ProbeActivation {
  return {
    intended: input.intended,
    installed: input.installed,
    instrumentedBeforeSetup: input.namespaceExists,
    namespaceActiveMutant: input.namespaceActiveMutant,
    matches: input.installed === input.intended && !input.namespaceExists,
  };
}

/** Total hits of a probe's buckets; 0 without hits. */
export const totalHits = (hits: ProbeHits | null): number =>
  hits === null
    ? 0
    : hits.loadAndCollection + hits.hook + hits.perTest.reduce((sum, test) => sum + test.count, 0);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(at: string, detail: string): never {
  throw new Error(`oracle probe: ${at} ${detail}`);
}

function get(data: JsonObject, key: string, at: string): unknown {
  if (!(key in data)) fail(`${at}.${key}`, 'is missing');
  return data[key];
}

function count(data: JsonObject, key: string, at: string): number {
  const value = get(data, key, at);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fail(`${at}.${key}`, 'must be a non-negative integer');
}

function nullableString(data: JsonObject, key: string, at: string): string | null {
  const value = get(data, key, at);
  if (value === null) return null;
  return typeof value === 'string' ? value : fail(`${at}.${key}`, 'must be a string or null');
}

function bool(data: JsonObject, key: string, at: string): boolean {
  const value = get(data, key, at);
  return typeof value === 'boolean' ? value : fail(`${at}.${key}`, 'must be a boolean');
}

function object(value: unknown, at: string): JsonObject {
  return isObject(value) ? value : fail(at, 'must be an object');
}

function parseTestHits(value: unknown, at: string): ProbeTestHits {
  const data = object(value, at);
  const taskId = get(data, 'taskId', at);
  const fullName = get(data, 'fullName', at);
  const location = get(data, 'location', at);
  return {
    taskId: typeof taskId === 'string' ? taskId : fail(`${at}.taskId`, 'must be a string'),
    fullName: typeof fullName === 'string' ? fullName : fail(`${at}.fullName`, 'must be a string'),
    location:
      location === null
        ? null
        : {
            line: count(object(location, `${at}.location`), 'line', `${at}.location`),
            column: count(object(location, `${at}.location`), 'column', `${at}.location`),
          },
    count: count(data, 'count', at),
  };
}

function ids(data: JsonObject, key: string, at: string): string[] {
  const value = get(data, key, at);
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value.map(String)
    : fail(`${at}.${key}`, 'must be an array of strings');
}

function parseCoverage(value: unknown, at: string): ProbeCoverage {
  const data = object(value, at);
  return {
    loadAndCollection: ids(data, 'loadAndCollection', at),
    hook: ids(data, 'hook', at),
    test: ids(data, 'test', at),
  };
}

/** Parses and validates the text of a probe file. */
export function parseOracleProbe(text: string): OracleProbe {
  const data = object(JSON.parse(text), 'root');
  if (get(data, 'schemaVersion', 'root') !== PROBE_SCHEMA_VERSION) {
    fail('root.schemaVersion', `must be ${PROBE_SCHEMA_VERSION}`);
  }
  const activation = object(get(data, 'activation', 'root'), 'root.activation');
  const hitsValue = get(data, 'hits', 'root');
  const hits = hitsValue === null ? null : object(hitsValue, 'root.hits');
  const perTest = hits === null ? [] : get(hits, 'perTest', 'root.hits');
  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    pid: count(data, 'pid', 'root'),
    activation: {
      intended: nullableString(activation, 'intended', 'root.activation'),
      installed: nullableString(activation, 'installed', 'root.activation'),
      instrumentedBeforeSetup: bool(activation, 'instrumentedBeforeSetup', 'root.activation'),
      namespaceActiveMutant: nullableString(activation, 'namespaceActiveMutant', 'root.activation'),
      matches: bool(activation, 'matches', 'root.activation'),
    },
    hits:
      hits === null
        ? null
        : {
            loadAndCollection: count(hits, 'loadAndCollection', 'root.hits'),
            hook: count(hits, 'hook', 'root.hits'),
            perTest: Array.isArray(perTest)
              ? perTest.map((entry, i) => parseTestHits(entry, `root.hits.perTest[${i}]`))
              : fail('root.hits.perTest', 'must be an array'),
          },
    complete: bool(data, 'complete', 'root'),
    ...('coverage' in data ? { coverage: parseCoverage(data.coverage, 'root.coverage') } : {}),
  };
}
