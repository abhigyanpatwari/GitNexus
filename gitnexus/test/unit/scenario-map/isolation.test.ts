/**
 * Locks the full isolation pass (U8, R7, KTD9, design §5.4) without spawning Vitest or Stryker:
 * observations are in memory and every runner is a fake. Only pairs with the same path, checks,
 * context, facet (the D1 residual guard included) and non-empty kill set reach the repeat stage;
 * each selected pair gets one together run, and each test one alone run over the union of its
 * pairs' universes; mutate is the universe as Stryker ranges; every run reuses no test-runner
 * process; per test and mutant, coverage and outcome class (and the unmutated baseline) must agree
 * across main, together and alone (a not-covered survival a run universe implies included), a
 * missing result is unknown, and a hook-attributed mutant caps the pair at weak. Result files hold
 * the compact model (schema 2); a schema 1 file is rejected.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  NormalisedMutant,
  RunResults,
} from '../../../tools/mutation/driver/normalise-results.js';
import type { RunScopeOptions } from '../../../tools/mutation/driver/run-scope.js';
import {
  buildStrykerConfig,
  formatMutateEntry,
  parseMutateEntry,
  type StrykerConfigInput,
} from '../../../tools/mutation/driver/stryker-config.js';
import type { OutcomeClass } from '../../../tools/mutation/runner/classify-outcome.js';
import type { RunManifest } from '../../../tools/mutation/runner/run-manifest.js';
import type { InputFacet } from '../../../tools/scenario-map/facet/input-facet.js';
import {
  ISOLATION_TEST_RUNNER_REUSE,
  evaluateIsolation,
  isolationRunId,
  mutateRangesOf,
  pairKey,
  planIsolation,
  readIsolationRun,
  readIsolationRuns,
  runIsolationRun,
  selectRepeatStagePairs,
  type IsolationRunResult,
  type IsolationRunSpec,
  type RepeatStageDecision,
  type RepeatStageFacts,
} from '../../../tools/scenario-map/mutation/isolation.js';
import {
  mergeObservations,
  type Observation,
  type RunKind,
  type RunUniverse,
} from '../../../tools/scenario-map/mutation/observations.js';
import type { PairRef } from '../../../tools/scenario-map/mutation/plan-shards.js';
import {
  buildRunManifest,
  type BaselineSummary,
  type GroupRunDeps,
  type ScenarioRunManifest,
} from '../../../tools/scenario-map/mutation/run-group.js';
import type {
  VitestRunOptions,
  VitestRunResult,
} from '../../../tools/scenario-map/mutation/vitest-run.js';

const A = 'test/unit/a.test.ts#A > one';
const B = 'test/unit/a.test.ts#A > two';
const C = 'test/unit/c.test.ts#C > three';
const id = (span: string, mutator: string): string =>
  `gitnexus/src/x.ts@0123456789abcdef:${span}:${mutator}:aaaaaaaaaaaaaaaa`;
/** Killed by both tests. */
const M1 = id('2:10-2:22', 'ArithmeticOperator');
/** Covered by both tests, survived by both. */
const M2 = id('3:7-3:16', 'ConditionalExpression');
/** Covered by neither test. */
const M3 = id('6:18-8:4', 'BlockStatement');
/** Killed by both tests in another pair's universe. */
const M4 = id('9:1-9:9', 'StringLiteral');
const KILL: OutcomeClass = 'killed-by-test:assertion';
const PAIR: PairRef = { group: 'g1', a: A, b: B };

const temps: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-u8-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── In-memory observations ─────────────────────────────────────────────────

const observation = (
  test: string,
  mutant: string,
  overrides: Partial<Observation> = {},
): Observation => ({
  group: 'g1',
  kind: 'main',
  lineage: 'main',
  shard: 0,
  attempt: 0,
  test,
  mutant,
  file: 'gitnexus/src/x.ts',
  covered: true,
  hookAttributed: false,
  static: false,
  outcome: KILL,
  source: 'row',
  valid: true,
  reasons: [],
  ...overrides,
});

