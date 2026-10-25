/**
 * Locks the compact observation model (U7, U12, R11) against the V8 string-limit overflow of the
 * first full run: a run stores its universe and O(covered entries + per-test rows) explicit
 * observations, never one per test and mutant, and skipped tests are no tests of the run. The
 * small case pins comparePair, the per-test results and the gaps to the values the full
 * materialisation (every not-covered survival stored) gave, and checks that the verdict report over
 * the compact input equals the one over that materialisation.
 */
import { describe, expect, it } from 'vitest';
import type {
  NormalisedMutant,
  NormalisedTest,
  PerTestRow,
  RunResults,
} from '../../../tools/mutation/driver/normalise-results.js';
import type { OutcomeClass } from '../../../tools/mutation/runner/classify-outcome.js';
import {
  comparePair,
  encodeObservations,
  extractObservations,
  indexObservations,
  mergeObservations,
  type Observation,
  type RunObservations,
  type RunRef,
} from '../../../tools/scenario-map/mutation/observations.js';
import {
  computeVerdicts,
  type VerdictInput,
  type VerdictPairInput,
  type VerdictTestInput,
} from '../../../tools/scenario-map/verdict/verdict.js';

const KILL: OutcomeClass = 'killed-by-test:assertion';
const MAIN: RunRef = { group: 'g1', kind: 'main', lineage: 'main', shard: 0 };

const testRecord = (id: string, skipped: boolean): NormalisedTest => ({
  id,
  file: id.split('#')[0],
  fullName: id.split('#')[1],
  taskId: null,
  skipped,
  notOracleValidated: false,
  killed: [],
  assertionKilled: [],
});

const row = (testId: string, outcome: OutcomeClass): PerTestRow => ({
  testId,
  outcome,
  attempt: 0,
});

const mutant = (globalId: string, overrides: Partial<NormalisedMutant> = {}): NormalisedMutant => ({
  globalId,
  localId: globalId.slice(-4),
  file: globalId.split('@')[0],
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
  mutatorName: 'ArithmeticOperator',
  replacement: '-',
  static: false,
  status: 'Survived',
  statusReason: null,
  testsCompleted: 1,
  outcome: 'survived',
  outcomeSource: 'sidecar',
  killedBy: [],
  coveredBy: [],
  assertionKilledBy: [],
  sidecar: null,
  attempts: [
    {
      file: '/s/m.json',
      worker: '0',
      attempt: 0,
      pid: 1,
      writtenAtMs: 1,
      status: 'survived',
      outcome: 'survived',
      nrOfTests: 1,
    },
  ],
  perTest: [],
  attemptsDisagree: false,
  hookAttributedTests: [],
  flags: [],
  ...overrides,
});

function results(
  mutants: NormalisedMutant[],
  selected: string[],
  skipped: readonly string[],
): RunResults {
  return {
    schemaVersion: 2,
    variant: 'vitest5',
    scope: { testFiles: ['test/unit/a.test.ts'], mutate: [], testIds: selected },
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
    stryker: { exitCode: 0, wallClockMs: 1 },
    spanMap: { checked: mutants.length, failures: [] },
    manifest: null,
    dryRun: {
      file: '/s/dry.json',
      status: 'survived',
      outcome: 'survived',
      reason: null,
      nrOfTests: selected.length,
      attempts: 1,
    },
    mutants,
    tests: [
      ...selected.map((id) => testRecord(id, false)),
      ...skipped.map((id) => testRecord(id, true)),
    ],
    flags: [],
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
  };
}

/**
 * The full materialisation the compact model replaced: every selected test without an explicit
 * observation of a non-static universe mutant stored as a not-covered survival.
 */
