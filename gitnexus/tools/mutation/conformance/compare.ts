/**
 * Gate 2 conformance (U4): the expected-results file of the conformance fixture, the observed view
 * of its runs, and the comparison between them. This module is pure; run-conformance.ts runs the
 * fixture through the scope driver and does the file I/O.
 *
 * `test/fixtures/mutation-conformance/expected.json` ({@link ExpectedConformance}):
 *   profiles[]  {name, concurrency, maxTestRunnerReuse}: one Stryker run per scope each
 *   scopes[]    {name, testFiles, mutate, tests}: fixture-relative case and production files, and
 *               the complete pinned test inventory {id, skipped, notOracleValidated}
 *   cases[]     one entry per pinned case, by `kind`:
 *     mutant       a planted mutant, selected by {file, location "L:C-L:C", mutatorName,
 *                  replacement}, with every pinned fact ({@link MutantFacts}); the same in every
 *                  profile
 *     tests        tests of a scope with pinned ids and flags
 *     processes    a profile's process rule ({@link ProcessRule}), optionally with two mutant cases
 *                  that one process must run back to back (`consecutive`)
 *     environment  a profile that runs with `__STRYKER_ACTIVE_MUTANT__` exported in the driver's
 *                  environment, set to the pinned local id of another case's mutant
 *
 * Test ids and file paths are fixture-relative: `runtime.case.ts#doubles two` stands for the
 * runner id `test/fixtures/mutation-conformance/runtime.case.ts#doubles two`. Mutants Stryker
 * reports as Ignored (disabled by a `// Stryker disable` comment in the fixture) are not compared;
 * every other mutant must match exactly one mutant case, or it is reported as unexpected.
 *
 * Mutant facts. `selected` is the run's requested test set from the latest sidecar record (`"all"`
 * when it is the scope's whole manifest test set). `tests` lists the per-test outcome classes of
 * that record other than `survived`, so `{}` means every selected test passed. `reason` is a
 * substring the record's reason must contain, or null when it must have none. `selected`, `tests`,
 * `outsideTest` and `reason` are null for a mutant without a sidecar record (NoCoverage).
 */
import type {
  FlagKind,
  NormalisedMutant,
  NormalisedTest,
  OutcomeSource,
  RunResults,
} from '../driver/normalise-results.js';
import { MUTANT_STATUSES, type MutantStatus } from '../prepare/mutant-identity.js';
import type { OutcomeClass } from '../runner/classify-outcome.js';
import type { SidecarRecord } from '../runner/sidecar.js';

export const EXPECTED_SCHEMA_VERSION = 1;

export const OUTCOME_CLASSES: readonly OutcomeClass[] = [
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
];

const OUTCOME_SOURCES: readonly OutcomeSource[] = [
  'sidecar',
  'no-coverage',
  'stryker-timeout',
  'none',
];

const FLAG_KINDS: readonly FlagKind[] = [
  'dry-run-missing',
  'unmapped-test-id',
  'orphan-sidecar',
  'killed-by-without-sidecar',
  'killed-without-sidecar',
  'missing-sidecar',
  'killed-by-not-in-sidecar',
  'status-mismatch',
  'zero-tests',
];

/**
 * `one-mutant-run-per-process`: no runner process handles more than one mutant run, so every run
 * but at most one comes from a process that never ran the dry run (`maxTestRunnerReuse: 1`).
 * `every-run-in-the-dry-run-process`: the process that ran the dry run handles every mutant run.
 */
export const PROCESS_RULES = [
  'one-mutant-run-per-process',
  'every-run-in-the-dry-run-process',
] as const;
export type ProcessRule = (typeof PROCESS_RULES)[number];

export interface Profile {
  name: string;
  concurrency: number;
  maxTestRunnerReuse: number;
}

export interface TestPin {
  id: string;
  skipped: boolean;
  notOracleValidated: boolean;
}

export interface ScopeSpec {
  name: string;
  /** Fixture-relative case files. */
  testFiles: string[];
  /** Fixture-relative production files. */
  mutate: string[];
  /** The complete test inventory of the scope's run manifest. */
  tests: TestPin[];
}

export interface MutantSelector {
  /** Fixture-relative production file. */
  file: string;
  /** `<start line>:<start column>-<end line>:<end column>`, 1-based, end exclusive. */
  location: string;
  mutatorName: string;
  replacement: string;
}

