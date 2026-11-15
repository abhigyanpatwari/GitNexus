/**
 * Locks gate 3's comparison rules (U7, KTD12, KTD13, KTD17, KTD18): freshness ("re-freeze
 * required"), the inventory check that blocks before outcomes are compared, per-mutant classes
 * and per-test outcomes under exactly the four KTD13 normalisations, and the gate's exit codes.
 * Every input is synthetic: a frozen manifest and the parsed views of a runner run.
 */
import { describe, expect, it } from 'vitest';
import {
  EXIT_DIFFERENCES,
  EXIT_PASS,
  EXIT_REFREEZE,
  EXIT_USAGE,
  checkFreshness,
  compareScope,
  gateExitCode,
  runnerPerTest,
  runnerTestClass,
  type CurrentState,
  type Freshness,
  type RunnerPerTest,
  type ScopeInput,
  type SidecarView,
} from '../../../tools/mutation/oracle/compare.js';
import {
  diffInventory,
  normaliseTestId,
  type CombinedStratum,
  type OracleManifest,
  type RunnerMutantView,
  type RunnerRunView,
} from '../../../tools/mutation/oracle/freeze.js';
import type { OracleClass } from '../../../tools/mutation/oracle/oracle-classify.js';

const FILE = 'test/unit/a.test.ts';
const T0 = `${FILE}#S > one`;
const T1 = `${FILE}#S > two (#2415)`;
const M0 = 'gitnexus/src/a.ts@0123456789abcdef:3:1-3:9:StringLiteral:aaaaaaaaaaaaaaaa';
const M1 = 'gitnexus/src/a.ts@0123456789abcdef:5:1-5:9:ConditionalExpression:bbbbbbbbbbbbbbbb';
const M2 = 'gitnexus/src/a.ts@0123456789abcdef:7:1-7:9:BlockStatement:cccccccccccccccc';

const manifest = (overrides: Partial<OracleManifest> = {}): OracleManifest => ({
  schemaVersion: 1,
  kind: 'gitnexus-mutation-oracle-manifest',
  name: 'a',
  description: 'synthetic',
  refreeze: 'npm run test:mutation:oracle:freeze -- --from-manifest a.json --seed <s> --work <w>',
  scope: { testFiles: [FILE], mutate: ['gitnexus/src/a.ts'] },
  versions: { stryker: '10.0.0', vitest: '5.0.5', nodeMajor: 22 },
  operators: { mutator: null, names: ['BlockStatement', 'ConditionalExpression', 'StringLiteral'] },
  inputs: {
    closure: { 'gitnexus/src/a.ts': 'h-src', [`gitnexus/${FILE}`]: 'h-test' },
    vitestConfig: { 'gitnexus/vitest.config.ts': 'h-config' },
    mutationConfig: { 'gitnexus/tools/mutation/vitest.mutation.config.ts': 'h-mutation' },
    prepareTool: { 'gitnexus/tools/mutation/prepare/prepare.ts': 'h-prepare' },
  },
  sample: { seed: 's', method: 'sha256', size: 100, topUpMin: 3, random: 2, topUps: [] },
  strata: [],
  baseline: { tests: 2, passedAlone: 2 },
  tests: [T0, T1],
  notOracleValidated: [],
  mutants: [
    [M0, 'killed-by-test:assertion'],
    [M1, 'survived'],
    [M2, 'survived'],
  ],
  sampled: [
    {
      id: M0,
      strata: ['multi-killer'],
      covering: 2,
      outcomes: [[1, 'killed-by-test:assertion']],
      invalid: [],
    },
    { id: M1, strata: ['survived'], covering: 1, outcomes: [], invalid: [] },
  ],
  launches: { total: 6, valid: 4, invalid: 0, wallClockLimitMs: 180000 },
  warnings: [],
  problems: [],
  ...overrides,
});

const runnerMutant = (
  globalId: string,
  outcome: OracleClass | null,
  status: string,
  overrides: Partial<RunnerMutantView> = {},
): RunnerMutantView => ({
  globalId,
  localId: globalId.slice(-1),
  status,
  outcome,
  outcomeSource: 'sidecar',
  sidecarFile: `/sidecars/${globalId.slice(-1)}.json`,
  ...overrides,
});

const runner = (mutants: RunnerMutantView[]): RunnerRunView => ({
  file: '/run/results.json',
  scope: { testFiles: [FILE], mutate: ['gitnexus/src/a.ts'] },
  runDir: '/run/run',
  preparedRoot: '/run/prepared',
  configFile: '/run/stryker.config.json',
  mutants,
  flags: [],
  spanMapFailures: 0,
});

