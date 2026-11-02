/**
 * Locks the comparison logic of the gate 2 conformance check (U4): a run that matches every
 * pinned case passes, a change to any pinned fact fails naming its case, and a missing or an
 * unexpected mutant, a broken process rule or a wrong exported mutant id are reported. Pure
 * functions only; the Stryker runs are exercised by `npm run test:mutation:conformance`.
 */
import { describe, expect, it } from 'vitest';
import {
  compareConformance,
  fixtureRelative,
  formatDifference,
  observeScopeRun,
  parseExpected,
  type ExpectedCase,
  type ExpectedConformance,
  type MutantFacts,
  type MutantSelector,
  type ObservedMutant,
  type ObservedScopeRun,
  type ObserveInput,
  type ScopeSpec,
} from '../../../tools/mutation/conformance/compare.js';
import { driverScope } from '../../../tools/mutation/conformance/run-conformance.js';
import type {
  NormalisedMutant,
  NormalisedTest,
} from '../../../tools/mutation/driver/normalise-results.js';
import type { RunClassification } from '../../../tools/mutation/runner/classify-outcome.js';
import {
  SIDECAR_SCHEMA_VERSION,
  type SidecarRecord,
} from '../../../tools/mutation/runner/sidecar.js';

const TWO = 'runtime.case.ts#doubles two';
const THREE = 'runtime.case.ts#doubles three';
const ROOT = 'test/fixtures/mutation-conformance';
const PROFILE = 'concurrency-1-reuse-unlimited';
const CASE = 'two tests kill the same mutant';

const DOUBLE: MutantSelector = {
  file: 'src/runtime.ts',
  location: '7:10-7:19',
  mutatorName: 'ArithmeticOperator',
  replacement: 'value / 2',
};
const TICKET: MutantSelector = {
  file: 'src/counter.ts',
  location: '10:3-10:14',
  mutatorName: 'AssignmentOperator',
  replacement: 'issued -= 1',
};

const FACTS: MutantFacts = {
  status: 'Killed',
  static: false,
  outcome: 'killed-by-test:assertion',
  outcomeSource: 'sidecar',
  coveredBy: [TWO, THREE],
  selected: [TWO, THREE],
  killedBy: [TWO, THREE],
  assertionKilledBy: [TWO, THREE],
  tests: { [TWO]: 'killed-by-test:assertion', [THREE]: 'killed-by-test:assertion' },
  outsideTest: [],
  reason: null,
  flags: [],
  hookAttributedTests: [],
  attemptsDisagree: false,
};
const TICKET_FACTS: MutantFacts = {
  ...FACTS,
  coveredBy: ['runtime.case.ts#issues the first ticket'],
  selected: ['runtime.case.ts#issues the first ticket'],
  killedBy: ['runtime.case.ts#issues the first ticket'],
  assertionKilledBy: ['runtime.case.ts#issues the first ticket'],
  tests: { 'runtime.case.ts#issues the first ticket': 'killed-by-test:assertion' },
};

const TESTS = [
  { id: TWO, skipped: false, notOracleValidated: false },
  { id: THREE, skipped: false, notOracleValidated: false },
];

const mutantCase = (name: string, mutant: MutantSelector, facts: MutantFacts): ExpectedCase => ({
  kind: 'mutant',
  name,
  scope: 'main',
  mutant,
  expect: facts,
});

/** The expected document, round-tripped through the parser like expected.json. */
const MAIN_SCOPE: ScopeSpec = {
  name: 'main',
  testFiles: ['runtime.case.ts'],
  mutate: ['src/runtime.ts'],
  testIds: null,
  tests: TESTS,
};

const expectedWith = (
  cases: readonly ExpectedCase[],
  scopes: readonly ScopeSpec[] = [MAIN_SCOPE],
): ExpectedConformance =>
  parseExpected(
    JSON.stringify({
      schemaVersion: 1,
      profiles: [{ name: PROFILE, concurrency: 1, maxTestRunnerReuse: 0 }],
      scopes,
      cases,
    }),
  );

const BASE_CASES: readonly ExpectedCase[] = [
  mutantCase(CASE, DOUBLE, FACTS),
  mutantCase('counter carry-over', TICKET, TICKET_FACTS),
  {
    kind: 'processes',
    name: 'one process runs every mutant, back to back',
    profile: PROFILE,
    rule: 'every-run-in-the-dry-run-process',
    consecutive: ['counter carry-over', CASE],
  },
  {
    kind: 'environment',
    name: 'exported active mutant',
    profile: PROFILE,
    activeMutantOf: CASE,
    localId: '32',
  },
];

