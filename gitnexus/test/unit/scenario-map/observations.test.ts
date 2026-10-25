/**
 * Locks Layer 3's raw observations (U7, R6, R7, R11, KTD8, design §5.4) in the compact model: a
 * run universe (the selected tests, never a skipped one, and the evaluated mutants) plus one
 * explicit observation per per-test row of every sidecar attempt, keyed by group, run kind,
 * lineage, attempt, test and global mutant id; an uncovered test of a non-static mutant is an
 * implied survived observation, never stored, while a covered or static mutant without a row is
 * an explicit unknown, never a non-kill; untrusted runs, attempt disagreements and integrity flags
 * invalidate (implied observations too); merging folds attempts and runs of one lineage and turns
 * a class disagreement into one inconclusive observation; observations of different groups stay
 * apart, and a pair is compared only over its common universe inside one group run. Work files
 * hold the explicit observations as rows of the universe.
 */
import { describe, expect, it } from 'vitest';
import type {
  FlagKind,
  NormalisedMutant,
  RunResults,
  SidecarAttempt,
} from '../../../tools/mutation/driver/normalise-results.js';
import type { OutcomeClass } from '../../../tools/mutation/runner/classify-outcome.js';
import {
  comparePair,
  decodeObservations,
  encodeObservations,
  extractObservations,
  impliedObservation,
  indexObservations,
  lineageOf,
  mergeObservations,
  observationKey,
  observationOf,
  observedMutants,
  type MergedObservation,
  type Observation,
  type RunRef,
  type RunUniverse,
} from '../../../tools/scenario-map/mutation/observations.js';

const T1 = 'test/unit/a.test.ts#A > one';
const T2 = 'test/unit/a.test.ts#A > two';
const M1 = 'gitnexus/src/x.ts@0123456789abcdef:1:1-1:5:ArithmeticOperator:aaaaaaaaaaaaaaaa';
const M2 = 'gitnexus/src/x.ts@0123456789abcdef:2:1-2:5:EqualityOperator:bbbbbbbbbbbbbbbb';
const M3 = 'gitnexus/src/x.ts@0123456789abcdef:3:1-3:5:StringLiteral:cccccccccccccccc';
const MAIN: RunRef = { group: 'g1', kind: 'main', lineage: 'main', shard: 0 };

const attempt = (outcome: OutcomeClass, index = 0): SidecarAttempt => ({
  file: `/sidecars/mutant-${index}.json`,
  worker: '0',
  attempt: index,
  pid: 100 + index,
  writtenAtMs: 1000 + index,
  status: outcome === 'survived' ? 'survived' : outcome === 'timeout' ? 'timeout' : 'killed',
  outcome,
  nrOfTests: 2,
});

const mutant = (globalId: string, overrides: Partial<NormalisedMutant> = {}): NormalisedMutant => ({
  globalId,
  localId: globalId.slice(-3),
  file: 'gitnexus/src/x.ts',
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
  mutatorName: 'ArithmeticOperator',
  replacement: '-',
  static: false,
  status: 'Killed',
  statusReason: null,
  testsCompleted: 2,
  outcome: 'killed-by-test:assertion',
  outcomeSource: 'sidecar',
  killedBy: [T1],
  coveredBy: [T1, T2],
  assertionKilledBy: [T1],
  sidecar: null,
  attempts: [attempt('killed-by-test:assertion')],
  perTest: [
    { testId: T1, outcome: 'killed-by-test:assertion', attempt: 0 },
    { testId: T2, outcome: 'survived', attempt: 0 },
  ],
  attemptsDisagree: false,
  hookAttributedTests: [],
  flags: [],
  ...overrides,
});