const sidecar = (tests: [string, OracleClass][]): SidecarView => ({
  tests: tests.map(([id, outcome]) => ({ id, outcome })),
  outsideTest: [],
});

const FRESH: Freshness = { fresh: true, mismatches: [], refreeze: 'refreeze' };

const AGREEING_RUNNER = runner([
  runnerMutant(M0, 'killed-by-test:assertion', 'Killed'),
  runnerMutant(M1, 'survived', 'Survived'),
  runnerMutant(M2, 'survived', 'Survived'),
]);

const AGREEING_SIDECARS: Record<string, SidecarView> = {
  [M0]: sidecar([
    [T0, 'survived'],
    [T1, 'killed-by-test:assertion'],
  ]),
  [M1]: sidecar([[T0, 'survived']]),
};

const scopeInput = (overrides: Partial<ScopeInput> = {}): ScopeInput => ({
  manifest: manifest(),
  manifestFile: 'a.json',
  freshness: FRESH,
  staleness: [],
  runner: AGREEING_RUNNER,
  runnerTests: [T0, T1],
  perTest: (mutant): RunnerPerTest =>
    runnerPerTest(mutant, (file) => {
      const found = Object.entries(AGREEING_SIDECARS).find(([id]) =>
        file.endsWith(`${id.slice(-1)}.json`),
      );
      return found?.[1] ?? sidecar([]);
    }),
  ...overrides,
});

describe('test id normalisation (KTD13: title escaping, path separators)', () => {
  it.each([
    ['path separators', 'test\\unit\\a.test.ts#S > one', T0],
    ['an escaped regex metacharacter', `${FILE}#S > two \\(#2415\\)`, T1],
    ['an escaped quote', `${FILE}#it's \\"quoted\\"`, `${FILE}#it's "quoted"`],
    ['NFD title', `${FILE}#café`, `${FILE}#café`],
    ['an unchanged id', T0, T0],
  ])('normalises %s', (_label, raw, expected) => {
    expect(normaliseTestId(raw)).toBe(normaliseTestId(expected));
  });

  it('keeps distinct titles distinct', () => {
    expect(normaliseTestId(`${FILE}#a > b`)).not.toBe(normaliseTestId(`${FILE}#a > c`));
  });

  it('reports ids one inventory lacks and ids that collapse after normalisation', () => {
    expect(
      diffInventory([T0, T1, `${FILE}#x(`, `${FILE}#x\\(`], [T0, `${FILE}#y`], normaliseTestId),
    ).toEqual({
      onlyA: [T1, `${FILE}#x(`].sort(),
      onlyB: [`${FILE}#y`],
      ambiguousA: [`${FILE}#x\\(`],
      ambiguousB: [],
    });
  });
});