const observedMutant = (
  selector: MutantSelector,
  localId: string,
  facts: MutantFacts,
  writtenAtMs: number,
): ObservedMutant => ({ ...selector, localId, facts, runs: [{ pid: 7, writtenAtMs }] });

const observedRun = (overrides: Partial<ObservedScopeRun> = {}): ObservedScopeRun => ({
  profile: PROFILE,
  scope: 'main',
  mutants: [observedMutant(TICKET, '10', TICKET_FACTS, 1), observedMutant(DOUBLE, '32', FACTS, 2)],
  tests: TESTS,
  dryRunPid: 7,
  runFlags: [],
  spanMapFailures: 0,
  exportedActiveMutant: '32',
  ...overrides,
});

const cases = (differences: ReturnType<typeof compareConformance>): string[] =>
  differences.map((difference) => difference.case);

describe('compareConformance', () => {
  it('reports nothing when every pinned case holds', () => {
    expect(compareConformance(expectedWith(BASE_CASES), [observedRun()])).toEqual([]);
  });

  const ALTERATIONS: readonly [keyof MutantFacts, Partial<MutantFacts>][] = [
    ['status', { status: 'Survived' }],
    ['static', { static: true }],
    ['outcome', { outcome: 'killed-by-test:runtime' }],
    ['outcomeSource', { outcomeSource: 'no-coverage' }],
    ['coveredBy', { coveredBy: [TWO] }],
    ['selected', { selected: 'all' }],
    ['killedBy', { killedBy: [THREE] }],
    ['assertionKilledBy', { assertionKilledBy: [] }],
    ['tests', { tests: { [TWO]: 'killed-by-test:assertion' } }],
    ['outsideTest', { outsideTest: null }],
    ['reason', { reason: 'Hit limit reached' }],
    ['flags', { flags: ['zero-tests'] }],
    ['hookAttributedTests', { hookAttributedTests: [TWO] }],
    ['attemptsDisagree', { attemptsDisagree: true }],
  ];

  it('has an alteration for every pinned fact', () => {
    expect(ALTERATIONS.map(([key]) => key).sort()).toEqual(Object.keys(FACTS).sort());
  });

  it.each(ALTERATIONS)('fails naming the case when the pinned %s changes', (key, patch) => {
    const altered = BASE_CASES.map((entry) =>
      entry.name === CASE ? mutantCase(CASE, DOUBLE, { ...FACTS, ...patch }) : entry,
    );
    const differences = compareConformance(expectedWith(altered), [observedRun()]);
    expect(differences.map((d) => [d.profile, d.scope, d.case, d.detail.split(':')[0]])).toEqual([
      [PROFILE, 'main', CASE, key],
    ]);
  });

  it('fails naming the case when no mutant matches its selector', () => {
    const run = observedRun({ mutants: [observedMutant(TICKET, '10', TICKET_FACTS, 1)] });
    const differences = compareConformance(expectedWith(BASE_CASES.slice(0, 2)), [run]);
    expect(differences).toEqual([
      {
        profile: PROFILE,
        scope: 'main',
        case: CASE,
        detail: `0 mutants match src/runtime.ts:7:10-7:19 ArithmeticOperator "value / 2", expected exactly one`,
      },
    ]);
  });

  it('reports a mutant that no case selects as unexpected', () => {
    const extra = observedMutant({ ...DOUBLE, replacement: 'value + 2' }, '33', FACTS, 3);
    const run = observedRun({ mutants: [...observedRun().mutants, extra] });
    const differences = compareConformance(expectedWith(BASE_CASES), [run]);
    expect(cases(differences)).toEqual(['unexpected mutant']);
    expect(differences[0].detail).toContain('local id 33');
  });

  it('reports a run that is missing altogether', () => {
    expect(compareConformance(expectedWith(BASE_CASES), [])).toEqual([
      { profile: PROFILE, scope: 'main', case: 'run', detail: 'no observed run' },
    ]);
  });

  it('fails the test inventory when a pinned test flag differs', () => {
    const run = observedRun({ tests: [TESTS[0], { ...TESTS[1], notOracleValidated: true }] });
    expect(cases(compareConformance(expectedWith(BASE_CASES), [run]))).toEqual([
      'test inventory of scope main',
    ]);
  });

  it('fails a tests case when one of its tests is missing', () => {
    const pinned: ExpectedCase = {
      kind: 'tests',
      name: 'row ordinals',
      scope: 'main',
      tests: TESTS,
    };
    const run = observedRun({ tests: [TESTS[0]] });
    expect(cases(compareConformance(expectedWith([...BASE_CASES, pinned]), [run]))).toEqual([
      'test inventory of scope main',
      'row ordinals',
    ]);
  });

  it('fails the process case when a mutant ran in another process than the dry run', () => {
    const moved = { ...observedMutant(DOUBLE, '32', FACTS, 2), runs: [{ pid: 8, writtenAtMs: 2 }] };
    const run = observedRun({ mutants: [observedMutant(TICKET, '10', TICKET_FACTS, 1), moved] });
    const differences = compareConformance(expectedWith(BASE_CASES), [run]);
    expect(differences.map((d) => d.detail)).toEqual([
      "1 mutant run(s) came from other processes than the dry run's (32)",
      `mutant 32 (${CASE}) did not run right after mutant 10 (counter carry-over) in process 7`,
    ]);
    expect(new Set(cases(differences))).toEqual(
      new Set(['one process runs every mutant, back to back']),
    );
  });

  it('fails the process case when the consecutive mutants ran in the other order', () => {
    const run = observedRun({
      mutants: [
        observedMutant(TICKET, '10', TICKET_FACTS, 3),
        observedMutant(DOUBLE, '32', FACTS, 2),
      ],
    });
    expect(cases(compareConformance(expectedWith(BASE_CASES), [run]))).toEqual([
      'one process runs every mutant, back to back',
    ]);
  });

  it('checks a consecutive pair only in the scope of its mutant cases', () => {
    const other: ScopeSpec = {
      name: 'other',
      testFiles: ['o.case.ts'],
      mutate: ['src/o.ts'],
      testIds: null,
      tests: [],
    };
    const otherRun = observedRun({ scope: 'other', mutants: [], tests: [] });
    const differences = compareConformance(expectedWith(BASE_CASES, [MAIN_SCOPE, other]), [
      observedRun(),
      otherRun,
    ]);
    expect(differences).toEqual([]);
  });

  it('fails a one-run-per-process rule when a process handled two mutant runs', () => {
    const rule: ExpectedCase = {
      kind: 'processes',
      name: 'fresh processes',
      profile: PROFILE,
      rule: 'one-mutant-run-per-process',
      consecutive: null,
    };
    const differences = compareConformance(expectedWith([...BASE_CASES.slice(0, 2), rule]), [
      observedRun(),
    ]);
    expect(differences.map((d) => d.detail)).toEqual([
      'process 7 handled 2 mutant runs (10, 32)',
      'no mutant run came from a process that never ran the dry run',
    ]);
  });

  it('fails the environment case when the exported id names another mutant', () => {
    const run = observedRun({ exportedActiveMutant: '10' });
    const environment: ExpectedCase = {
      kind: 'environment',
      name: 'exported active mutant',
      profile: PROFILE,
      activeMutantOf: CASE,
      localId: '10',
    };
    const differences = compareConformance(expectedWith([...BASE_CASES.slice(0, 3), environment]), [
      run,
    ]);
    expect(differences.map((d) => [d.case, d.detail])).toEqual([
      [
        'exported active mutant',
        `the exported local id 10 is not the mutant of "${CASE}" (its local id is "32")`,
      ],
    ]);
  });

  it('reports run-level flags and span-map failures', () => {
    const run = observedRun({ runFlags: ['dry-run-missing: no record'], spanMapFailures: 2 });
    expect(cases(compareConformance(expectedWith(BASE_CASES), [run]))).toEqual([
      'span map',
      'run flags',
    ]);
  });

  it('formats a difference with its profile, scope and case', () => {
    expect(
      formatDifference({ profile: PROFILE, scope: 'main', case: CASE, detail: 'status: x' }),
    ).toBe(`[${PROFILE} / main] case "${CASE}": status: x`);
  });
});