const results = (
  mutants: NormalisedMutant[],
  extra: { flags?: RunResults['flags']; spanFailures?: string[] } = {},
): RunResults => ({
  schemaVersion: 2,
  variant: 'vitest5',
  scope: {
    testFiles: ['test/unit/a.test.ts'],
    mutate: ['gitnexus/src/x.ts'],
    testIds: [T1, T2],
  },
  paths: {
    outDir: '/out',
    preparedRoot: '/out/prepared',
    packageDir: '/out/prepared/gitnexus',
    configFile: '/out/stryker.config.json',
    reportFile: '/out/mutation.json',
    logFile: '/out/stryker.log',
    runDir: '/out/run',
    sidecarDir: '/out/sidecars',
    sandboxDirs: [],
  },
  stryker: { exitCode: 0, wallClockMs: 1000 },
  spanMap: {
    checked: mutants.length,
    failures: (extra.spanFailures ?? []).map((globalId) => ({
      localId: '1',
      globalId,
      message: 'span moved',
    })),
  },
  manifest: { project: 'mutation', vitestVersion: '5.0.5', files: 1, tests: 2, skipped: 0 },
  dryRun: {
    file: '/sidecars/dry-run.json',
    status: 'survived',
    outcome: 'survived',
    reason: null,
    nrOfTests: 2,
    attempts: 1,
  },
  mutants,
  tests: [],
  flags: extra.flags ?? [],
  summary: {
    mutants: mutants.length,
    byStatus: {
      Killed: 0,
      Survived: 0,
      NoCoverage: 0,
      CompileError: 0,
      RuntimeError: 0,
      Timeout: 0,
      Ignored: 0,
      Pending: 0,
    },
    byOutcome: {},
    mutantsWithSidecar: 0,
    mutantsWithOutcome: 0,
    testsWithKills: 0,
    testsWithAssertionKills: 0,
    zeroTestRuns: 0,
    flags: 0,
  },
});

/** The explicit observations of one test and mutant, as `[outcome, source, valid, reasons]`. */
const summary = (
  run: { observations: readonly Observation[] },
  test: string,
  globalId: string,
): [OutcomeClass | null, string, boolean, string[]][] =>
  run.observations
    .filter((entry) => entry.test === test && entry.mutant === globalId)
    .map((entry) => [entry.outcome, entry.source, entry.valid, entry.reasons]);

/** The merged observation (explicit or implied) of a test and mutant in a run's main lineage. */
const merged = (
  run: { universe: RunUniverse; observations: readonly Observation[] },
  test: string,
  globalId: string,
): MergedObservation | undefined => {
  const view = lineageOf(
    indexObservations(mergeObservations(run.observations, [run.universe])),
    run.universe,
  );
  return view === undefined ? undefined : observationOf(view, test, globalId);
};

/** `[outcome, sources, valid, reasons, hookAttributed]` of a merged observation. */
const brief = (
  entry: MergedObservation | undefined,
): [OutcomeClass | null, string[], boolean, string[], boolean | null] | undefined =>
  entry === undefined
    ? undefined
    : [entry.outcome, entry.sources, entry.valid, entry.reasons, entry.hookAttributed];

const observation = (overrides: Partial<Observation>): Observation => ({
  group: 'g1',
  kind: 'main',
  lineage: 'main',
  shard: 0,
  attempt: 0,
  test: T1,
  mutant: M1,
  file: 'gitnexus/src/x.ts',
  covered: true,
  hookAttributed: false,
  static: false,
  outcome: 'killed-by-test:assertion',
  source: 'row',
  valid: true,
  reasons: [],
  ...overrides,
});