const uncovered: Partial<Observation> = {
  covered: false,
  outcome: 'survived',
  source: 'not-covered',
  attempt: null,
};

/** One run's observations of A and B on M1 (killed), M2 (survived) and M3 (not covered). */
const pairWorld = (overrides: Partial<Observation> = {}): Observation[] =>
  [A, B].flatMap((test) => [
    observation(test, M1, overrides),
    observation(test, M2, { outcome: 'survived', ...overrides }),
    observation(test, M3, { ...uncovered, ...overrides }),
  ]);

const replace = (
  entries: readonly Observation[],
  test: string,
  mutant: string,
  change: Partial<Observation>,
): Observation[] =>
  entries.map((entry) =>
    entry.test === test && entry.mutant === mutant ? { ...entry, ...change } : entry,
  );

const facet = (fingerprint = 'f1', skeleton: string[] = ['body\tcall']): InputFacet => ({
  fingerprint,
  parts: { language: '-', source: [], fixtures: [], data: [], calls: [], order: [] },
  discarded: [],
  unresolved: [],
  skeleton,
});

const facts = (
  main: readonly Observation[] = pairWorld(),
  overrides: Partial<Omit<RepeatStageFacts, 'merged'>> = {},
): RepeatStageFacts => ({
  merged: mergeObservations(main, []),
  checksContext: new Map([
    [A, 'k1'],
    [B, 'k1'],
    [C, 'k1'],
  ]),
  facets: new Map([
    [A, facet()],
    [B, facet()],
    [C, facet()],
  ]),
  ...overrides,
});

const decisionOf = (main: readonly Observation[] = pairWorld()): RepeatStageDecision =>
  selectRepeatStagePairs([PAIR], facts(main))[0];

// ── Isolation run results ──────────────────────────────────────────────────

const passed = (tests: readonly string[]): BaselineSummary => ({
  wallClockMs: 1,
  outcome: 'survived',
  identities: tests.map((test, index) => `${test}@${index + 1}:3`),
  failing: [],
  problems: [],
});

/** A complete run result of a planned run, with its observations retagged to the run. */
function runResult(
  spec: IsolationRunSpec,
  observations: readonly Observation[],
  overrides: Partial<IsolationRunResult> = {},
): IsolationRunResult {
  const tests = new Set(spec.tests);
  return {
    schemaVersion: 2,
    id: spec.id,
    group: spec.group,
    kind: spec.kind,
    lineage: spec.lineage,
    tests: spec.tests,
    testFiles: spec.testFiles,
    universe: spec.universe,
    mutate: spec.mutate,
    shard: 0,
    manifestDigest: 'd',
    status: 'complete',
    reason: null,
    detail: null,
    settings: { concurrency: 2, maxTestRunnerReuse: 1, timeoutMS: 10_000 },
    baselines: [passed(spec.tests), passed(spec.tests)],
    stryker: null,
    runUniverse: null,
    observations: observations
      .filter((entry) => tests.has(entry.test) && spec.universe.includes(entry.mutant))
      .map((entry) => ({ ...entry, kind: spec.kind, lineage: spec.lineage })),
    missing: [],
    outsideUniverse: 0,
    wallClockMs: 1,
    ...overrides,
  };
}

interface RerunWorld {
  main?: Observation[];
  together?: Observation[];
  alone?: Partial<Record<string, Observation[]>>;
  aloneOverrides?: Partial<Record<string, Partial<IsolationRunResult>>>;
}

/** Plans the pair, fakes each run from the given observations and evaluates the pass. */
function evaluate(world: RerunWorld = {}) {
  const main = world.main ?? pairWorld();
  const decision = decisionOf(main);
  const runs = planIsolation([decision]).runs.map((spec) =>
    spec.kind === 'together'
      ? runResult(spec, world.together ?? pairWorld())
      : runResult(
          spec,
          world.alone?.[spec.lineage] ?? pairWorld(),
          world.aloneOverrides?.[spec.lineage],
        ),
  );
  const [result] = evaluateIsolation([decision], {
    merged: mergeObservations(main, []),
    runs,
    manifestDigest: 'd',
  });
  return { result, runs };
}