export interface OutsideTestFact {
  file: string;
  outcome: OutcomeClass;
  attributedTo: string[];
}

export interface MutantFacts {
  status: MutantStatus;
  static: boolean | null;
  outcome: OutcomeClass | null;
  outcomeSource: OutcomeSource;
  coveredBy: string[] | null;
  selected: 'all' | string[] | null;
  killedBy: string[];
  assertionKilledBy: string[];
  tests: Record<string, OutcomeClass> | null;
  outsideTest: OutsideTestFact[] | null;
  reason: string | null;
  flags: FlagKind[];
}

export interface MutantCase {
  kind: 'mutant';
  name: string;
  scope: string;
  mutant: MutantSelector;
  expect: MutantFacts;
}

export interface TestsCase {
  kind: 'tests';
  name: string;
  scope: string;
  tests: TestPin[];
}

export interface ProcessesCase {
  kind: 'processes';
  name: string;
  profile: string;
  rule: ProcessRule;
  /** Two mutant case names whose runs must follow each other in one process; null for none. */
  consecutive: [string, string] | null;
}

export interface EnvironmentCase {
  kind: 'environment';
  name: string;
  profile: string;
  /** The mutant case whose local id is exported as `__STRYKER_ACTIVE_MUTANT__`. */
  activeMutantOf: string;
  localId: string;
}

export type ExpectedCase = MutantCase | TestsCase | ProcessesCase | EnvironmentCase;

export interface ExpectedConformance {
  schemaVersion: typeof EXPECTED_SCHEMA_VERSION;
  profiles: Profile[];
  scopes: ScopeSpec[];
  cases: ExpectedCase[];
}

export interface MutantRun {
  pid: number;
  writtenAtMs: number;
}

export interface ObservedMutant extends MutantSelector {
  localId: string;
  /** `reason` holds the full sidecar reason here. */
  facts: MutantFacts;
  /** Every sidecar attempt, oldest first. */
  runs: MutantRun[];
}

export interface ObservedScopeRun {
  profile: string;
  scope: string;
  /** Every mutant that is not Ignored. */
  mutants: ObservedMutant[];
  tests: TestPin[];
  dryRunPid: number | null;
  /** Run-level integrity flags of the scope driver (`<kind>: <detail>`). */
  runFlags: string[];
  spanMapFailures: number;
  /** The `__STRYKER_ACTIVE_MUTANT__` value the driver exported for this run, if any. */
  exportedActiveMutant: string | null;
}

export interface Difference {
  profile: string | null;
  scope: string | null;
  /** The case (or check) that failed. */
  case: string;
  detail: string;
}

// ── Parsing ────────────────────────────────────────────────────────────────

const sorted = <T extends string>(values: readonly T[]): T[] => [...values].sort();

const show = (value: unknown): string => JSON.stringify(value);

type Json = Record<string, unknown>;

class ExpectedFileError extends Error {
  override name = 'ExpectedFileError';
}

const fail = (where: string, detail: string): never => {
  throw new ExpectedFileError(`expected conformance file: ${where}: ${detail}`);
};

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function object(value: unknown, where: string, keys: readonly string[]): Json {
  if (!isRecord(value)) return fail(where, 'must be an object');
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) fail(where, `unknown key ${JSON.stringify(unknown[0])}`);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) fail(where, `missing key ${JSON.stringify(missing[0])}`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') return fail(where, 'must be a non-empty string');
  return value;
}

function integer(value: unknown, where: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    return fail(where, `must be an integer of at least ${minimum}`);
  }
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') return fail(where, 'must be a boolean');
  return value;
}

function list<T>(value: unknown, where: string, item: (entry: unknown, at: string) => T): T[] {
  if (!Array.isArray(value)) return fail(where, 'must be an array');
  return value.map((entry, index) => item(entry, `${where}[${index}]`));
}