describe('extractObservations', () => {
  it('emits one valid observation per per-test row, carrying the run reference', () => {
    const { observations } = extractObservations(results([mutant(M1)]), MAIN);
    expect(observations.map((entry) => [entry.test, entry.outcome, entry.attempt])).toEqual([
      [T1, 'killed-by-test:assertion', 0],
      [T2, 'survived', 0],
    ]);
    expect(observations.every((entry) => entry.valid && entry.group === 'g1')).toBe(true);
    expect(observations.every((entry) => entry.kind === 'main' && entry.lineage === 'main')).toBe(
      true,
    );
  });

  it('keeps the rows of every attempt, oldest first', () => {
    const flaky = mutant(M1, {
      attempts: [attempt('killed-by-test:assertion', 0), attempt('survived', 1)],
      perTest: [
        { testId: T1, outcome: 'killed-by-test:assertion', attempt: 0 },
        { testId: T1, outcome: 'survived', attempt: 1 },
      ],
      coveredBy: [T1],
      attemptsDisagree: true,
    });
    expect(summary(extractObservations(results([flaky]), MAIN), T1, M1)).toEqual([
      ['killed-by-test:assertion', 'row', false, ['attempts-disagree']],
      ['survived', 'row', false, ['attempts-disagree']],
    ]);
  });

  it('implies a valid survived observation for an uncovered test of a non-static mutant', () => {
    const narrow = mutant(M1, {
      coveredBy: [T1],
      perTest: [{ testId: T1, outcome: 'killed-by-test:assertion', attempt: 0 }],
    });
    const run = extractObservations(results([narrow]), MAIN);
    expect([summary(run, T2, M1), brief(merged(run, T2, M1))]).toEqual([
      [],
      ['survived', ['not-covered'], true, [], false],
    ]);
  });

  it('records the selected tests and the evaluated mutants in the run universe', () => {
    const run = extractObservations(
      results([mutant(M2, { flags: ['status-mismatch'] }), mutant(M1, { static: true })]),
      MAIN,
    );
    expect(run.universe).toEqual({
      ...MAIN,
      tests: [T1, T2],
      mutants: [
        {
          id: M1,
          file: 'gitnexus/src/x.ts',
          static: true,
          status: 'Killed',
          reasons: [],
          hookMarker: true,
        },
        {
          id: M2,
          file: 'gitnexus/src/x.ts',
          static: false,
          status: 'Killed',
          reasons: ['mutant-flag:status-mismatch'],
          hookMarker: true,
        },
      ],
      valid: true,
      reasons: [],
    });
  });

  it('gives a collected but skipped test no observation, even when it covers the mutant', () => {
    const skipped = 'test/unit/a.test.ts#A > skipped';
    const covered = mutant(M1, {
      coveredBy: [T1, skipped],
      perTest: [{ testId: T1, outcome: 'killed-by-test:assertion', attempt: 0 }],
    });
    const run = extractObservations(
      {
        ...results([covered]),
        tests: [T1, T2, skipped].map((id) => ({
          id,
          file: 'test/unit/a.test.ts',
          fullName: id.split('#')[1],
          taskId: null,
          skipped: id === skipped,
          notOracleValidated: false,
          killed: [],
          assertionKilled: [],
        })),
      },
      MAIN,
    );
    expect([run.universe.tests, summary(run, skipped, M1), merged(run, skipped, M1)]).toEqual([
      [T1, T2],
      [],
      undefined,
    ]);
  });

  it('records a covered test without a row as unknown, never as a non-kill', () => {
    const missing = mutant(M1, {
      perTest: [{ testId: T1, outcome: 'killed-by-test:assertion', attempt: 0 }],
    });
    expect(summary(extractObservations(results([missing]), MAIN), T2, M1)).toEqual([
      [null, 'no-row', false, ['missing-result']],
    ]);
  });

  it('treats a static mutant without a row as unknown even when coveredBy is empty', () => {
    const statik = mutant(M1, {
      static: true,
      coveredBy: [],
      perTest: [{ testId: T1, outcome: 'survived', attempt: 0 }],
    });
    const run = extractObservations(results([statik]), MAIN);
    expect(summary(run, T2, M1)).toEqual([[null, 'no-row', false, ['missing-result']]]);
    expect(summary(run, T1, M1)).toEqual([['survived', 'row', true, []]]);
    expect(run.observations.every((entry) => entry.static && !entry.covered)).toBe(true);
  });

  it.each([
    ['timeout', 'run-timeout'],
    ['infrastructure', 'run-infrastructure'],
    ['inconclusive', 'run-inconclusive'],
    ['invalid', 'run-invalid'],
  ] as const)('distrusts the rows of an attempt whose run class is %s', (outcome, reason) => {
    const untrusted = mutant(M1, { attempts: [attempt(outcome)] });
    expect(summary(extractObservations(results([untrusted]), MAIN), T1, M1)).toEqual([
      ['killed-by-test:assertion', 'row', false, [reason]],
    ]);
  });

  it('records a Stryker timeout without a sidecar as an unattributable timeout', () => {
    const killed = mutant(M1, {
      status: 'Timeout',
      outcome: 'timeout',
      outcomeSource: 'stryker-timeout',
      coveredBy: [T1],
      attempts: [],
      perTest: [],
    });
    const run = extractObservations(results([killed]), MAIN);
    expect(summary(run, T1, M1)).toEqual([
      ['timeout', 'stryker-timeout', false, ['stryker-timeout']],
    ]);
    expect(brief(merged(run, T2, M1))).toEqual(['survived', ['not-covered'], true, [], false]);
  });

  it('implies a NoCoverage mutant survived by every test and stores no observation', () => {
    const uncovered = mutant(M1, {
      status: 'NoCoverage',
      outcome: 'survived',
      outcomeSource: 'no-coverage',
      coveredBy: [],
      attempts: [],
      perTest: [],
    });
    const run = extractObservations(results([uncovered]), MAIN);
    expect([run.observations, [T1, T2].map((test) => brief(merged(run, test, M1)))]).toEqual([
      [],
      [
        ['survived', ['not-covered'], true, [], false],
        ['survived', ['not-covered'], true, [], false],
      ],
    ]);
  });

  it.each(['Ignored', 'Pending'] as const)('leaves a %s mutant out of the universe', (status) => {
    const run = extractObservations(results([mutant(M1, { status, perTest: [] })]), MAIN);
    expect([run.observations, run.universe.mutants]).toEqual([[], []]);
  });

  it('invalidates every observation of a run with a run-level integrity flag', () => {
    const flags: RunResults['flags'] = [
      { kind: 'dry-run-missing', localId: null, globalId: null, detail: 'no dry run' },
    ];
    const run = extractObservations(
      results([mutant(M1), mutant(M2, { coveredBy: [], perTest: [] })], { flags }),
      MAIN,
    );
    expect([
      run.universe.valid,
      run.observations.map((entry) => entry.reasons),
      brief(merged(run, T1, M2)),
    ]).toEqual([
      false,
      [['run-flag:dry-run-missing'], ['run-flag:dry-run-missing']],
      ['survived', ['not-covered'], false, ['run-flag:dry-run-missing'], false],
    ]);
  });

  it.each([
    ['status-mismatch', 'mutant-flag:status-mismatch'],
    ['killed-by-not-in-sidecar', 'mutant-flag:killed-by-not-in-sidecar'],
  ] as const)('invalidates a mutant flagged %s', (kind: FlagKind, reason) => {
    const flagged = mutant(M1, { flags: [kind] });
    expect(summary(extractObservations(results([flagged]), MAIN), T1, M1)).toEqual([
      ['killed-by-test:assertion', 'row', false, [reason]],
    ]);
  });

  it('invalidates a mutant whose span-map check failed', () => {
    const { observations } = extractObservations(
      results([mutant(M1)], { spanFailures: [M1] }),
      MAIN,
    );
    expect(observations.map((entry) => [entry.valid, entry.reasons])).toEqual([
      [false, ['span-map']],
      [false, ['span-map']],
    ]);
  });

  it('invalidates the implied observations of a flagged mutant', () => {
    const narrow = mutant(M1, {
      coveredBy: [T1],
      perTest: [{ testId: T1, outcome: 'killed-by-test:assertion', attempt: 0 }],
      flags: ['status-mismatch'],
    });
    expect(brief(merged(extractObservations(results([narrow]), MAIN), T2, M1))).toEqual([
      'survived',
      ['not-covered'],
      false,
      ['mutant-flag:status-mismatch'],
      false,
    ]);
  });

  it('marks the hook-attributed tests and leaves the marker unknown without a dry-run record', () => {
    const hooked = mutant(M1, { hookAttributedTests: [T2] });
    const unknown = mutant(M2, { hookAttributedTests: null });
    const { observations } = extractObservations(results([hooked, unknown]), MAIN);
    expect(
      observations.map((entry) => [entry.mutant === M1 ? 'M1' : 'M2', entry.hookAttributed]),
    ).toEqual([
      ['M1', false],
      ['M1', true],
      ['M2', null],
      ['M2', null],
    ]);
  });

  it.each([
    ['a hook marker naming it', [T2], 1, true],
    ['no hook marker for the mutant', null, 0, null],
  ] as const)(
    'stores an uncovered test of a mutant with %s only when the marker names it',
    (_title, hookAttributedTests, stored, marker) => {
      const narrow = mutant(M1, {
        coveredBy: [T1],
        perTest: [{ testId: T1, outcome: 'survived', attempt: 0 }],
        hookAttributedTests: hookAttributedTests === null ? null : [...hookAttributedTests],
      });
      const run = extractObservations(results([narrow]), MAIN);
      expect([summary(run, T2, M1).length, merged(run, T2, M1)?.hookAttributed]).toEqual([
        stored,
        marker,
      ]);
    },
  );

  it('keys observations by group, kind, lineage, attempt, test and mutant', () => {
    const keys = [
      observation({}),
      observation({ group: 'g2' }),
      observation({ kind: 'together', lineage: 'pair' }),
      observation({ attempt: 1 }),
      observation({ test: T2 }),
      observation({ mutant: M2 }),
    ].map(observationKey);
    expect(new Set(keys).size).toBe(6);
  });
});