function materialise(run: RunObservations): Observation[] {
  const explicit = new Set(run.observations.map((entry) => `${entry.test}\n${entry.mutant}`));
  const reasons = (own: readonly string[]): string[] =>
    [...new Set([...run.universe.reasons, ...own])].sort();
  const implied = run.universe.mutants.flatMap((entry) =>
    entry.static
      ? []
      : run.universe.tests
          .filter((test) => !explicit.has(`${test}\n${entry.id}`))
          .map(
            (test): Observation => ({
              ...MAIN,
              attempt: null,
              test,
              mutant: entry.id,
              file: entry.file,
              covered: false,
              hookAttributed: entry.hookMarker ? false : null,
              static: false,
              outcome: 'survived',
              source: 'not-covered',
              valid: reasons(entry.reasons).length === 0,
              reasons: reasons(entry.reasons),
            }),
          ),
  );
  return [...run.observations, ...implied];
}

// ── Regression: 2,000 uncovered mutants × 50 selected tests + 30 skipped ────

describe('a large run in the compact model', () => {
  const pad = (index: number): string => String(index).padStart(4, '0');
  const selected = Array.from(
    { length: 50 },
    (_, index) => `test/unit/a.test.ts#A > t${pad(index)}`,
  );
  const skipped = Array.from(
    { length: 30 },
    (_, index) => `test/unit/a.test.ts#A > s${pad(index)}`,
  );
  const id = (index: number, mutator: string): string =>
    `gitnexus/src/x.ts@0123456789abcdef:${index + 1}:1-${index + 1}:5:${mutator}:` +
    `${pad(index)}aaaaaaaaaaaa`;
  // 2,000 non-static mutants no selected test covers; every 10th one covered by a skipped test.
  const uncovered = Array.from({ length: 2000 }, (_, index) =>
    mutant(id(index, 'BlockStatement'), {
      status: 'NoCoverage',
      outcomeSource: 'no-coverage',
      attempts: [],
      coveredBy: index % 10 === 0 ? [skipped[index % 30]] : [],
    }),
  );
  // 10 mutants covered by two selected tests each (one kill and one survival row: 20 rows).
  const covered = Array.from({ length: 10 }, (_, index) =>
    mutant(id(2000 + index, 'ArithmeticOperator'), {
      status: 'Killed',
      outcome: KILL,
      coveredBy: [selected[index], selected[index + 1]],
      perTest: [row(selected[index], KILL), row(selected[index + 1], 'survived')],
    }),
  );
  // 2 static mutants: every selected test runs against them (100 rows).
  const statik = Array.from({ length: 2 }, (_, index) =>
    mutant(id(2010 + index, 'StringLiteral'), {
      static: true,
      perTest: selected.map((test) => row(test, 'survived')),
    }),
  );
  const run = extractObservations(
    results([...uncovered, ...covered, ...statik], selected, skipped),
    MAIN,
  );

  it('stores O(covered + rows) explicit observations, not one per test and mutant', () => {
    expect([
      run.universe.tests.length,
      run.universe.mutants.length,
      run.observations.length,
    ]).toEqual([50, 2012, 20 + 100]);
  });

  it('gives the skipped tests no observation and no place in the universe', () => {
    const skippedIds = new Set(skipped);
    expect([
      run.universe.tests.some((test) => skippedIds.has(test)),
      run.observations.some((entry) => skippedIds.has(entry.test)),
    ]).toEqual([false, false]);
  });

  it('writes the run as rows of a few bytes each', () => {
    const rows = encodeObservations(run.universe, run.observations);
    expect(JSON.stringify(rows).length).toBeLessThan(run.observations.length * 64);
  });

  it('still compares two selected tests over every evaluated mutant', () => {
    const index = indexObservations(mergeObservations(run.observations, [run.universe]));
    const comparison = comparePair(index, MAIN, selected[0], selected[1]);
    expect([
      comparison.universe.length,
      comparison.unknown.length,
      comparison.killsA.length,
      comparison.killsB.length,
      comparison.sameKills,
    ]).toEqual([2012, 0, 1, 1, false]);
  });
});

// ── Equivalence with the full materialisation on a small case ──────────────

const T1 = 'test/unit/a.test.ts#A > one';
const T2 = 'test/unit/a.test.ts#A > two';
const T3 = 'test/unit/b.test.ts#B > three';
const TS = 'test/unit/b.test.ts#B > skipped';
const X = 'gitnexus/src/x.ts';
const Y = 'gitnexus/src/y.ts';
const gid = (file: string, line: number, mutator: string): string =>
  `${file}@0123456789abcdef:${line}:1-${line}:5:${mutator}:${line.toString(16).padStart(16, 'a')}`;