describe('parseExpected', () => {
  const valid = {
    schemaVersion: 1,
    profiles: [{ name: PROFILE, concurrency: 1, maxTestRunnerReuse: 0 }],
    scopes: [
      { name: 'main', testFiles: ['a.case.ts'], mutate: ['src/a.ts'], testIds: null, tests: [] },
    ],
    cases: [
      { kind: 'mutant', name: CASE, scope: 'main', mutant: DOUBLE, expect: FACTS },
    ] satisfies readonly ExpectedCase[],
  };

  it('accepts a valid document', () => {
    expect(parseExpected(JSON.stringify(valid)).cases.map((entry) => entry.name)).toEqual([CASE]);
  });

  it.each([
    [
      'an unknown fact key',
      { ...valid, cases: [{ ...valid.cases[0], expect: { ...FACTS, outcom: 'x' } }] },
      /unknown key "outcom"/,
    ],
    [
      'an unknown outcome class',
      { ...valid, cases: [{ ...valid.cases[0], expect: { ...FACTS, outcome: 'killed' } }] },
      /outcome: must be one of/,
    ],
    [
      'a case in an unknown scope',
      { ...valid, cases: [{ ...valid.cases[0], scope: 'other' }] },
      /unknown scope other/,
    ],
    ['a repeated case name', { ...valid, cases: [valid.cases[0], valid.cases[0]] }, /listed twice/],
    [
      'a consecutive pair naming a missing case',
      {
        ...valid,
        cases: [
          ...valid.cases,
          {
            kind: 'processes',
            name: 'p',
            profile: PROFILE,
            rule: 'one-mutant-run-per-process',
            consecutive: [CASE, 'nope'],
          },
        ],
      },
      /"nope" is not a mutant case/,
    ],
    [
      'a malformed location',
      { ...valid, cases: [{ ...valid.cases[0], mutant: { ...DOUBLE, location: '7' } }] },
      /location: must look like/,
    ],
    ['another schema version', { ...valid, schemaVersion: 2 }, /schemaVersion: must be 1/],
    [
      'an empty test selection',
      { ...valid, scopes: [{ ...valid.scopes[0], testIds: [] }] },
      /testIds: must be null or a non-empty array/,
    ],
    [
      'a scope without its testIds key',
      { ...valid, scopes: [{ name: 'main', testFiles: ['a.case.ts'], mutate: [], tests: [] }] },
      /missing key "testIds"/,
    ],
  ])('rejects %s', (_label, document, message) => {
    expect(() => parseExpected(JSON.stringify(document))).toThrow(message);
  });
});