describe('gate 3 comparison', () => {
  it('passes a runner run that agrees with the manifest', () => {
    const report = compareScope(scopeInput());
    expect({
      result: report.result,
      classes: report.classes?.differences,
      perTest: [report.perTest?.compared, report.perTest?.agree, report.perTest?.differences],
    }).toEqual({ result: 'pass', classes: [], perTest: [4, 4, []] });
  });

  it('blocks before outcomes when a test of the oracle inventory is missing from the run manifest', () => {
    const report = compareScope(scopeInput({ runnerTests: [T0] }));
    expect({
      result: report.result,
      blocked: report.inventory?.blocked,
      onlyOracle: report.inventory?.tests.onlyA,
      classes: report.classes,
      perTest: report.perTest,
    }).toEqual({
      result: 'differences',
      blocked: true,
      onlyOracle: [T1],
      classes: null,
      perTest: null,
    });
  });

  it('blocks when a global mutant id of run A is missing from run B', () => {
    const report = compareScope(
      scopeInput({ runner: runner(AGREEING_RUNNER.mutants.filter((m) => m.globalId !== M2)) }),
    );
    expect([report.result, report.inventory?.mutants.onlyA, report.classes]).toEqual([
      'differences',
      [M2],
      null,
    ]);
  });

  it('blocks when run B has a global mutant id that run A lacks', () => {
    const extra = `${M2.slice(0, -1)}d`;
    const report = compareScope(
      scopeInput({
        runner: runner([...AGREEING_RUNNER.mutants, runnerMutant(extra, 'survived', 'Survived')]),
      }),
    );
    expect([report.inventory?.blocked, report.inventory?.mutants.onlyB]).toEqual([true, [extra]]);
  });

  it('accepts a runner Timeout against an oracle wall-clock kill as one class', () => {
    const timedOut = manifest({
      mutants: [
        [M0, 'timeout'],
        [M1, 'survived'],
        [M2, 'survived'],
      ],
      sampled: [{ id: M0, strata: [], covering: 2, outcomes: [[1, 'timeout']], invalid: [] }],
    });
    const hitLimit = runner([
      runnerMutant(M0, 'timeout', 'Timeout'),
      ...AGREEING_RUNNER.mutants.slice(1),
    ]);
    const report = compareScope(
      scopeInput({
        manifest: timedOut,
        runner: hitLimit,
        perTest: () => ({
          kind: 'record',
          sidecar: sidecar([
            [T0, 'survived'],
            [T1, 'timeout'],
          ]),
        }),
      }),
    );
    expect({
      result: report.result,
      normalised: report.classes?.normalised.map((row) => [row.globalId, row.rule]),
      perTest: report.perTest?.differences,
    }).toEqual({ result: 'pass', normalised: [[M0, 'timeout']], perTest: [] });
  });

  it("lists the per-test rows of a mutant Stryker's timer killed as unsupported", () => {
    const timedOut = manifest({
      mutants: [
        [M0, 'timeout'],
        [M1, 'survived'],
        [M2, 'survived'],
      ],
      sampled: [{ id: M0, strata: [], covering: 2, outcomes: [[1, 'timeout']], invalid: [] }],
    });
    const strykerTimer = runner([
      runnerMutant(M0, 'timeout', 'Timeout', {
        outcomeSource: 'stryker-timeout',
        sidecarFile: null,
      }),
      ...AGREEING_RUNNER.mutants.slice(1),
    ]);
    const report = compareScope(scopeInput({ manifest: timedOut, runner: strykerTimer }));
    expect([report.result, report.perTest?.unsupported, report.perTest?.compared]).toEqual([
      'pass',
      [{ globalId: M0, reason: "Stryker's timer killed the run; no record", observations: 2 }],
      0,
    ]);
  });

  it('accepts runner NoCoverage against oracle survived and keeps the raw status', () => {
    const noCoverage = runner([
      AGREEING_RUNNER.mutants[0],
      runnerMutant(M1, 'survived', 'NoCoverage', {
        outcomeSource: 'no-coverage',
        sidecarFile: null,
      }),
      AGREEING_RUNNER.mutants[2],
    ]);
    const report = compareScope(scopeInput({ runner: noCoverage }));
    expect({
      result: report.result,
      normalised: report.classes?.normalised,
      notRunAsSurvived: report.perTest?.notRunAsSurvived,
    }).toEqual({
      result: 'pass',
      normalised: [
        {
          globalId: M1,
          oracle: 'survived',
          runner: 'survived',
          runnerStatus: 'NoCoverage',
          runnerSource: 'no-coverage',
          rule: 'no-coverage',
        },
      ],
      notRunAsSurvived: 2,
    });
  });

  it('blocks a runner assertion kill against an oracle runtime kill, even with a recorded cause', () => {
    const runtime = manifest({
      mutants: [
        [M0, 'killed-by-test:runtime'],
        [M1, 'survived'],
        [M2, 'survived'],
      ],
      sampled: [
        { id: M0, strata: [], covering: 2, outcomes: [[1, 'killed-by-test:runtime']], invalid: [] },
      ],
      warnings: ['known cause: the mutant throws a TypeError inside expect()'],
    });
    const report = compareScope(scopeInput({ manifest: runtime }));
    expect({
      result: report.result,
      classes: report.classes?.differences.map((row) => [row.globalId, row.oracle, row.runner]),
      perTest: report.perTest?.differences.map((row) => [row.testId, row.oracle, row.runner]),
      exit: gateExitCode([report], []),
    }).toEqual({
      result: 'differences',
      classes: [[M0, 'killed-by-test:runtime', 'killed-by-test:assertion']],
      perTest: [[T1, 'killed-by-test:runtime', 'killed-by-test:assertion']],
      exit: EXIT_DIFFERENCES,
    });
  });

  it('blocks a runner run with flags', () => {
    const flagged = { ...AGREEING_RUNNER, flags: ['status-mismatch: Killed vs survived'] };
    expect(compareScope(scopeInput({ runner: flagged })).result).toBe('differences');
  });

  it('blocks a sampled mutant the runner left without a record', () => {
    const missing = runner([
      runnerMutant(M0, 'killed-by-test:assertion', 'Killed', { sidecarFile: null }),
      ...AGREEING_RUNNER.mutants.slice(1),
    ]);
    const report = compareScope(scopeInput({ runner: missing }));
    expect(report.perTest?.differences.map((row) => [row.testId, row.runnerSource])).toEqual([
      [T0, 'missing'],
      [T1, 'missing'],
    ]);
  });

  it('skips per-test outcomes of tests that are not oracle-validated', () => {
    const marked = manifest({ notOracleValidated: [T1] });
    const killedElsewhere: Record<string, SidecarView> = {
      [M0]: sidecar([[T1, 'killed-by-test:runtime']]),
    };
    const report = compareScope(
      scopeInput({
        manifest: marked,
        perTest: (mutant) => ({
          kind: 'record',
          sidecar: killedElsewhere[mutant.globalId] ?? sidecar([]),
        }),
      }),
    );
    expect([report.result, report.perTest?.compared, report.perTest?.notOracleValidated]).toEqual([
      'pass',
      2,
      2,
    ]);
  });
});