const M = {
  killedByOne: gid(X, 1, 'ArithmeticOperator'),
  statik: gid(X, 2, 'StringLiteral'),
  noCoverage: gid(X, 3, 'BlockStatement'),
  survivedByTwo: gid(X, 4, 'EqualityOperator'),
  missingRow: gid(X, 5, 'ConditionalExpression'),
  flagged: gid(X, 6, 'ArithmeticOperator'),
  noMarker: gid(X, 7, 'EqualityOperator'),
  strykerTimeout: gid(X, 8, 'BlockStatement'),
  skippedOnly: gid(X, 9, 'StringLiteral'),
  killedByOneAndThree: gid(Y, 10, 'ArithmeticOperator'),
  ignored: gid(Y, 11, 'StringLiteral'),
  hookedUncovered: gid(Y, 12, 'EqualityOperator'),
} as const;
const nameOf = new Map(Object.entries(M).map(([name, globalId]) => [globalId, name]));
const names = (ids: readonly string[]): string[] => ids.map((entry) => nameOf.get(entry) ?? entry);
const killed = { status: 'Killed', outcome: KILL } as const;

const smallRun = (): RunObservations =>
  extractObservations(
    results(
      [
        mutant(M.killedByOne, {
          ...killed,
          coveredBy: [T1, T2],
          perTest: [row(T1, KILL), row(T2, 'survived')],
        }),
        mutant(M.statik, {
          static: true,
          perTest: [row(T1, 'survived'), row(T2, 'survived'), row(T3, 'survived')],
        }),
        mutant(M.noCoverage, { status: 'NoCoverage', outcomeSource: 'no-coverage', attempts: [] }),
        mutant(M.survivedByTwo, { coveredBy: [T2], perTest: [row(T2, 'survived')] }),
        mutant(M.missingRow, { coveredBy: [T3] }),
        mutant(M.flagged, {
          ...killed,
          coveredBy: [T1],
          perTest: [row(T1, KILL)],
          flags: ['status-mismatch'],
        }),
        mutant(M.noMarker, {
          ...killed,
          coveredBy: [T2],
          perTest: [row(T2, KILL)],
          hookAttributedTests: null,
        }),
        mutant(M.strykerTimeout, {
          status: 'Timeout',
          outcome: 'timeout',
          outcomeSource: 'stryker-timeout',
          coveredBy: [T1],
          attempts: [],
        }),
        mutant(M.skippedOnly, { coveredBy: [TS] }),
        mutant(M.killedByOneAndThree, {
          ...killed,
          coveredBy: [T1, T3],
          perTest: [row(T1, KILL), row(T3, KILL)],
        }),
        mutant(M.ignored, { status: 'Ignored', attempts: [] }),
        mutant(M.hookedUncovered, {
          coveredBy: [T1],
          perTest: [row(T1, 'survived')],
          hookAttributedTests: [T3],
        }),
      ],
      [T1, T2, T3],
      [TS],
    ),
    MAIN,
  );

const testInput = (id: string): VerdictTestInput => ({
  id,
  eligible: true,
  notOracleValidated: false,
  dupeOk: null,
  joinProblems: [],
  inventoryUnresolved: [],
  provenance: { known: true, nativeEntries: [], workerSpawns: [] },
  concurrent: false,
  excludedFiles: [],
  checksContext: 'k',
  unsupportedForms: [],
  unresolvedSelectors: [],
  facet: null,
});

const pairInput = (a: string, b: string): VerdictPairInput => ({
  a,
  b,
  group: 'g1',
  identicalBlocks: true,
  pathUnattributable: false,
  schedule: { status: 'evaluated', reason: null, detail: null },
  isolation: null,
  rowDeletion: null,
  staticValueFlow: null,
  trace: null,
});

const verdictInput = (observations: VerdictInput['observations']): VerdictInput => ({
  tests: [T1, T2, T3].map(testInput),
  pairs: [pairInput(T1, T2), pairInput(T1, T3), pairInput(T2, T3)],
  observations,
  valueFlowDegraded: [],
});