describe('mergeObservations', () => {
  it('folds two attempts with different classes into one inconclusive observation', () => {
    const { explicit } = mergeObservations(
      [
        observation({ attempt: 0, outcome: 'killed-by-test:assertion' }),
        observation({ attempt: 1, outcome: 'survived' }),
      ],
      [],
    );
    expect(
      explicit.map((entry) => [entry.outcome, entry.valid, entry.reasons, entry.attempts]),
    ).toEqual([['inconclusive', false, ['class-disagreement'], [0, 1]]]);
  });

  it('folds agreeing attempts into one valid observation', () => {
    const { explicit } = mergeObservations(
      [observation({ attempt: 0 }), observation({ attempt: 1 }), observation({ attempt: 1 })],
      [],
    );
    expect(explicit.map((entry) => [entry.outcome, entry.valid, entry.attempts])).toEqual([
      ['killed-by-test:assertion', true, [0, 1]],
    ]);
  });

  it('keeps the observations of one mutant in two groups apart', () => {
    const { explicit } = mergeObservations(
      [
        observation({ group: 'gx', test: T1, outcome: 'killed-by-test:assertion' }),
        observation({ group: 'gy', test: T2, outcome: 'survived' }),
      ],
      [],
    );
    expect(explicit.map((entry) => [entry.group, entry.test, entry.outcome])).toEqual([
      ['gx', T1, 'killed-by-test:assertion'],
      ['gy', T2, 'survived'],
    ]);
  });

  it('carries the reasons of an invalid observation into the merged one', () => {
    const { explicit } = mergeObservations(
      [
        observation({ attempt: 0 }),
        observation({ attempt: 1, valid: false, reasons: ['run-timeout'] }),
      ],
      [],
    );
    expect(explicit.map((entry) => [entry.valid, entry.reasons])).toEqual([
      [false, ['run-timeout']],
    ]);
  });

  /** A universe of the main run of g1 on one shard: T1 and T2 selected, M1 non-static. */
  const universe = (shard: number, hookMarker = true): RunUniverse => ({
    ...MAIN,
    shard,
    tests: [T1, T2],
    mutants: [
      {
        id: M1,
        file: 'gitnexus/src/x.ts',
        static: false,
        status: 'Survived',
        reasons: [],
        hookMarker,
      },
    ],
    valid: true,
    reasons: [],
  });

  it('folds the implied observation of another run of the lineage into an explicit one', () => {
    const { explicit } = mergeObservations(
      [observation({ test: T1, shard: 0 })],
      [universe(0), universe(1)],
    );
    expect(
      explicit.map((entry) => [
        entry.test,
        entry.outcome,
        entry.covered,
        entry.shards,
        entry.reasons,
      ]),
    ).toEqual([
      [T1, 'inconclusive', true, [0, 1], ['class-disagreement', 'coverage-disagreement']],
    ]);
  });

  it('folds the implied observations of two runs on read, marker disagreements included', () => {
    const view = lineageOf(
      indexObservations(mergeObservations([], [universe(0, true), universe(1, false)])),
      MAIN,
    );
    expect(brief(view === undefined ? undefined : observationOf(view, T2, M1))).toEqual([
      'survived',
      ['not-covered'],
      false,
      ['hook-marker-disagreement'],
      false,
    ]);
  });
});

