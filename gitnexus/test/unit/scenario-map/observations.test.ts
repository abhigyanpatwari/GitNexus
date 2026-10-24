/**
 * Locks Layer 3's raw observations (U7, R6, R7, R11, KTD8, design §5.4): one observation per
 * per-test row of every sidecar attempt, keyed by group, run kind, lineage, attempt, test and
 * global mutant id; an uncovered test of a non-static mutant is a survived observation, while a
 * covered or static mutant without a row is unknown, never a non-kill; untrusted runs, attempt
 * disagreements and integrity flags invalidate; merging folds attempts of one lineage and turns a
 * class disagreement into one inconclusive observation; observations of different groups stay
 * apart, and a pair is compared only over its common universe inside one group run.
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
  extractObservations,
  mergeObservations,
  observationKey,
  type Observation,
  type RunRef,
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

/** The observation of one test and mutant, as `[outcome, source, valid, reasons]`. */
const summary = (
  observations: readonly Observation[],
  test: string,
  globalId: string,
): [OutcomeClass | null, string, boolean, string[]][] =>
  observations
    .filter((entry) => entry.test === test && entry.mutant === globalId)
    .map((entry) => [entry.outcome, entry.source, entry.valid, entry.reasons]);

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
    const observations = extractObservations(results([mutant(M1)]), MAIN);
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

  it('records an uncovered test of a non-static mutant as a valid survived observation', () => {
    const narrow = mutant(M1, {
      coveredBy: [T1],
      perTest: [{ testId: T1, outcome: 'killed-by-test:assertion', attempt: 0 }],
    });
    expect(summary(extractObservations(results([narrow]), MAIN), T2, M1)).toEqual([
      ['survived', 'not-covered', true, []],
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
    const observations = extractObservations(results([statik]), MAIN);
    expect(summary(observations, T2, M1)).toEqual([[null, 'no-row', false, ['missing-result']]]);
    expect(summary(observations, T1, M1)).toEqual([['survived', 'row', true, []]]);
    expect(observations.every((entry) => entry.static && !entry.covered)).toBe(true);
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
    const observations = extractObservations(results([killed]), MAIN);
    expect(summary(observations, T1, M1)).toEqual([
      ['timeout', 'stryker-timeout', false, ['stryker-timeout']],
    ]);
    expect(summary(observations, T2, M1)).toEqual([['survived', 'not-covered', true, []]]);
  });

  it('records a NoCoverage mutant as survived by every test', () => {
    const uncovered = mutant(M1, {
      status: 'NoCoverage',
      outcome: 'survived',
      outcomeSource: 'no-coverage',
      coveredBy: [],
      attempts: [],
      perTest: [],
    });
    expect(
      extractObservations(results([uncovered]), MAIN).map((entry) => [
        entry.test,
        entry.outcome,
        entry.valid,
      ]),
    ).toEqual([
      [T1, 'survived', true],
      [T2, 'survived', true],
    ]);
  });

  it.each(['Ignored', 'Pending'] as const)('leaves a %s mutant out of the universe', (status) => {
    expect(extractObservations(results([mutant(M1, { status, perTest: [] })]), MAIN)).toEqual([]);
  });

  it('invalidates every observation of a run with a run-level integrity flag', () => {
    const flags: RunResults['flags'] = [
      { kind: 'dry-run-missing', localId: null, globalId: null, detail: 'no dry run' },
    ];
    const observations = extractObservations(results([mutant(M1)], { flags }), MAIN);
    expect(observations.map((entry) => entry.reasons)).toEqual([
      ['run-flag:dry-run-missing'],
      ['run-flag:dry-run-missing'],
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
    const observations = extractObservations(results([mutant(M1)], { spanFailures: [M1] }), MAIN);
    expect(observations.map((entry) => [entry.valid, entry.reasons])).toEqual([
      [false, ['span-map']],
      [false, ['span-map']],
    ]);
  });

  it('marks the hook-attributed tests and leaves the marker unknown without a dry-run record', () => {
    const hooked = mutant(M1, { hookAttributedTests: [T2] });
    const unknown = mutant(M2, { hookAttributedTests: null });
    const observations = extractObservations(results([hooked, unknown]), MAIN);
    expect(
      observations.map((entry) => [entry.mutant === M1 ? 'M1' : 'M2', entry.hookAttributed]),
    ).toEqual([
      ['M1', false],
      ['M1', true],
      ['M2', null],
      ['M2', null],
    ]);
  });

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
    const merged = mergeObservations([
      observation({ attempt: 0, outcome: 'killed-by-test:assertion' }),
      observation({ attempt: 1, outcome: 'survived' }),
    ]);
    expect(
      merged.map((entry) => [entry.outcome, entry.valid, entry.reasons, entry.attempts]),
    ).toEqual([['inconclusive', false, ['class-disagreement'], [0, 1]]]);
  });

  it('folds agreeing attempts into one valid observation', () => {
    const merged = mergeObservations([
      observation({ attempt: 0 }),
      observation({ attempt: 1 }),
      observation({ attempt: 1 }),
    ]);
    expect(merged.map((entry) => [entry.outcome, entry.valid, entry.attempts])).toEqual([
      ['killed-by-test:assertion', true, [0, 1]],
    ]);
  });

  it('keeps the observations of one mutant in two groups apart', () => {
    const merged = mergeObservations([
      observation({ group: 'gx', test: T1, outcome: 'killed-by-test:assertion' }),
      observation({ group: 'gy', test: T2, outcome: 'survived' }),
    ]);
    expect(merged.map((entry) => [entry.group, entry.test, entry.outcome])).toEqual([
      ['gx', T1, 'killed-by-test:assertion'],
      ['gy', T2, 'survived'],
    ]);
  });

  it('carries the reasons of an invalid observation into the merged one', () => {
    const merged = mergeObservations([
      observation({ attempt: 0 }),
      observation({ attempt: 1, valid: false, reasons: ['run-timeout'] }),
    ]);
    expect(merged.map((entry) => [entry.valid, entry.reasons])).toEqual([[false, ['run-timeout']]]);
  });
});

describe('comparePair', () => {
  const run = { group: 'g1', kind: 'main', lineage: 'main' } as const;

  it('compares equal kill sets over the common universe', () => {
    const merged = mergeObservations([
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
    const merged = mergeObservations([
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
    const merged = mergeObservations([
      observation({ group: 'gx' }),
      observation({ group: 'gx', test: T2 }),
    ]);
    expect(comparePair(merged, run, T1, T2)).toMatchObject({
      universe: [],
      unknown: [],
      sameKills: null,
    });
  });

  it('makes an invalid observation unknown for the pair', () => {
    const merged = mergeObservations([
      observation({ test: T1, mutant: M1 }),
      observation({ test: T2, mutant: M1, valid: false, reasons: ['missing-result'] }),
    ]);
    expect(comparePair(merged, run, T1, T2).unknown).toEqual([M1]);
  });

  it('compares only inside the requested group run', () => {
    const merged = mergeObservations([
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
    const merged = mergeObservations([
      observation({ test: T1, mutant: M1, outcome: 'killed-by-test:runtime' }),
      observation({ test: T2, mutant: M1 }),
      observation({ test: T1, mutant: M2, outcome: 'timeout' }),
      observation({ test: T2, mutant: M2, outcome: 'survived' }),
    ]);
    expect(comparePair(merged, run, T1, T2).otherClasses).toEqual([M1, M2]);
  });
});