describe("the runner's per-test class", () => {
  const record: SidecarView = {
    tests: [{ id: `${FILE}#ran`, outcome: 'killed-by-test:hook' }],
    outsideTest: [
      {
        file: FILE,
        suiteTaskId: 'suite-1',
        outcome: 'killed-outside-test:hook',
        attributedTo: [`${FILE}#skipped by beforeAll`],
      },
      {
        file: 'test/unit/b.test.ts',
        suiteTaskId: null,
        outcome: 'killed-outside-test:collection',
        attributedTo: [],
      },
    ],
  };

  it.each([
    ['its row', `${FILE}#ran`, { outcome: 'killed-by-test:hook', source: 'row' }],
    [
      'an attributing beforeAll row',
      `${FILE}#skipped by beforeAll`,
      { outcome: 'killed-outside-test:hook', source: 'attributed' },
    ],
    [
      'a collection failure of its file',
      'test/unit/b.test.ts#anything',
      { outcome: 'killed-outside-test:collection', source: 'collection' },
    ],
    [
      'a test the runner did not run',
      `${FILE}#not run`,
      { outcome: 'survived', source: 'not-run' },
    ],
  ])('comes from %s', (_label, testId, expected) => {
    expect(runnerTestClass(record, testId)).toEqual(expected);
  });
});

describe('freshness (KTD12)', () => {
  const current = (overrides: Partial<CurrentState> = {}): CurrentState => ({
    inputs: manifest().inputs,
    versions: manifest().versions,
    mutator: null,
    ...overrides,
  });

  it('is fresh when hashes, versions and operators match', () => {
    expect(checkFreshness(manifest(), current())).toEqual({
      fresh: true,
      mismatches: [],
      refreeze: manifest().refreeze,
    });
  });

  it('requires a re-freeze when a closure hash or a version changed', () => {
    const changed = current({
      inputs: {
        ...manifest().inputs,
        closure: { ...manifest().inputs.closure, 'gitnexus/src/a.ts': 'h-new' },
      },
      versions: { ...manifest().versions, vitest: '5.0.6' },
    });
    const freshness = checkFreshness(manifest(), changed);
    const report = compareScope(scopeInput({ freshness }));
    expect({
      mismatches: freshness.mismatches.map((entry) => [entry.kind, entry.subject]),
      result: report.result,
      compared: [report.inventory, report.classes, report.perTest],
      exit: gateExitCode([report], []),
    }).toEqual({
      mismatches: [
        ['input', 'closure: gitnexus/src/a.ts'],
        ['version', 'vitest'],
      ],
      result: 'refreeze-required',
      compared: [null, null, null],
      exit: EXIT_REFREEZE,
    });
  });

  it('requires a re-freeze when a closure file appears or the operator set changes', () => {
    const changed = current({
      inputs: {
        ...manifest().inputs,
        closure: { ...manifest().inputs.closure, 'gitnexus/src/new.ts': 'h' },
      },
      mutator: { excludedMutations: ['StringLiteral'] },
    });
    expect(checkFreshness(manifest(), changed).mismatches.map((entry) => entry.kind)).toEqual([
      'input',
      'operators',
    ]);
  });
});

describe('gate exit codes', () => {
  const pass = compareScope(scopeInput());
  const stale = compareScope(scopeInput({ staleness: ['the runner run used Vitest 5.0.4'] }));
  const unmet: CombinedStratum = {
    name: 'no-coverage',
    population: 3,
    sampled: 0,
    status: 'unmet',
    scopes: [],
  };

  it.each([
    ['every scope passes', [pass], [], EXIT_PASS],
    ['a stale runner run', [pass, stale], [], EXIT_USAGE],
    ['an unmet stratum across the scopes', [pass], [unmet], EXIT_DIFFERENCES],
  ] as const)('%s', (_label, scopes, strata, expected) => {
    expect(gateExitCode(scopes, strata)).toBe(expected);
  });

  it('compares nothing for a stale runner run', () => {
    expect([stale.result, stale.inventory]).toEqual(['stale-runner-run', null]);
  });
});