describe('observeScopeRun', () => {
  const ID_TWO = `${ROOT}/${TWO}`;
  const ID_THREE = `${ROOT}/${THREE}`;
  const classification: RunClassification = {
    status: 'killed',
    outcome: 'killed-by-test:assertion',
    reason: undefined,
    killedBy: [ID_TWO],
    failureMessage: 'expected 3 to be 4',
    nrOfTests: 2,
    hitCount: 1,
    tests: [
      { id: ID_TWO, outcome: 'killed-by-test:assertion', message: 'expected 3 to be 4' },
      { id: ID_THREE, outcome: 'survived', message: undefined },
    ],
    outsideTest: [],
  };
  const record: SidecarRecord = {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    kind: 'mutant',
    mutantId: '32',
    worker: '0',
    attempt: 1,
    pid: 7,
    mutantActivation: 'static',
    hitLimit: 100,
    requestedTestIds: [ID_THREE, ID_TWO],
    hookAttributedTests: null,
    result: classification,
  };
  const normalised = (overrides: Partial<NormalisedMutant>): NormalisedMutant => ({
    globalId: `gitnexus/${ROOT}/src/runtime.ts@0:7:10-7:19:ArithmeticOperator:0`,
    localId: '32',
    file: `gitnexus/${ROOT}/src/runtime.ts`,
    location: { start: { line: 7, column: 10 }, end: { line: 7, column: 19 } },
    mutatorName: 'ArithmeticOperator',
    replacement: 'value / 2',
    static: true,
    status: 'Killed',
    statusReason: null,
    testsCompleted: 2,
    outcome: 'killed-by-test:assertion',
    outcomeSource: 'sidecar',
    killedBy: [ID_TWO],
    coveredBy: [],
    assertionKilledBy: [ID_TWO],
    sidecar: {
      file: '/out/sidecars/mutant-32.json',
      worker: '0',
      attempt: 1,
      pid: 7,
      writtenAtMs: 5,
      status: 'killed',
      outcome: 'killed-by-test:assertion',
      nrOfTests: 2,
      reason: null,
      failureMessage: 'expected 3 to be 4',
      killedBy: [ID_TWO],
      hitCount: 1,
      mutantActivation: 'static',
      outsideTest: [],
    },
    attempts: [
      {
        file: '/out/sidecars/mutant-32.json',
        worker: '0',
        attempt: 1,
        pid: 7,
        writtenAtMs: 5,
        status: 'killed',
        outcome: 'killed-by-test:assertion',
        nrOfTests: 2,
      },
    ],
    perTest: [
      { testId: ID_TWO, outcome: 'killed-by-test:assertion', attempt: 0 },
      { testId: ID_THREE, outcome: 'survived', attempt: 0 },
    ],
    attemptsDisagree: false,
    hookAttributedTests: [ID_THREE, ID_TWO],
    flags: [],
    ...overrides,
  });
  const test = (id: string): NormalisedTest => ({
    id,
    file: `${ROOT}/runtime.case.ts`,
    fullName: id.split('#')[1],
    taskId: 'h_0',
    skipped: false,
    notOracleValidated: false,
    killed: [],
    assertionKilled: [],
  });
  const input: ObserveInput = {
    profile: PROFILE,
    scope: 'main',
    results: {
      mutants: [normalised({}), normalised({ localId: '33', status: 'Ignored', sidecar: null })],
      tests: [test(ID_TWO), test(ID_THREE)],
      flags: [{ kind: 'zero-tests', localId: '32', globalId: null, detail: 'per mutant' }],
      spanMap: { checked: 2, failures: [] },
    },
    records: new Map([['/out/sidecars/mutant-32.json', record]]),
    dryRunPid: 7,
    exportedActiveMutant: null,
    fixtureRoot: ROOT,
  };
  const run = observeScopeRun(input);

  it('leaves Ignored mutants out and keeps only run-level flags', () => {
    expect([run.mutants.map((mutant) => mutant.localId), run.runFlags]).toEqual([['32'], []]);
  });

  it('makes paths and test ids fixture-relative', () => {
    expect([run.mutants[0].file, run.tests.map((entry) => entry.id)]).toEqual([
      'src/runtime.ts',
      [TWO, THREE],
    ]);
  });

  it('records a selection of every manifest test as "all" and only non-survived test outcomes', () => {
    expect(run.mutants[0].facts).toMatchObject({
      selected: 'all',
      tests: { [TWO]: 'killed-by-test:assertion' },
      killedBy: [TWO],
    });
    expect(run.mutants[0].location).toBe('7:10-7:19');
  });

  it('reports the hook marker fixture-relative and sorted, and whether attempts disagree', () => {
    expect([
      run.mutants[0].facts.hookAttributedTests,
      run.mutants[0].facts.attemptsDisagree,
    ]).toEqual([[THREE, TWO], false]);
  });

  it('keeps a missing hook marker as null', () => {
    const unknown = observeScopeRun({
      ...input,
      results: { ...input.results, mutants: [normalised({ hookAttributedTests: null })] },
    });
    expect(unknown.mutants[0].facts.hookAttributedTests).toBeNull();
  });

  it('throws when the latest sidecar record was not read', () => {
    expect(() => observeScopeRun({ ...input, records: new Map() })).toThrow(/was not read/);
  });

  it('strips the fixture directory from package- and repo-relative values only', () => {
    expect(
      [`${ROOT}/a.case.ts#x`, `gitnexus/${ROOT}/src/a.ts`, 'test/unit/a.test.ts#y'].map((value) =>
        fixtureRelative(value, ROOT),
      ),
    ).toEqual(['a.case.ts#x', 'src/a.ts', 'test/unit/a.test.ts#y']);
  });
});

describe('driverScope (run-conformance.ts)', () => {
  const scope: ScopeSpec = {
    name: 'selection',
    testFiles: ['selection.case.ts'],
    mutate: ['src/selection.ts'],
    testIds: ['selection.case.ts#scales two'],
    tests: [],
  };

  it('passes a scope test selection to the driver with package-relative ids', () => {
    expect(driverScope(scope)).toEqual({
      testFiles: [`${ROOT}/selection.case.ts`],
      mutate: [`gitnexus/${ROOT}/src/selection.ts`],
      testIds: [`${ROOT}/selection.case.ts#scales two`],
    });
  });

  it('writes no testIds key for a scope that runs every test', () => {
    expect(driverScope({ ...scope, testIds: null })).not.toHaveProperty('testIds');
  });
});