describe('comparePair', () => {
  const run = { group: 'g1', kind: 'main', lineage: 'main' } as const;
  /** Explicit observations only, indexed. */
  const indexed = (observations: readonly Observation[]) =>
    indexObservations(mergeObservations(observations, []));

  it('compares equal kill sets over the common universe', () => {
    const merged = indexed([
      observation({ test: T1, mutant: M1 }),
      observation({ test: T2, mutant: M1 }),
      observation({ test: T1, mutant: M2, outcome: 'survived' }),
      observation({ test: T2, mutant: M2, outcome: 'survived', covered: false }),
    ]);
    const comparison = comparePair(merged, run, T1, T2);
    expect([comparison.universe, comparison.killsA, comparison.killsB]).toEqual([
      [M1, M2],
      [M1],
      [M1],
    ]);
    expect([comparison.unknown, comparison.sameKills]).toEqual([[], true]);
    expect(comparison.universeId).toBe(comparePair(merged, run, T2, T1).universeId);
  });

  it('makes a covered mutant unknown when one test has no observation, and does not compare', () => {
    const merged = indexed([
      observation({ test: T1, mutant: M1 }),
      observation({ test: T1, mutant: M2 }),
      observation({ test: T2, mutant: M2 }),
    ]);
    const comparison = comparePair(merged, run, T1, T2);
    expect([comparison.universe, comparison.unknown, comparison.sameKills]).toEqual([
      [M2],
      [M1],
      null,
    ]);
  });

  it('does not compare two tests of a run that has no observation', () => {
    const merged = indexed([observation({ group: 'gx' }), observation({ group: 'gx', test: T2 })]);
    expect(comparePair(merged, run, T1, T2)).toMatchObject({
      universe: [],
      unknown: [],
      sameKills: null,
    });
  });

  it('makes an invalid observation unknown for the pair', () => {
    const merged = indexed([
      observation({ test: T1, mutant: M1 }),
      observation({ test: T2, mutant: M1, valid: false, reasons: ['missing-result'] }),
    ]);
    expect(comparePair(merged, run, T1, T2).unknown).toEqual([M1]);
  });

  it('compares only inside the requested group run', () => {
    const merged = indexed([
      observation({ group: 'gx', test: T1, mutant: M1 }),
      observation({ group: 'gx', test: T2, mutant: M1 }),
      observation({ group: 'gy', test: T1, mutant: M1, outcome: 'survived' }),
      observation({ group: 'gy', test: T2, mutant: M1, outcome: 'survived' }),
      observation({ group: 'gy', test: T1, mutant: M3 }),
    ]);
    const inX = comparePair(merged, { ...run, group: 'gx' }, T1, T2);
    const inY = comparePair(merged, { ...run, group: 'gy' }, T1, T2);
    expect([inX.killsA, inX.unknown, inY.killsA, inY.unknown]).toEqual([[M1], [], [], [M3]]);
  });

  it('lists the universe mutants whose class is neither an assertion kill nor survived', () => {
    const merged = indexed([
      observation({ test: T1, mutant: M1, outcome: 'killed-by-test:runtime' }),
      observation({ test: T2, mutant: M1 }),
      observation({ test: T1, mutant: M2, outcome: 'timeout' }),
      observation({ test: T2, mutant: M2, outcome: 'survived' }),
    ]);
    expect(comparePair(merged, run, T1, T2).otherClasses).toEqual([M1, M2]);
  });
});