function oneOf<T extends string>(value: unknown, where: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  return found ?? fail(where, `must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
}

const nullable = <T>(value: unknown, parse: (entry: unknown) => T): T | null =>
  value === null ? null : parse(value);

const texts = (value: unknown, where: string): string[] => list(value, where, text);

function parseTestPin(value: unknown, where: string): TestPin {
  const data = object(value, where, ['id', 'skipped', 'notOracleValidated']);
  return {
    id: text(data.id, `${where}.id`),
    skipped: bool(data.skipped, `${where}.skipped`),
    notOracleValidated: bool(data.notOracleValidated, `${where}.notOracleValidated`),
  };
}

const LOCATION = /^\d+:\d+-\d+:\d+$/;

function parseSelector(value: unknown, where: string): MutantSelector {
  const data = object(value, where, ['file', 'location', 'mutatorName', 'replacement']);
  const location = text(data.location, `${where}.location`);
  if (!LOCATION.test(location)) fail(`${where}.location`, 'must look like "7:12-7:20"');
  if (typeof data.replacement !== 'string') fail(`${where}.replacement`, 'must be a string');
  return {
    file: text(data.file, `${where}.file`),
    location,
    mutatorName: text(data.mutatorName, `${where}.mutatorName`),
    replacement: String(data.replacement),
  };
}

const FACT_KEYS: readonly (keyof MutantFacts)[] = [
  'status',
  'static',
  'outcome',
  'outcomeSource',
  'coveredBy',
  'selected',
  'killedBy',
  'assertionKilledBy',
  'tests',
  'outsideTest',
  'reason',
  'flags',
];

function parseFacts(value: unknown, where: string): MutantFacts {
  const data = object(value, where, FACT_KEYS);
  const at = (key: string): string => `${where}.${key}`;
  return {
    status: oneOf(data.status, at('status'), MUTANT_STATUSES),
    static: nullable(data.static, (entry) => bool(entry, at('static'))),
    outcome: nullable(data.outcome, (entry) => oneOf(entry, at('outcome'), OUTCOME_CLASSES)),
    outcomeSource: oneOf(data.outcomeSource, at('outcomeSource'), OUTCOME_SOURCES),
    coveredBy: nullable(data.coveredBy, (entry) => texts(entry, at('coveredBy'))),
    selected: nullable(data.selected, (entry) =>
      entry === 'all' ? 'all' : texts(entry, at('selected')),
    ),
    killedBy: texts(data.killedBy, at('killedBy')),
    assertionKilledBy: texts(data.assertionKilledBy, at('assertionKilledBy')),
    tests: nullable(data.tests, (entry) => {
      if (!isRecord(entry)) return fail(at('tests'), 'must be an object or null');
      return Object.fromEntries(
        Object.entries(entry).map(([id, outcome]) => [
          id,
          oneOf(outcome, `${at('tests')}[${JSON.stringify(id)}]`, OUTCOME_CLASSES),
        ]),
      );
    }),
    outsideTest: nullable(data.outsideTest, (entry) =>
      list(entry, at('outsideTest'), (row, rowAt) => {
        const fields = object(row, rowAt, ['file', 'outcome', 'attributedTo']);
        return {
          file: text(fields.file, `${rowAt}.file`),
          outcome: oneOf(fields.outcome, `${rowAt}.outcome`, OUTCOME_CLASSES),
          attributedTo: texts(fields.attributedTo, `${rowAt}.attributedTo`),
        };
      }),
    ),
    reason: nullable(data.reason, (entry) => text(entry, at('reason'))),
    flags: list(data.flags, at('flags'), (flag, flagAt) => oneOf(flag, flagAt, FLAG_KINDS)),
  };
}

const CASE_KINDS = ['mutant', 'tests', 'processes', 'environment'] as const;

function parseCase(value: unknown, where: string): ExpectedCase {
  if (!isRecord(value)) return fail(where, 'must be an object');
  const kind = oneOf(value.kind, `${where}.kind`, CASE_KINDS);
  switch (kind) {
    case 'mutant': {
      const data = object(value, where, ['kind', 'name', 'scope', 'mutant', 'expect']);
      return {
        kind,
        name: text(data.name, `${where}.name`),
        scope: text(data.scope, `${where}.scope`),
        mutant: parseSelector(data.mutant, `${where}.mutant`),
        expect: parseFacts(data.expect, `${where}.expect`),
      };
    }
    case 'tests': {
      const data = object(value, where, ['kind', 'name', 'scope', 'tests']);
      return {
        kind,
        name: text(data.name, `${where}.name`),
        scope: text(data.scope, `${where}.scope`),
        tests: list(data.tests, `${where}.tests`, parseTestPin),
      };
    }
    case 'processes': {
      const data = object(value, where, ['kind', 'name', 'profile', 'rule', 'consecutive']);
      const consecutive = nullable(data.consecutive, (entry) => {
        const names = texts(entry, `${where}.consecutive`);
        if (names.length !== 2) fail(`${where}.consecutive`, 'must name two mutant cases');
        return [names[0], names[1]] satisfies [string, string];
      });
      return {
        kind,
        name: text(data.name, `${where}.name`),
        profile: text(data.profile, `${where}.profile`),
        rule: oneOf(data.rule, `${where}.rule`, PROCESS_RULES),
        consecutive,
      };
    }
    case 'environment': {
      const data = object(value, where, ['kind', 'name', 'profile', 'activeMutantOf', 'localId']);
      return {
        kind,
        name: text(data.name, `${where}.name`),
        profile: text(data.profile, `${where}.profile`),
        activeMutantOf: text(data.activeMutantOf, `${where}.activeMutantOf`),
        localId: text(data.localId, `${where}.localId`),
      };
    }
  }
}

function checkReferences(doc: ExpectedConformance): void {
  const unique = (names: readonly string[], what: string): void => {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) fail(what, `${JSON.stringify(name)} is listed twice`);
      seen.add(name);
    }
  };
  unique(
    doc.profiles.map((profile) => profile.name),
    'profiles',
  );
  unique(
    doc.scopes.map((scope) => scope.name),
    'scopes',
  );
  unique(
    doc.cases.map((entry) => entry.name),
    'cases',
  );
  const profiles = new Set(doc.profiles.map((profile) => profile.name));
  const scopes = new Set(doc.scopes.map((scope) => scope.name));
  const mutantCases = new Set(
    doc.cases.filter((entry) => entry.kind === 'mutant').map((entry) => entry.name),
  );
  for (const entry of doc.cases) {
    const where = `case ${JSON.stringify(entry.name)}`;
    if ('scope' in entry && !scopes.has(entry.scope)) fail(where, `unknown scope ${entry.scope}`);
    if ('profile' in entry && !profiles.has(entry.profile)) {
      fail(where, `unknown profile ${entry.profile}`);
    }
    const refs =
      entry.kind === 'processes'
        ? (entry.consecutive ?? [])
        : entry.kind === 'environment'
          ? [entry.activeMutantOf]
          : [];
    for (const ref of refs.filter((name) => !mutantCases.has(name))) {
      fail(where, `${JSON.stringify(ref)} is not a mutant case`);
    }
  }
}

/** Parses and validates the expected-results file. */
export function parseExpected(source: string): ExpectedConformance {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return fail(
      'file',
      `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const root = object(data, 'root', ['schemaVersion', 'profiles', 'scopes', 'cases']);
  if (root.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    fail('schemaVersion', `must be ${EXPECTED_SCHEMA_VERSION}`);
  }
  const doc: ExpectedConformance = {
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    profiles: list(root.profiles, 'profiles', (value, where) => {
      const data = object(value, where, ['name', 'concurrency', 'maxTestRunnerReuse']);
      return {
        name: text(data.name, `${where}.name`),
        concurrency: integer(data.concurrency, `${where}.concurrency`, 1),
        maxTestRunnerReuse: integer(data.maxTestRunnerReuse, `${where}.maxTestRunnerReuse`, 0),
      };
    }),
    scopes: list(root.scopes, 'scopes', (value, where) => {
      const data = object(value, where, ['name', 'testFiles', 'mutate', 'tests']);
      return {
        name: text(data.name, `${where}.name`),
        testFiles: texts(data.testFiles, `${where}.testFiles`),
        mutate: texts(data.mutate, `${where}.mutate`),
        tests: list(data.tests, `${where}.tests`, parseTestPin),
      };
    }),
    cases: list(root.cases, 'cases', parseCase),
  };
  checkReferences(doc);
  return doc;
}

// ── Observation ────────────────────────────────────────────────────────────

export interface ObserveInput {
  profile: string;
  scope: string;
  results: Pick<RunResults, 'mutants' | 'tests' | 'flags' | 'spanMap'>;
  /** Sidecar records by file path; must hold the latest record of every mutant that has one. */
  records: ReadonlyMap<string, SidecarRecord>;
  dryRunPid: number | null;
  exportedActiveMutant: string | null;
  /** Package-relative fixture directory, e.g. `test/fixtures/mutation-conformance`. */
  fixtureRoot: string;
}

/** Strips the fixture directory from package-relative or repo-relative paths and test ids. */
export function fixtureRelative(value: string, fixtureRoot: string): string {
  for (const prefix of [`${fixtureRoot}/`, `gitnexus/${fixtureRoot}/`]) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

const formatLocation = ({ location: { start, end } }: NormalisedMutant): string =>
  `${start.line}:${start.column}-${end.line}:${end.column}`;

function observeMutant(
  mutant: NormalisedMutant,
  input: ObserveInput,
  allTests: ReadonlySet<string>,
): ObservedMutant {
  const relative = (value: string): string => fixtureRelative(value, input.fixtureRoot);
  const ids = (values: readonly string[]): string[] => sorted(values.map(relative));
  const sidecar = mutant.sidecar;
  const record = sidecar === null ? undefined : input.records.get(sidecar.file);
  if (sidecar !== null && record === undefined) {
    throw new Error(`conformance: the sidecar record ${sidecar.file} was not read`);
  }
  const requested = record?.requestedTestIds ?? [];
  const isAll =
    record !== undefined &&
    requested.length === allTests.size &&
    requested.every((id) => allTests.has(id));
  return {
    file: relative(mutant.file),
    location: formatLocation(mutant),
    mutatorName: mutant.mutatorName,
    replacement: mutant.replacement,
    localId: mutant.localId,
    facts: {
      status: mutant.status,
      static: mutant.static,
      outcome: mutant.outcome,
      outcomeSource: mutant.outcomeSource,
      coveredBy: mutant.coveredBy === null ? null : ids(mutant.coveredBy),
      selected: record === undefined ? null : isAll ? 'all' : ids(requested),
      killedBy: ids(mutant.killedBy),
      assertionKilledBy: ids(mutant.assertionKilledBy),
      tests:
        record === undefined
          ? null
          : Object.fromEntries(
              record.result.tests
                .filter((test) => test.outcome !== 'survived')
                .map((test) => [relative(test.id), test.outcome] as const)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            ),
      outsideTest:
        record === undefined
          ? null
          : record.result.outsideTest.map((row) => ({
              file: relative(row.file),
              outcome: row.outcome,
              attributedTo: ids(row.attributedTo),
            })),
      reason: record === undefined ? null : (record.result.reason ?? null),
      flags: sorted(mutant.flags),
    },
    runs: mutant.attempts.map(({ pid, writtenAtMs }) => ({ pid, writtenAtMs })),
  };
}

const observeTest = (test: NormalisedTest, fixtureRoot: string): TestPin => ({
  id: fixtureRelative(test.id, fixtureRoot),
  skipped: test.skipped,
  notOracleValidated: test.notOracleValidated,
});

/** The observed view of one scope run; see the module comment for each fact. */
export function observeScopeRun(input: ObserveInput): ObservedScopeRun {
  const { results } = input;
  const allTests = new Set(results.tests.filter((test) => !test.skipped).map((test) => test.id));
  return {
    profile: input.profile,
    scope: input.scope,
    mutants: results.mutants
      .filter((mutant) => mutant.status !== 'Ignored')
      .map((mutant) => observeMutant(mutant, input, allTests)),
    tests: results.tests.map((test) => observeTest(test, input.fixtureRoot)),
    dryRunPid: input.dryRunPid,
    runFlags: results.flags
      .filter((flag) => flag.localId === null)
      .map((flag) => `${flag.kind}: ${flag.detail}`),
    spanMapFailures: results.spanMap.failures.length,
    exportedActiveMutant: input.exportedActiveMutant,
  };
}

// ── Comparison ─────────────────────────────────────────────────────────────

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  show(sorted(a)) === show(sorted(b));

const sameNullableList = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === null || b === null ? a === b : sameList(a, b);

const sameSelection = (a: MutantFacts['selected'], b: MutantFacts['selected']): boolean =>
  a === 'all' || b === 'all' || a === null || b === null ? a === b : sameList(a, b);

const sameTests = (a: MutantFacts['tests'], b: MutantFacts['tests']): boolean =>
  a === null || b === null
    ? a === b
    : show(Object.entries(a).sort()) === show(Object.entries(b).sort());

const outsideKey = (rows: readonly OutsideTestFact[] | null): string =>
  rows === null
    ? 'null'
    : show(rows.map((row) => show({ ...row, attributedTo: sorted(row.attributedTo) })).sort());

/** `null` expected means no reason; a string must occur in the observed reason. */
const reasonMatches = (expected: string | null, observed: string | null): boolean =>
  expected === null ? observed === null : observed !== null && observed.includes(expected);

const FACT_CHECKS: readonly {
  key: keyof MutantFacts;
  same: (expected: MutantFacts, observed: MutantFacts) => boolean;
}[] = [
  { key: 'status', same: (e, o) => e.status === o.status },
  { key: 'static', same: (e, o) => e.static === o.static },
  { key: 'outcome', same: (e, o) => e.outcome === o.outcome },
  { key: 'outcomeSource', same: (e, o) => e.outcomeSource === o.outcomeSource },
  { key: 'coveredBy', same: (e, o) => sameNullableList(e.coveredBy, o.coveredBy) },
  { key: 'selected', same: (e, o) => sameSelection(e.selected, o.selected) },
  { key: 'killedBy', same: (e, o) => sameList(e.killedBy, o.killedBy) },
  { key: 'assertionKilledBy', same: (e, o) => sameList(e.assertionKilledBy, o.assertionKilledBy) },
  { key: 'tests', same: (e, o) => sameTests(e.tests, o.tests) },
  { key: 'outsideTest', same: (e, o) => outsideKey(e.outsideTest) === outsideKey(o.outsideTest) },
  { key: 'reason', same: (e, o) => reasonMatches(e.reason, o.reason) },
  { key: 'flags', same: (e, o) => sameList(e.flags, o.flags) },
];

const selects = (selector: MutantSelector, mutant: MutantSelector): boolean =>
  selector.file === mutant.file &&
  selector.location === mutant.location &&
  selector.mutatorName === mutant.mutatorName &&
  selector.replacement === mutant.replacement;

export const formatSelector = (selector: MutantSelector): string =>
  `${selector.file}:${selector.location} ${selector.mutatorName} ${show(selector.replacement)}`;

function compareTests(
  pins: readonly TestPin[],
  observed: readonly TestPin[],
  complete: boolean,
): string[] {
  const byId = new Map(observed.map((test) => [test.id, test]));
  const problems: string[] = [];
  for (const pin of pins) {
    const test = byId.get(pin.id);
    if (test === undefined) problems.push(`test ${show(pin.id)} is missing`);
    else if (show(test) !== show(pin))
      problems.push(`test ${show(pin.id)}: expected ${show(pin)}, observed ${show(test)}`);
  }
  if (complete) {
    const pinned = new Set(pins.map((pin) => pin.id));
    for (const test of observed.filter((entry) => !pinned.has(entry.id))) {
      problems.push(`unexpected test ${show(test)}`);
    }
  }
  return problems;
}

function processProblems(
  entry: ProcessesCase,
  run: ObservedScopeRun,
  mutantCases: ReadonlyMap<string, MutantCase>,
): string[] {
  const runs = run.mutants.flatMap((mutant) =>
    mutant.runs.map((attempt) => ({ ...attempt, localId: mutant.localId })),
  );
  const problems: string[] = [];
  if (run.dryRunPid === null) problems.push('no dry-run record names its process');
  const perProcess = new Map<number, typeof runs>();
  for (const attempt of runs)
    perProcess.set(attempt.pid, [...(perProcess.get(attempt.pid) ?? []), attempt]);
  if (entry.rule === 'one-mutant-run-per-process') {
    for (const [pid, handled] of perProcess) {
      if (handled.length > 1) {
        problems.push(
          `process ${pid} handled ${handled.length} mutant runs (${handled.map((r) => r.localId).join(', ')})`,
        );
      }
    }
    if (runs.length > 0 && runs.every((attempt) => attempt.pid === run.dryRunPid)) {
      problems.push('no mutant run came from a process that never ran the dry run');
    }
  } else {
    const elsewhere = runs.filter((attempt) => attempt.pid !== run.dryRunPid);
    if (elsewhere.length > 0) {
      problems.push(
        `${elsewhere.length} mutant run(s) came from other processes than the dry run's ` +
          `(${elsewhere.map((attempt) => attempt.localId).join(', ')})`,
      );
    }
  }
  // The pair is checked in the scope its mutant cases belong to; other scopes do not run them.
  const pairScopes = (entry.consecutive ?? []).map((name) => mutantCases.get(name)?.scope);
  if (entry.consecutive !== null && pairScopes.includes(run.scope)) {
    const [first, second] = entry.consecutive.map((name) => {
      const selector = mutantCases.get(name)?.mutant;
      return run.mutants.find((mutant) => selector !== undefined && selects(selector, mutant));
    });
    const firstRun = first?.runs.at(-1);
    const secondRun = second?.runs.at(-1);
    if (
      first === undefined ||
      second === undefined ||
      firstRun === undefined ||
      secondRun === undefined
    ) {
      problems.push(
        `the consecutive cases ${show(entry.consecutive)} do not both have a run in this scope`,
      );
    } else {
      const order = (perProcess.get(firstRun.pid) ?? []).sort(
        (a, b) => a.writtenAtMs - b.writtenAtMs,
      );
      const at = order.findIndex(
        (attempt) =>
          attempt.localId === first.localId && attempt.writtenAtMs === firstRun.writtenAtMs,
      );
      const next = order[at + 1];
      if (secondRun.pid !== firstRun.pid || next === undefined || next.localId !== second.localId) {
        problems.push(
          `mutant ${second.localId} (${entry.consecutive[1]}) did not run right after mutant ` +
            `${first.localId} (${entry.consecutive[0]}) in process ${firstRun.pid}`,
        );
      }
    }
  }
  return problems;
}

/** Compares every observed run with the expectations; an empty list means conformance holds. */
export function compareConformance(
  expected: ExpectedConformance,
  observed: readonly ObservedScopeRun[],
): Difference[] {
  const differences: Difference[] = [];
  const mutantCases = new Map(
    expected.cases.flatMap((entry) =>
      entry.kind === 'mutant' ? [[entry.name, entry] as const] : [],
    ),
  );
  for (const profile of expected.profiles) {
    for (const scope of expected.scopes) {
      const run = observed.find(
        (entry) => entry.profile === profile.name && entry.scope === scope.name,
      );
      const differ = (name: string, detail: string): void => {
        differences.push({ profile: profile.name, scope: scope.name, case: name, detail });
      };
      if (run === undefined) {
        differ('run', 'no observed run');
        continue;
      }
      if (run.spanMapFailures > 0) differ('span map', `${run.spanMapFailures} span-map failure(s)`);
      for (const flag of run.runFlags) differ('run flags', flag);
      for (const problem of compareTests(scope.tests, run.tests, true)) {
        differ(`test inventory of scope ${scope.name}`, problem);
      }

      const matched = new Set<ObservedMutant>();
      for (const entry of expected.cases) {
        if (entry.kind === 'tests' && entry.scope === scope.name) {
          for (const problem of compareTests(entry.tests, run.tests, false))
            differ(entry.name, problem);
        }
        if (entry.kind === 'processes' && entry.profile === profile.name) {
          for (const problem of processProblems(entry, run, mutantCases))
            differ(entry.name, problem);
        }
        if (entry.kind === 'environment' && entry.profile === profile.name) {
          if (run.exportedActiveMutant !== entry.localId) {
            differ(
              entry.name,
              `the driver exported ${show(run.exportedActiveMutant)}, expected ${show(entry.localId)}`,
            );
          }
          const target = mutantCases.get(entry.activeMutantOf);
          const mutant = run.mutants.find(
            (candidate) => target !== undefined && selects(target.mutant, candidate),
          );
          if (target?.scope === scope.name && mutant?.localId !== entry.localId) {
            differ(
              entry.name,
              `the exported local id ${entry.localId} is not the mutant of ${show(entry.activeMutantOf)} ` +
                `(its local id is ${show(mutant?.localId ?? null)})`,
            );
          }
        }
        if (entry.kind !== 'mutant' || entry.scope !== scope.name) continue;
        const candidates = run.mutants.filter((mutant) => selects(entry.mutant, mutant));
        candidates.forEach((mutant) => matched.add(mutant));
        if (candidates.length !== 1) {
          differ(
            entry.name,
            `${candidates.length} mutants match ${formatSelector(entry.mutant)}, expected exactly one`,
          );
          continue;
        }
        const [mutant] = candidates;
        for (const check of FACT_CHECKS.filter(({ same }) => !same(entry.expect, mutant.facts))) {
          differ(
            entry.name,
            `${check.key}: expected ${show(entry.expect[check.key])}, observed ${show(mutant.facts[check.key])}`,
          );
        }
      }
      for (const mutant of run.mutants.filter((candidate) => !matched.has(candidate))) {
        differ(
          'unexpected mutant',
          `${formatSelector(mutant)} (local id ${mutant.localId}, ${mutant.facts.status}) matches no case`,
        );
      }
    }
  }
  return differences;
}

export const formatDifference = (difference: Difference): string =>
  `[${difference.profile ?? '-'} / ${difference.scope ?? '-'}] case ${show(difference.case)}: ${difference.detail}`;