describe('the compact model against the full materialisation', () => {
  const run = smallRun();
  const compact = mergeObservations(run.observations, [run.universe]);
  const full = mergeObservations(materialise(run), []);

  it('stores 14 of the 33 observations the materialisation held', () => {
    expect([run.observations.length, materialise(run).length]).toEqual([14, 33]);
  });

  // Expected values: the pre-compact implementation on the same results.
  it.each([
    [
      'one and two',
      T1,
      T2,
      'u33495bf29f08f907',
      [
        'killedByOne',
        'statik',
        'noCoverage',
        'survivedByTwo',
        'missingRow',
        'noMarker',
        'skippedOnly',
        'killedByOneAndThree',
        'hookedUncovered',
      ],
      ['flagged', 'strykerTimeout'],
      ['killedByOne', 'killedByOneAndThree'],
      ['noMarker'],
    ],
    [
      'one and three',
      T1,
      T3,
      'uf232dd5e4781a286',
      [
        'killedByOne',
        'statik',
        'noCoverage',
        'survivedByTwo',
        'noMarker',
        'skippedOnly',
        'killedByOneAndThree',
        'hookedUncovered',
      ],
      ['missingRow', 'flagged', 'strykerTimeout'],
      ['killedByOne', 'killedByOneAndThree'],
      ['killedByOneAndThree'],
    ],
    [
      'two and three',
      T2,
      T3,
      'ud73e410af4b52027',
      [
        'killedByOne',
        'statik',
        'noCoverage',
        'survivedByTwo',
        'noMarker',
        'strykerTimeout',
        'skippedOnly',
        'killedByOneAndThree',
        'hookedUncovered',
      ],
      ['missingRow', 'flagged'],
      ['noMarker'],
      ['killedByOneAndThree'],
    ],
  ])(
    'compares tests %s as the materialisation did',
    (_title, a, b, universeId, universe, unknown, killsA, killsB) => {
      const comparison = comparePair(indexObservations(compact), MAIN, a, b);
      expect({
        universeId: comparison.universeId,
        universe: names(comparison.universe),
        unknown: names(comparison.unknown),
        killsA: names(comparison.killsA),
        killsB: names(comparison.killsB),
        otherClasses: comparison.otherClasses,
        sameKills: comparison.sameKills,
      }).toEqual({
        universeId,
        universe,
        unknown,
        killsA,
        killsB,
        otherClasses: [],
        sameKills: null,
      });
    },
  );

  it('gives the per-test results the materialisation gave', () => {
    const report = computeVerdicts(verdictInput(compact));
    expect(
      report.tests.map((test) => [test.status, test.covered, test.kills, test.subsumption]),
    ).toEqual([
      [
        'killing',
        5,
        2,
        { status: 'not-subsumed', by: [], universeId: 'u33495bf29f08f907', universe: 11 },
      ],
      [
        'killing',
        3,
        1,
        { status: 'not-subsumed', by: [], universeId: 'u13a8131490f974fb', universe: 11 },
      ],
      [
        'killing',
        2,
        1,
        { status: 'unknown', by: [T1], universeId: 'ud73e410af4b52027', universe: 11 },
      ],
    ]);
  });

  it('gives the gaps the materialisation gave', () => {
    const report = computeVerdicts(verdictInput(compact));
    expect(
      report.gaps.map((gap) => [
        gap.file,
        gap.mutants,
        gap.killed,
        names(gap.survived),
        names(gap.uncovered),
        names(gap.inconclusive),
      ]),
    ).toEqual([
      [
        X,
        9,
        2,
        ['statik', 'survivedByTwo'],
        ['noCoverage', 'skippedOnly'],
        ['missingRow', 'flagged', 'strykerTimeout'],
      ],
      [Y, 2, 1, ['hookedUncovered'], [], []],
    ]);
  });

  it('computes a verdict report identical to the one over the materialisation', () => {
    expect(computeVerdicts(verdictInput(compact))).toEqual(computeVerdicts(verdictInput(full)));
  });
});