describe('comparePair over implied observations', () => {
  it('compares two tests whose survivals of uncovered mutants are implied, not stored', () => {
    const noCoverage = mutant(M2, {
      status: 'NoCoverage',
      outcome: 'survived',
      outcomeSource: 'no-coverage',
      coveredBy: [],
      attempts: [],
      perTest: [],
    });
    const onlyT1 = mutant(M3, {
      coveredBy: [T1],
      perTest: [{ testId: T1, outcome: 'killed-by-test:assertion', attempt: 0 }],
    });
    const run = extractObservations(results([mutant(M1), noCoverage, onlyT1]), MAIN);
    const comparison = comparePair(
      indexObservations(mergeObservations(run.observations, [run.universe])),
      MAIN,
      T1,
      T2,
    );
    expect([
      run.observations.length,
      comparison.universe,
      comparison.killsA,
      comparison.killsB,
      comparison.unknown,
      comparison.sameKills,
    ]).toEqual([3, [M1, M2, M3], [M1, M3], [], [], false]);
  });

  it('lists every mutant of a run with a test as observed, and none of a run without tests', () => {
    const run = extractObservations(
      results([mutant(M1), mutant(M2, { coveredBy: [], perTest: [] })]),
      MAIN,
    );
    const empty: RunUniverse = { ...run.universe, group: 'g2', tests: [] };
    expect(observedMutants(mergeObservations(run.observations, [run.universe, empty]))).toEqual([
      M1,
      M2,
    ]);
  });
});