/** A run universe of g1 over non-static mutants of x.ts. */
const universeOf = (
  kind: RunKind,
  lineage: string,
  tests: readonly string[],
  mutants: readonly string[],
): RunUniverse => ({
  group: 'g1',
  kind,
  lineage,
  shard: 0,
  tests: [...tests],
  mutants: mutants.map((mutant) => ({
    id: mutant,
    file: 'gitnexus/src/x.ts',
    static: false,
    status: 'Survived',
    reasons: [],
    hookMarker: true,
  })),
  valid: true,
  reasons: [],
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('selectRepeatStagePairs', () => {
  it('selects a pair with the same path, checks, context, facet and non-empty kills', () => {
    const decision = decisionOf();
    expect([decision.selected, decision.misses, decision.key]).toEqual([
      true,
      [],
      JSON.stringify([A, B]),
    ]);
  });

  it('takes the mutants either test was exposed to as the isolation universe', () => {
    const main = [
      ...pairWorld(),
      observation(A, M4, { covered: false, static: true }),
      observation(B, M4, { covered: false, static: true }),
    ];
    expect(decisionOf(main).universe).toEqual([M1, M2, M4].sort());
  });

  it.each([
    [
      'different kill sets',
      replace(pairWorld(), B, M1, { outcome: 'survived' }),
      {},
      ['kills-differ'],
    ],
    [
      'an unknown kill set',
      replace(pairWorld(), B, M2, { valid: false, reasons: ['missing-result'] }),
      {},
      ['kills-unknown'],
    ],
    ['a group run without observations', [], {}, ['kills-unknown']],
    [
      'two empty kill sets',
      pairWorld().map((entry) => ({ ...entry, outcome: 'survived' as const })),
      {},
      ['kills-empty'],
    ],
    [
      'a timeout on a universe mutant',
      replace(replace(pairWorld(), A, M2, { outcome: 'timeout' }), B, M2, { outcome: 'timeout' }),
      {},
      ['other-classes'],
    ],
    ['another canonical path', replace(pairWorld(), B, M2, uncovered), {}, ['path-differs']],
    [
      'a missing checks-and-context key',
      pairWorld(),
      { checksContext: new Map([[A, 'k1']]) },
      ['checks-context-missing'],
    ],
    [
      'different checks or context',
      pairWorld(),
      {
        checksContext: new Map([
          [A, 'k1'],
          [B, 'k2'],
        ]),
      },
      ['checks-context-differs'],
    ],
    ['a missing facet', pairWorld(), { facets: new Map([[A, facet()]]) }, ['facet-missing']],
    [
      'different facets',
      pairWorld(),
      {
        facets: new Map([
          [A, facet('f1')],
          [B, facet('f2')],
        ]),
      },
      ['facet-differs'],
    ],
    [
      'equal facets with a residual difference (D1)',
      pairWorld(),
      {
        facets: new Map([
          [A, facet('f1', ['body\tcall', 'body.arg\ttrue'])],
          [B, facet('f1', ['body\tcall', 'body.arg\tfalse'])],
        ]),
      },
      ['facet-residual'],
    ],
  ])('keeps a pair with %s out of the repeat stage', (_title, main, overrides, misses) => {
    const [decision] = selectRepeatStagePairs([PAIR], facts(main, overrides));
    expect([decision.selected, decision.misses]).toEqual([false, misses]);
  });
});

describe('mutateRangesOf', () => {
  it.each([
    ['one mutant, in Babel columns', [M1], ['gitnexus/src/x.ts:2:9-2:21']],
    [
      'two mutators on one span',
      [M2, id('3:7-3:16', 'EqualityOperator')],
      ['gitnexus/src/x.ts:3:6-3:15'],
    ],
    [
      'a mutant nested in another one',
      [id('5:53-13:2', 'BlockStatement'), id('6:7-6:16', 'ConditionalExpression')],
      ['gitnexus/src/x.ts:5:52-13:1'],
    ],
    [
      'mutants of two files',
      [M4, 'gitnexus/src/a.ts@0123456789abcdef:1:1-1:5:StringLiteral:bbbbbbbbbbbbbbbb', M1],
      ['gitnexus/src/a.ts:1:0-1:4', 'gitnexus/src/x.ts:2:9-2:21', 'gitnexus/src/x.ts:9:0-9:8'],
    ],
  ])('covers %s', (_title, universe, ranges) => {
    expect(mutateRangesOf(universe)).toEqual(ranges);
  });

  it('writes ranges the scope driver reads back unchanged', () => {
    const ranges = mutateRangesOf([M1, M2, M4]);
    expect(ranges.map((entry) => formatMutateEntry(parseMutateEntry(entry)))).toEqual(ranges);
  });

  it('rejects a string that is no global mutant id', () => {
    expect(() => mutateRangesOf(['gitnexus/src/x.ts:2:10-2:22'])).toThrow(/no global id/);
  });
});

describe('planIsolation', () => {
  it('schedules no run for a pair that never reached the repeat stage', () => {
    const decision = decisionOf(replace(pairWorld(), B, M1, { outcome: 'survived' }));
    expect([decision.selected, planIsolation([decision]).runs]).toEqual([false, []]);
  });

  it('schedules one together run per pair and alone(A) once over the union for A-B and A-C', () => {
    const main = [
      ...pairWorld(),
      observation(A, M4),
      observation(B, M4, uncovered),
      observation(C, M1),
      observation(C, M2, { outcome: 'survived' }),
      observation(C, M3, uncovered),
      observation(C, M4),
    ];
    // B is not exposed to M4, so A-B's universe is M1 and M2, and A-C's adds M4.
    const ab = decisionOf();
    const [ac] = selectRepeatStagePairs([{ group: 'g1', a: A, b: C }], facts(main));
    const plan = planIsolation([ab, ac]);
    expect(plan.runs.map((run) => [run.kind, run.lineage, run.universe, run.pairs])).toEqual([
      ['alone', A, [M1, M2, M4].sort(), [pairKey(A, B), pairKey(A, C)].sort()],
      ['alone', B, [M1, M2].sort(), [pairKey(A, B)]],
      ['alone', C, [M1, M2, M4].sort(), [pairKey(A, C)]],
      ['together', pairKey(A, B), [M1, M2].sort(), [pairKey(A, B)]],
      ['together', pairKey(A, C), [M1, M2, M4].sort(), [pairKey(A, C)]],
    ]);
  });

  it('gives each run its tests, test files, ranges and a path-safe id', () => {
    const [together] = planIsolation([decisionOf()]).runs.filter((run) => run.kind === 'together');
    expect(together).toEqual({
      id: isolationRunId('together', pairKey(A, B)),
      group: 'g1',
      kind: 'together',
      lineage: pairKey(A, B),
      tests: [A, B],
      testFiles: ['test/unit/a.test.ts'],
      universe: [M1, M2].sort(),
      mutate: ['gitnexus/src/x.ts:2:9-2:21', 'gitnexus/src/x.ts:3:6-3:15'],
      pairs: [pairKey(A, B)],
    });
    expect(together.id).toMatch(/^together-[0-9a-f]{16}$/);
  });
});

describe('evaluateIsolation', () => {
  it('agrees when main, together and alone observations all agree', () => {
    const { result, runs } = evaluate();
    expect([result.status, result.reason, result.disagreements, result.unknown]).toEqual([
      'agrees',
      null,
      [],
      [],
    ]);
    expect(result.runs).toEqual(runs.map((run) => run.id).sort());
  });

  it('names M when A kills it in main and together but survives it alone', () => {
    const { result } = evaluate({
      alone: { [A]: replace(pairWorld(), A, M1, { outcome: 'survived' }) },
    });
    expect([result.status, result.reason, result.disagreements]).toEqual([
      'disagrees',
      'isolation-disagrees',
      [{ test: A, mutant: M1, field: 'outcome', main: KILL, together: KILL, alone: 'survived' }],
    ]);
  });

  it('disagrees when B covers M in main but not alone', () => {
    const { result } = evaluate({
      alone: { [B]: replace(pairWorld(), B, M2, uncovered) },
    });
    expect([result.status, result.disagreements]).toEqual([
      'disagrees',
      [
        {
          test: B,
          mutant: M2,
          field: 'coverage',
          main: 'covered',
          together: 'covered',
          alone: 'not-covered',
        },
      ],
    ]);
  });

  it('disagrees on the baseline when B fails alone unmutated, and its mutants are unknown', () => {
    const failing: BaselineSummary = {
      ...passed([B]),
      outcome: KILL,
      failing: [{ test: B, outcome: KILL, message: "expected 'beta-1' to be 'beta-2'" }],
    };
    const { result } = evaluate({
      alone: { [B]: [] },
      aloneOverrides: {
        [B]: {
          status: 'inconclusive',
          reason: 'baseline-failed',
          detail: 'baseline 1: ...',
          baselines: [failing],
        },
      },
    });
    expect([result.status, result.disagreements]).toEqual([
      'disagrees',
      [
        {
          test: B,
          mutant: null,
          field: 'baseline',
          main: 'passed',
          together: 'passed',
          alone: KILL,
        },
      ],
    ]);
    expect(result.unknown.map((entry) => [entry.mutant, entry.runs, entry.reasons])).toEqual([
      [M1, ['alone'], ['run:baseline-failed']],
      [M2, ['alone'], ['run:baseline-failed']],
    ]);
  });

  it('is unknown, never agreeing, when a rerun lacks a mutant', () => {
    const { result } = evaluate({ together: pairWorld().filter((entry) => entry.mutant !== M2) });
    expect([result.status, result.reason, result.unknown]).toEqual([
      'unknown',
      'isolation-unknown',
      [
        { test: A, mutant: M2, runs: ['together'], reasons: ['missing'] },
        { test: B, mutant: M2, runs: ['together'], reasons: ['missing'] },
      ],
    ]);
  });

  it('is unknown when a rerun observation is invalid', () => {
    const { result } = evaluate({
      alone: { [A]: replace(pairWorld(), A, M1, { valid: false, reasons: ['attempts-disagree'] }) },
    });
    expect([result.status, result.unknown]).toEqual([
      'unknown',
      [{ test: A, mutant: M1, runs: ['alone'], reasons: ['attempts-disagree'] }],
    ]);
  });

  it('is unknown when a run was verified against another run manifest', () => {
    const { result } = evaluate({ aloneOverrides: { [A]: { manifestDigest: 'other' } } });
    expect([result.status, result.unknown.map((entry) => [entry.test, entry.reasons])]).toEqual([
      'unknown',
      [
        [A, ['baseline-unknown', 'run:manifest-mismatch']],
        [A, ['run:manifest-mismatch']],
        [A, ['run:manifest-mismatch']],
      ],
    ]);
  });

  it('does not run a pair that never reached the repeat stage', () => {
    const main = replace(pairWorld(), B, M1, { outcome: 'survived' });
    const [result] = evaluateIsolation([decisionOf(main)], {
      merged: mergeObservations(main, []),
      runs: [],
      manifestDigest: 'd',
    });
    expect([result.status, result.reason, result.misses, result.runs]).toEqual([
      'not-run',
      'not-repeat-stage',
      ['kills-differ'],
      [],
    ]);
  });

  it('leaves a selected pair not run when one of its runs wrote no result', () => {
    const decision = decisionOf();
    const runs = planIsolation([decision])
      .runs.filter((spec) => spec.lineage !== B)
      .map((spec) => runResult(spec, pairWorld()));
    const [result] = evaluateIsolation([decision], {
      merged: mergeObservations(pairWorld(), []),
      runs,
      manifestDigest: 'd',
    });
    expect([result.status, result.reason]).toEqual(['not-run', 'not-scheduled']);
  });

  it.each([
    ['in the main run', pairWorld().map((entry) => ({ ...entry, hookAttributed: true })), {}],
    [
      'in an alone run only',
      pairWorld(),
      { alone: { [A]: replace(pairWorld(), A, M1, { hookAttributed: true }) } },
    ],
  ])('caps a pair touching a mutant hook-attributed %s at weak', (_title, main, world) => {
    const { result } = evaluate({ main, ...world });
    expect(result.disqualifiers.map((entry) => [entry.kind, entry.cap])).toEqual([
      ['hook-stratum-unvalidated', 'weak'],
    ]);
    expect(result.disqualifiers[0].mutants).toContain(M1);
  });

  describe('with not-covered survivals implied by run universes', () => {
    /** The pair's explicit observations: M3, covered by neither test, is implied. */
    const explicit = (entries: readonly Observation[]): Observation[] =>
      entries.filter((entry) => entry.mutant !== M3);
    const mainUniverse = universeOf('main', 'main', [A, B], [M1, M2, M3]);
    const merged = mergeObservations(explicit(pairWorld()), [mainUniverse]);
    const [decision] = selectRepeatStagePairs([PAIR], { ...facts(), merged });
    const runsOf = (alone: Partial<Record<string, Observation[]>>): IsolationRunResult[] =>
      planIsolation([decision]).runs.map((spec) =>
        runResult(spec, explicit(alone[spec.lineage] ?? pairWorld()), {
          runUniverse: universeOf(spec.kind, spec.lineage, spec.tests, spec.universe),
        }),
      );

    it.each([
      ['agrees when every run implies the same survivals', {}, 'agrees', []],
      [
        'disagrees when B covers M2 in main but its alone run implies a not-covered survival',
        { [B]: pairWorld().filter((entry) => entry.test !== B || entry.mutant !== M2) },
        'disagrees',
        [[B, M2, 'coverage', 'covered', 'covered', 'not-covered']],
      ],
    ])('%s', (_title, alone, status, disagreements) => {
      const [result] = evaluateIsolation([decision], {
        merged,
        runs: runsOf(alone),
        manifestDigest: 'd',
      });
      expect([
        decision.selected,
        decision.universe,
        result.status,
        result.disagreements.map((entry) => [
          entry.test,
          entry.mutant,
          entry.field,
          entry.main,
          entry.together,
          entry.alone,
        ]),
      ]).toEqual([true, [M1, M2].sort(), status, disagreements]);
    });
  });
});

// ── Runs (fake runners) ────────────────────────────────────────────────────

/** A prepared tree: `gitnexus/` sources plus the two tool versions under node_modules. */
function manifestFor(): ScenarioRunManifest {
  const root = tempDir();
  const files: Record<string, string> = {
    'gitnexus/node_modules/vitest/package.json': JSON.stringify({ version: '5.0.5' }),
    'gitnexus/node_modules/@stryker-mutator/core/package.json': JSON.stringify({
      version: '10.0.0',
    }),
    'gitnexus/src/x.ts': 'export const x = 1;\n',
    'gitnexus/test/unit/a.test.ts': 'it("one", () => {});\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return buildRunManifest({ preparedRoot: root, mode: { kind: 'normal' }, tests: [A, B] });
}

const vitestRun = (tests: readonly string[], failing: readonly string[] = []): VitestRunResult => ({
  tests: tests.map((test, index) => ({
    id: test,
    taskId: `t_${index}`,
    fullName: test.split('#')[1],
    location: { line: index + 1, column: 3 },
    state: failing.includes(test) ? 'failed' : 'passed',
    outcome: failing.includes(test) ? KILL : 'survived',
    message: null,
  })),
  status: failing.length > 0 ? 'killed' : 'survived',
  outcome: failing.length > 0 ? KILL : 'survived',
  reason: null,
  outsideTest: [],
  problems: [],
  unhandledErrors: [],
  wallClockMs: 5,
});

const normalised = (globalId: string, tests: readonly string[]): NormalisedMutant => ({
  globalId,
  localId: globalId.slice(-4),
  file: 'gitnexus/src/x.ts',
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
  mutatorName: 'ArithmeticOperator',
  replacement: '-',
  static: false,
  status: 'Killed',
  statusReason: null,
  testsCompleted: tests.length,
  outcome: KILL,
  outcomeSource: 'sidecar',
  killedBy: [...tests],
  coveredBy: [...tests],
  assertionKilledBy: [...tests],
  sidecar: null,
  attempts: [
    {
      file: '/s/1.json',
      worker: '0',
      attempt: 0,
      pid: 1,
      writtenAtMs: 1,
      status: 'killed',
      outcome: KILL,
      nrOfTests: tests.length,
    },
  ],
  perTest: tests.map((testId) => ({ testId, outcome: KILL, attempt: 0 })),
  attemptsDisagree: false,
  hookAttributedTests: [],
  flags: [],
});

/** Stryker evaluated M1 (in the universe) and M3 (nested in a range, outside it), not M2. */
function strykerResults(outDir: string, tests: readonly string[]): RunResults {
  return {
    schemaVersion: 2,
    variant: 'vitest5',
    scope: { testFiles: ['test/unit/a.test.ts'], mutate: [], testIds: [...tests] },
    paths: {
      outDir,
      preparedRoot: path.join(outDir, 'prepared'),
      packageDir: path.join(outDir, 'prepared', 'gitnexus'),
      configFile: path.join(outDir, 'stryker.config.json'),
      reportFile: path.join(outDir, 'mutation.json'),
      logFile: path.join(outDir, 'stryker.log'),
      runDir: path.join(outDir, 'run'),
      sidecarDir: path.join(outDir, 'sidecars'),
      sandboxDirs: [],
    },
    stryker: { exitCode: 0, wallClockMs: 10 },
    spanMap: { checked: 2, failures: [] },
    manifest: null,
    dryRun: {
      file: '/s/dry.json',
      status: 'survived',
      outcome: 'survived',
      reason: null,
      nrOfTests: tests.length,
      attempts: 1,
    },
    mutants: [normalised(M1, tests), normalised(M3, tests)],
    tests: [],
    flags: [],
    summary: {
      mutants: 2,
      byStatus: {
        Killed: 2,
        Survived: 0,
        NoCoverage: 0,
        CompileError: 0,
        RuntimeError: 0,
        Timeout: 0,
        Ignored: 0,
        Pending: 0,
      },
      byOutcome: {},
      mutantsWithSidecar: 2,
      mutantsWithOutcome: 2,
      testsWithKills: tests.length,
      testsWithAssertionKills: tests.length,
      zeroTestRuns: 0,
      flags: 0,
    },
  };
}

function fakeDeps(failingAlone: readonly string[] = []): {
  deps: GroupRunDeps;
  configs: StrykerConfigInput[];
  scopeCalls: RunScopeOptions[];
} {
  const configs: StrykerConfigInput[] = [];
  const scopeCalls: RunScopeOptions[] = [];
  let tests: readonly string[] = [];
  let clock = 0;
  const deps: GroupRunDeps = {
    runVitest: async (options: VitestRunOptions) => {
      tests = options.testIds;
      return vitestRun(options.testIds, failingAlone);
    },
    runScope: async (options) => {
      scopeCalls.push(options);
      return { results: strykerResults(options.outDir, tests), exitCode: 0 };
    },
    buildConfig: (input) => {
      configs.push(input);
      return buildStrykerConfig(input);
    },
    readJson: () => buildStrykerConfig({ ...configs[0], outDir: '/tmp/x' }),
    readDryRunManifest: (): RunManifest => ({
      schemaVersion: 1,
      project: 'mutation',
      vitestVersion: '5.0.5',
      files: [
        {
          file: 'test/unit/a.test.ts',
          tests: tests.map((test, index) => ({
            id: test,
            taskId: `t_${index}`,
            fullName: test.split('#')[1],
            location: { line: index + 1, column: 3 },
            notOracleValidated: false,
          })),
          skipped: [],
        },
      ],
    }),
    now: () => (clock += 1000),
  };
  return { deps, configs, scopeCalls };
}

const spec: IsolationRunSpec = {
  id: isolationRunId('alone', B),
  group: 'g1',
  kind: 'alone',
  lineage: B,
  tests: [B],
  testFiles: ['test/unit/a.test.ts'],
  universe: [M1, M2].sort(),
  mutate: mutateRangesOf([M1, M2]),
  pairs: [pairKey(A, B)],
};

describe('runIsolationRun', () => {
  const options = (workDir: string) => ({
    repoRoot: '/repo',
    workDir,
    shard: 0,
    manifest: manifestFor(),
    packageDir: path.join(workDir, 'prepared', 'gitnexus'),
    stryker: { concurrency: 3 },
  });

  it('runs the tests alone over the ranges, a fresh process per mutant', async () => {
    const workDir = tempDir();
    const { deps, configs, scopeCalls } = fakeDeps();
    await runIsolationRun(spec, options(workDir), deps);
    expect(JSON.parse(readFileSync(scopeCalls[0].scopeFile, 'utf8'))).toEqual({
      testFiles: ['test/unit/a.test.ts'],
      mutate: spec.mutate,
      testIds: [B],
    });
    expect([
      configs[0].maxTestRunnerReuse,
      configs[0].concurrency,
      scopeCalls[0].maxTestRunnerReuse,
    ]).toEqual([ISOLATION_TEST_RUNNER_REUSE, 3, 1]);
  });

  it('keeps the universe observations under the run lineage and lists the missing mutants', async () => {
    const workDir = tempDir();
    const { deps } = fakeDeps();
    const result = await runIsolationRun(spec, options(workDir), deps);
    expect([
      result.status,
      result.observations.map((entry) => [entry.kind, entry.lineage, entry.test, entry.mutant]),
      result.missing,
      result.outsideUniverse,
      result.wallClockMs,
    ]).toEqual(['complete', [['alone', B, B, M1]], [M2], 1, 1000]);
    expect([
      result.runUniverse?.tests,
      result.runUniverse?.mutants.map((entry) => entry.id),
    ]).toEqual([[B], [M1]]);
    expect(readIsolationRuns(workDir)).toEqual([result]);
  });

  it('writes the observations as rows of the run universe and rejects a schema 1 file', async () => {
    const workDir = tempDir();
    const { deps } = fakeDeps();
    const result = await runIsolationRun(spec, options(workDir), deps);
    const file = path.join(workDir, 'isolation', 'g1', `${spec.id}.json`);
    const written = JSON.parse(readFileSync(file, 'utf8')) as { observations: unknown[] };
    writeFileSync(file, JSON.stringify({ ...result, schemaVersion: 1 }));
    expect(written.observations).toEqual([[0, 0, 0, KILL, 'row', true, false, []]]);
    expect(() => readIsolationRun(file)).toThrow(/has schema 1, not 2: .*re-run its shard/);
  });

  it('stops before Stryker when the test fails alone unmutated, and writes the result', async () => {
    const workDir = tempDir();
    const { deps, scopeCalls } = fakeDeps([B]);
    const result = await runIsolationRun(spec, options(workDir), deps);
    expect([result.status, result.reason, result.observations, scopeCalls.length]).toEqual([
      'inconclusive',
      'baseline-failed',
      [],
      0,
    ]);
    expect(readIsolationRuns(workDir).map((entry) => entry.reason)).toEqual(['baseline-failed']);
  });
});