describe('work-file rows', () => {
  const run = extractObservations(
    results([
      mutant(M1),
      mutant(M2, { static: true, coveredBy: [], perTest: [], hookAttributedTests: null }),
      mutant(M3, { coveredBy: [] }),
    ]),
    MAIN,
  );

  it('round-trips the explicit observations through rows of the universe', () => {
    const rows = encodeObservations(run.universe, run.observations);
    expect([
      rows[0],
      decodeObservations(run.universe, JSON.parse(JSON.stringify(rows)) as unknown[]),
    ]).toEqual([[0, 0, 0, 'killed-by-test:assertion', 'row', true, false, []], run.observations]);
  });

  it.each([
    ['a test outside the universe', { test: 'test/unit/z.test.ts#Z > z' }],
    ['a mutant outside the universe', { mutant: 'gitnexus/src/z.ts@0:1:1-1:2:X:0' }],
    ['another run', { shard: 3 }],
  ])('refuses to encode an observation of %s', (_title, change: Partial<Observation>) => {
    expect(() => encodeObservations(run.universe, [{ ...run.observations[0], ...change }])).toThrow(
      /does not fit its run universe/,
    );
  });

  it.each([
    ['a test index out of range', [9, 0, 0, null, 'row', true, null, []]],
    ['an unknown source', [0, 0, 0, null, 'guess', true, null, []]],
    ['a short row', [0, 0, 0]],
  ])('refuses to decode a row with %s', (_title, row) => {
    expect(() => decodeObservations(run.universe, [row])).toThrow(/row 0 is not an observation/);
  });

  it('implies the observation the full materialisation stored for an uncovered test', () => {
    const [, , uncovered] = run.universe.mutants;
    expect(impliedObservation(run.universe, uncovered, T2)).toEqual(
      observation({
        attempt: null,
        test: T2,
        mutant: M3,
        covered: false,
        outcome: 'survived',
        source: 'not-covered',
      }),
    );
  });
});
