/**
 * Locks the scenario-map CLI (U14, R14, R16, KTD1, KTD17) without spawning Vitest or Stryker:
 * argument parsing and usage errors (exit 2), the controls stage refusing to run without a built
 * `dist/`, the merge stage over a small temp work directory whose second shard never reported
 * (the run is partial and that shard's pairs are Inconclusive) and whose group with an empty
 * mutate scope is never run (its pair is Out of scope), the final shard plan value-flow re-plans
 * and its fallback to plan.json's provisional plan (merge and the `shards` count follow it), and
 * the pure helpers behind the plan, shard and controls stages (the D9/D10 cost terms at a target
 * concurrency and speed factor, the shards needed, the value-flow view of the isolation
 * selection, the seeded group sample, the shard completeness check, the expected.json
 * comparison).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CandidatePair } from '../../../tools/scenario-map/path-coverage/candidates.js';
import type {
  CoverageTest,
  CoverageWorkFile,
} from '../../../tools/scenario-map/path-coverage/run-coverage.js';
import type { PlannedGroup } from '../../../tools/scenario-map/mutation/plan-shards.js';
import type { GroupObservations } from '../../../tools/scenario-map/mutation/run-group.js';
import type { RowDeletionPlan } from '../../../tools/scenario-map/mutation/row-deletion.js';
import type { ScenarioMapReport } from '../../../tools/scenario-map/report/report.js';
import type { Observation } from '../../../tools/scenario-map/mutation/observations.js';
import type { PairValueFlow } from '../../../tools/scenario-map/value-flow/pdg-walk.js';
import type { PairTrace } from '../../../tools/scenario-map/value-flow/trace.js';
import {
  SCENARIO_COST_MODEL,
  WORK_SCHEMA_VERSION,
  mutantRunScale,
  scenarioCostModel,
  valueFlowPasses,
  valueFlowView,
  batchGroups,
  batchScope,
  compareControls,
  effectiveShardPlan,
  estimateScenarioGroup,
  isolationOrder,
  parseCliArgs,
  planShards,
  replanShards,
  runCli,
  sampleGroups,
  shardIssues,
  splitBatchResult,
  UsageError,
  workLayout,
  type CliDeps,
  type Layer2File,
  type Layer2Test,
  type PlanFile,
  type ScenarioCostModel,
  type ShardReplan,
  type ShardStageReport,
  type ValueFlowFile,
} from '../../../tools/scenario-map/scenario-map.js';

const temps: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-u14-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout without `dist/` and a work directory outside it. */
function setup(): { deps: CliDeps; lines: string[]; root: string; work: string } {
  const base = tempDir();
  const root = path.join(base, 'repo');
  mkdirSync(path.join(root, 'gitnexus'), { recursive: true });
  const lines: string[] = [];
  return {
    root,
    work: path.join(base, 'work'),
    lines,
    deps: {
      repoRoot: root,
      packageDir: path.join(root, 'gitnexus'),
      cwd: base,
      log: (line) => lines.push(line),
      now: () => 0,
      sourceRevision: () => null,
    },
  };
}

describe('parseCliArgs', () => {
  it('gives the shard stage its index, count and work directory', () => {
    const options = parseCliArgs(['shard', '--index', '2', '--of', '8', '--work', 'dir'], '/base');
    expect([options.stage, options.index, options.of, options.workDir, options.sample]).toEqual([
      'shard',
      2,
      8,
      path.resolve('/base', 'dir'),
      null,
    ]);
  });

  it('takes the concurrency and speed factor of the estimate, and leaves the shard count open', () => {
    const plan = parseCliArgs(['plan', '--concurrency', '4', '--speed-factor', '1.5'], '/base');
    const shard = parseCliArgs(
      ['shard', '--index', '0', '--of', '1', '--concurrency', '3'],
      '/base',
    );
    expect([plan.concurrency, plan.speedFactor, plan.shards, shard.concurrency]).toEqual([
      4,
      1.5,
      null,
      3,
    ]);
  });

  it('takes the debug group selection of the shard stage', () => {
    const options = parseCliArgs(
      ['shard', '--index', '0', '--of', '1', '--sample', '12', '--groups', 'ga, gb'],
      '/base',
    );
    expect([options.sample, options.groups]).toEqual([12, ['ga', 'gb']]);
  });

  it('runs controls in controls mode over the U17 fixture with the report header flags', () => {
    const options = parseCliArgs(
      ['controls', '--work', 'w', '--run-id', '42', '--run-attempt', '2', '--default-branch'],
      '/base',
    );
    expect([options.mode, options.run]).toEqual([
      { kind: 'controls', fixtureRoot: 'gitnexus/test/fixtures/mutation-scenario-map' },
      { id: '42', attempt: 2, url: null, ref: null, defaultBranch: true },
    ]);
  });

  it.each([
    ['an index not below the shard count', ['shard', '--index', '9', '--of', '8'], /--index 9/],
    ['a shard without its index', ['shard', '--of', '8'], /--index <i> and --of <n>/],
    ['a negative index', ['shard', '--index', '-1', '--of', '8'], /index/],
    ['no stage', [], /no stage/],
    ['an unknown stage', ['frobnicate'], /unknown stage/],
    ['an unknown mode', ['plan', '--mode', 'weird'], /--mode/],
    ['a flag of another stage', ['plan', '--index', '1'], /does not apply to the plan stage/],
    ['an unknown flag', ['merge', '--bogus'], /bogus/],
    ['zero shards', ['plan', '--shards', '0'], /--shards/],
    ['a non-numeric attempt', ['merge', '--run-attempt', 'x'], /--run-attempt/],
    ['contradicting modes', ['all', '--controls', '--mode', 'normal'], /contradicts/],
    [
      'a repeated debug group',
      ['shard', '--index', '0', '--of', '1', '--groups', 'g1,g1'],
      /--groups/,
    ],
    ['a zero speed factor', ['plan', '--speed-factor', '0'], /--speed-factor/],
    ['a speed factor that is no number', ['plan', '--speed-factor', 'fast'], /--speed-factor/],
    [
      'a zero concurrency',
      ['shard', '--index', '0', '--of', '1', '--concurrency', '0'],
      /--concurrency/,
    ],
    [
      'a concurrency on merge',
      ['merge', '--concurrency', '4'],
      /does not apply to the merge stage/,
    ],
  ])('rejects %s', (_title, argv, message) => {
    expect(() => parseCliArgs(argv, '/base')).toThrow(UsageError);
    expect(() => parseCliArgs(argv, '/base')).toThrow(message);
  });
});

describe('runCli usage', () => {
  it('exits 2 with the usage text for --index 9 --of 8', async () => {
    const { deps, lines, work } = setup();
    const code = await runCli(['shard', '--index', '9', '--of', '8', '--work', work], deps);
    expect([code, lines[0], lines.some((line) => line.startsWith('usage:'))]).toEqual([
      2,
      'scenario-map: --index 9 is not below --of 8',
      true,
    ]);
  });

  it('exits 2 for a work directory inside the checkout', async () => {
    const { deps, lines, root } = setup();
    const code = await runCli(['plan', '--work', path.join(root, 'work')], deps);
    expect([code, lines[0]]).toEqual([2, expect.stringMatching(/must lie outside the checkout/)]);
  });

  it('exits 2 for controls without a built dist/, naming the build step, before any stage runs', async () => {
    const { deps, lines, work } = setup();
    const code = await runCli(['controls', '--work', work], deps);
    expect([code, lines[0], existsSync(work)]).toEqual([
      2,
      expect.stringContaining('node scripts/build.js'),
      false,
    ]);
  });
});

// ── Merge over a temp work directory ───────────────────────────────────────

const A1 = 'test/unit/a.test.ts#A > one';
const A2 = 'test/unit/a.test.ts#A > two';
const B1 = 'test/unit/b.test.ts#B > one';
const B2 = 'test/unit/b.test.ts#B > two';
const C1 = 'test/unit/c.test.ts#C > one';
const C2 = 'test/unit/c.test.ts#C > two';
const DIGEST = 'd'.repeat(64);

const coverageTest = (id: string, line: number): CoverageTest => ({
  id,
  taskId: `task-${line}`,
  file: id.split('#')[0],
  fullName: id.split('#')[1],
  location: { line, column: 3 },
  state: 'passed',
  concurrent: false,
  attempts: 2,
  blocks: [0],
  suiteBlocks: [],
  provenance: {
    known: true,
    executedFiles: ['gitnexus/src/a.ts'],
    nativeEntries: [],
    workerSpawns: [],
    excludedCandidates: [],
  },
});

const layer2Test = (id: string): Layer2Test => ({
  id,
  file: id.split('#')[0],
  anchor: null,
  notOracleValidated: false,
  dupeOk: null,
  joinProblems: [],
  inventoryUnresolved: [],
  checksContext: 'c1',
  unsupportedForms: [],
  unresolvedSelectors: [],
  facet: null,
});

const plannedGroup = (id: string, tests: string[]): PlannedGroup => ({
  id,
  tests,
  testFiles: [tests[0].split('#')[0]],
  pairs: 1,
  mutate: ['gitnexus/src/a.ts'],
  excluded: [],
  closureIncomplete: [],
  provenanceUnknown: [],
  mutatedBytes: 100,
  estimateMs: 1000,
});

const candidatePair = (a: string, b: string, group: string): CandidatePair => ({
  a,
  b,
  sources: ['jaccard'],
  jaccard: 1,
  identicalBlocks: true,
  pathUnattributable: false,
  group,
});

const GROUPS: PlannedGroup[] = [
  plannedGroup('ga', [A1, A2]),
  plannedGroup('gb', [B1, B2]),
  { ...plannedGroup('gc', [C1, C2]), mutate: [], mutatedBytes: 0, estimateMs: 0 },
];

/** Two shards (ga, gb) provisionally; gc executes no production file (in no shard). */
function basePlan(): PlanFile {
  const groups = GROUPS;
  return {
    schemaVersion: WORK_SCHEMA_VERSION,
    mode: { kind: 'normal' },
    seed: 's1',
    eligibility: {
      mode: 'normal',
      files: ['test/unit/a.test.ts', 'test/unit/b.test.ts', 'test/unit/c.test.ts'],
      delta: { notValidated: [], rejected: [] },
      extraRoots: [],
    },
    manifestDigest: DIGEST,
    costModel: { ...SCENARIO_COST_MODEL },
    shardPlan: {
      schemaVersion: 1,
      budgetMs: 300 * 60_000,
      costModel: { ...SCENARIO_COST_MODEL },
      groups,
      shards: [
        { index: 0, groups: ['ga'], estimateMs: 1000 },
        { index: 1, groups: ['gb'], estimateMs: 1000 },
      ],
      overBudget: [],
    },
    shardsRequested: null,
    shardsNeeded: 2,
    shardsCapped: false,
    estimates: [],
    isolationCandidates: [],
    pairs: [candidatePair(A1, A2, 'ga'), candidatePair(B1, B2, 'gb'), candidatePair(C1, C2, 'gc')],
    rowDeletion: [],
    stats: { tests: 6, groups: 3, pairs: 3, facetEqualPairs: 0, wallClockMs: {} },
  };
}

/** A value-flow re-plan that packs ga and gb into one shard. */
const ONE_SHARD_REPLAN: ShardReplan = {
  shardPlan: {
    schemaVersion: 1,
    budgetMs: 300 * 60_000,
    costModel: { ...SCENARIO_COST_MODEL },
    groups: GROUPS,
    shards: [{ index: 0, groups: ['ga', 'gb'], estimateMs: 2000 }],
    overBudget: [],
  },
  estimates: [],
  shardsNeeded: 1,
  shardsCapped: false,
  isolationCandidates: [],
};

/**
 * Writes plan, Layer 1/2, value flow (with `replan`) and shard 0's results; shard 1 never
 * reported, and group gc executes no production file (empty mutate scope: in no shard, never run).
 */
function writeTwoShardRun(work: string, replan: ShardReplan | null = null): void {
  const layout = workLayout(work);
  const tests = [A1, A2, B1, B2, C1, C2];
  const groups = GROUPS;
  const write = (file: string, value: unknown): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  const plan = basePlan();
  const coverage: CoverageWorkFile = {
    schemaVersion: 1,
    mode: 'normal',
    extraRoots: [],
    repeats: 1,
    blocks: ['gitnexus/src/a.ts#f@0'],
    files: [],
    tests: tests.map((id, i) => coverageTest(id, i + 1)),
    unhandledErrors: [],
  };
  const layer2: Layer2File = { schemaVersion: WORK_SCHEMA_VERSION, tests: tests.map(layer2Test) };
  const shard0: ShardStageReport = {
    schemaVersion: WORK_SCHEMA_VERSION,
    shard: 0,
    of: 2,
    manifestDigest: DIGEST,
    manifestCheck: { ok: true, mismatches: [] },
    deadlineMs: 300 * 60_000,
    concurrency: 2,
    valueFlow: 'used',
    batches: [],
    sample: null,
    groups: {
      ran: [
        {
          group: 'ga',
          batch: null,
          status: 'inconclusive',
          reason: 'baseline-failed',
          wallClockMs: 10,
          mainEstimateMs: 1000,
          estimateMs: 1000,
          mutants: null,
          evaluated: null,
        },
      ],
      notStarted: [],
      sampledOut: [],
    },
    rowDeletion: { status: 'none', pairs: 0, planned: 0, runs: 0, estimateMs: 0, wallClockMs: 0 },
    isolation: { candidates: 0, selected: 0, runs: [], skipped: [], deferred: [] },
    finished: true,
    wallClockMs: 20,
  };
  const groupResult: GroupObservations = {
    schemaVersion: 1,
    group: 'ga',
    shard: 0,
    manifestDigest: DIGEST,
    status: 'inconclusive',
    reason: 'baseline-failed',
    detail: 'baseline 1: A > two failed',
    tests: [A1, A2],
    scope: groups[0],
    baselines: [],
    stryker: null,
    observations: [],
    wallClockMs: 10,
  };
  const valueFlow: ValueFlowFile = {
    schemaVersion: WORK_SCHEMA_VERSION,
    manifestDigest: DIGEST,
    pairs: { facetEqual: 0, valueDiffering: 0 },
    pdg: { status: 'skipped', detail: null, indexPrefix: '', wallClockMs: 0 },
    staticValueFlow: {
      degraded: [],
      checker: { version: null, tsconfig: null, error: null },
      pdgLayer: 'unknown',
      pairs: [],
    },
    trace: {
      status: 'not-run',
      detail: 'no pairs',
      wrap: { added: [], skipped: [], unavailable: [], errors: [] },
      baseline: null,
      traced: null,
      overhead: null,
      tests: [],
      pairs: [],
      wallClockMs: 0,
    },
    replan,
    wallClockMs: {},
  };
  write(layout.plan, plan);
  write(layout.coverage, coverage);
  write(layout.layer2, layer2);
  write(layout.shardReport(0), shard0);
  write(path.join(work, 'observations', 'ga.json'), groupResult);
  write(layout.valueFlow, valueFlow);
}

describe('merge stage', () => {
  it('marks a run with a missing shard partial, its pairs Inconclusive, and a not-run empty scope Out of scope', async () => {
    const { deps, work } = setup();
    writeTwoShardRun(work);
    const code = await runCli(['merge', '--work', work, '--run-id', '7'], deps);
    const report = JSON.parse(
      readFileSync(workLayout(work).reportJson, 'utf8'),
    ) as ScenarioMapReport;
    expect({
      code,
      partial: report.completeness.partial,
      shards: report.completeness.shards,
      pairs: report.pairs.map((pair) => [pair.a, pair.verdict, pair.rule]),
      written: [workLayout(work).reportMarkdown, workLayout(work).issueBody].map(existsSync),
    }).toEqual({
      code: 1,
      partial: true,
      shards: { planned: 2, complete: 1, incomplete: [{ shard: '1', reason: 'no shard result' }] },
      pairs: [
        [A1, 'inconclusive', 'baseline-failed'],
        [B1, 'inconclusive', 'not-scheduled'],
        [C1, 'out-of-scope', 'covers-no-evaluated-mutant'],
      ],
      written: [true, true],
    });
  });

  it('follows the value-flow re-plan instead of the provisional plan', async () => {
    const { deps, work } = setup();
    writeTwoShardRun(work, ONE_SHARD_REPLAN);
    const code = await runCli(['merge', '--work', work], deps);
    const report = JSON.parse(
      readFileSync(workLayout(work).reportJson, 'utf8'),
    ) as ScenarioMapReport;
    expect([code, report.completeness.shards]).toEqual([
      0,
      { planned: 1, complete: 1, incomplete: [] },
    ]);
  });
});

describe('shards stage', () => {
  it.each([
    ['the provisional plan without a re-plan', null, '2'],
    ['the value-flow re-plan', ONE_SHARD_REPLAN, '1'],
  ])('prints the shard count of %s', async (_title, replan, count) => {
    const { deps, lines, work } = setup();
    writeTwoShardRun(work, replan);
    const code = await runCli(['shards', '--work', work], deps);
    expect([code, lines]).toEqual([0, [count]]);
  });
});

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('estimateScenarioGroup', () => {
  it('adds the D10 row-deletion runs and the D9 fixed isolation runs to the main run', () => {
    const model = {
      ...SCENARIO_COST_MODEL,
      perRunMs: 1000,
      perByteMs: 1,
      mutantsPerByte: 0.5,
      freshProcessMs: 10,
      isolationRunMs: 100,
      rowDeletionRunMs: 7,
    };
    const estimate = estimateScenarioGroup(
      {
        group: 'g',
        tests: 3,
        mutatedBytes: 100,
        isolationPairs: 1,
        isolationRuns: 3,
        isolationBytes: 40,
        rowDeletionPairs: 1,
        rowDeletionRuns: 3,
      },
      model,
    );
    // main 1000 + 100 bytes * 1; row deletion 3 * 7; isolation 3 * 100 + 40 * 0.5 * 3 runs * 10.
    expect([
      estimate.mainMs,
      estimate.rowDeletionMs,
      estimate.isolationMs,
      estimate.estimateMs,
    ]).toEqual([1100, 21, 900, 2021]);
  });

  it.each([[2], [36]])(
    'estimates the main run of %i tests over the same bytes the same (no test factor)',
    (tests) => {
      const work = {
        group: 'g',
        tests,
        mutatedBytes: 100_000,
        isolationPairs: 0,
        isolationRuns: 0,
        isolationBytes: 0,
        rowDeletionPairs: 0,
        rowDeletionRuns: 0,
      };
      // The U14 slice: 88 s + 100,000 bytes * 0.78 ms at concurrency 2 on the calibration machine.
      expect(estimateScenarioGroup(work, SCENARIO_COST_MODEL).mainMs).toBe(166_000);
    },
  );
});

describe('cost model at a target concurrency and speed factor', () => {
  it.each([
    [2, 1],
    [4, 1 / 1.8],
    [1, 2],
  ])('scales the mutant runs at concurrency %i by %f', (concurrency, scale) => {
    const model = {
      ...scenarioCostModel({ concurrency, speedFactor: 1 }),
      parallelEfficiency: 0.8,
    };
    expect(mutantRunScale(model)).toBeCloseTo(scale, 10);
  });

  it('multiplies every term by the speed factor and only the mutant runs by the scale', () => {
    const model = {
      ...scenarioCostModel({ concurrency: 4, speedFactor: 2 }),
      parallelEfficiency: 1,
      perRunMs: 1000,
      perByteMs: 1,
      mutantsPerByte: 0.5,
      freshProcessMs: 10,
      isolationRunMs: 100,
      rowDeletionRunMs: 7,
    };
    const estimate = estimateScenarioGroup(
      {
        group: 'g',
        tests: 3,
        mutatedBytes: 100,
        isolationPairs: 1,
        isolationRuns: 3,
        isolationBytes: 40,
        rowDeletionPairs: 1,
        rowDeletionRuns: 3,
      },
      model,
    );
    // Concurrency 4 halves the mutant runs (efficiency 1): main 2 * (1000 + 100 / 2), row
    // deletion 2 * 21, isolation 2 * (300 + 600 / 2).
    expect([estimate.mainMs, estimate.rowDeletionMs, estimate.isolationMs]).toEqual([
      2100, 42, 1200,
    ]);
  });
});

describe('planShards', () => {
  const rowPlan = (a: string, b: string, deletions: number): RowDeletionPlan => ({
    a,
    b,
    status: deletions > 0 ? 'planned' : 'not-applicable',
    reasons: [],
    positions: [],
    deletions: Array.from({ length: deletions }, (_, i) => ({
      globalId: `gitnexus/src/a.ts@0123456789abcdef:${i + 1}:1-${i + 1}:5:RowDeletion:aaaaaaaaaaaaaaaa`,
      identity: {
        file: 'gitnexus/src/a.ts',
        fileHash: '0123456789abcdef',
        location: { start: { line: i + 1, column: 1 }, end: { line: i + 1, column: 5 } },
        mutatorName: 'RowDeletion',
        replacement: '',
      },
      key: `s:k${i}`,
      table: { file: 'gitnexus/src/a.ts', kind: 'object', binding: 'T', line: 1 },
      splice: { start: 0, end: 1 },
    })),
  });

  it('counts isolation only for potential repeat pairs and row deletion only for planned ones', () => {
    const scope = plannedGroup('ga', [A1, A2, B1]);
    const { shardPlan, estimates } = planShards({
      scopes: [{ ...scope, mutate: ['gitnexus/src/a.ts', 'gitnexus/src/b.ts'] }],
      pairs: [candidatePair(A1, A2, 'ga'), candidatePair(A1, B1, 'ga')],
      potentialRepeat: (pair) => pair.b === A2,
      executedFiles: () => ['gitnexus/src/a.ts', 'node_modules/x/index.js'],
      rowDeletion: [rowPlan(A1, A2, 2), rowPlan(A1, B1, 0)],
      sizeOf: (file) => (file.endsWith('a.ts') ? 10 : 30),
      shards: 1,
      budgetMs: 300 * 60_000,
      model: SCENARIO_COST_MODEL,
    });
    expect({
      work: estimates.map((entry) => [
        entry.mutatedBytes,
        entry.isolationPairs,
        entry.isolationRuns,
        entry.isolationBytes,
        entry.rowDeletionPairs,
        entry.rowDeletionRuns,
      ]),
      planned: shardPlan.groups.map((group) => group.estimateMs),
      shards: shardPlan.shards.map((shard) => shard.groups),
    }).toEqual({
      work: [[40, 1, 3, 10, 1, 3]],
      planned: [estimates[0].estimateMs],
      shards: [['ga']],
    });
  });

  it('packs into the shards needed, never packs an empty mutate scope, and caps the count', () => {
    const big = (id: string): PlannedGroup => ({
      ...plannedGroup(id, [`${id}#x`, `${id}#y`]),
      pairs: 0,
    });
    const input = {
      scopes: [big('g1'), big('g2'), big('g3'), { ...big('g4'), mutate: [] }],
      pairs: [],
      potentialRepeat: () => false,
      executedFiles: () => null,
      rowDeletion: [],
      // 100 s + 50,000 bytes * 2 ms = 200 s per group; the reserve is 60 + 48 s.
      sizeOf: () => 50_000,
      budgetMs: 350_000,
      model: {
        ...scenarioCostModel({ concurrency: 2, speedFactor: 1 }),
        perRunMs: 100_000,
        perByteMs: 2,
      },
    };
    const needed = planShards({ ...input, shards: null });
    const capped = planShards({ ...input, shards: null, maxShards: 2 });
    const forced = planShards({ ...input, shards: 1 });
    expect({
      needed: [
        needed.shardsNeeded,
        needed.shardsCapped,
        needed.shardPlan.shards.map((s) => s.groups),
      ],
      empty: needed.estimates.find((entry) => entry.group === 'g4')?.estimateMs,
      capped: [capped.shardsNeeded, capped.shardsCapped],
      forced: forced.shardPlan.shards.map((shard) => shard.groups),
    }).toEqual({
      needed: [3, false, [['g1'], ['g2'], ['g3']]],
      empty: 0,
      capped: [2, true],
      forced: [['g1', 'g2', 'g3']],
    });
  });

  it('runs a group whose isolation is over budget, with that isolation deferred, and drops only a main run over budget', () => {
    const MIN = 60_000;
    // ga: a 2 min main run and 3 isolation runs of 200 min; gb: a 2 + 400 min main run.
    const sizes = new Map([['gitnexus/src/b.ts', 400 * MIN]]);
    const { shardPlan, estimates } = planShards({
      scopes: [
        plannedGroup('ga', [A1, A2]),
        { ...plannedGroup('gb', [B1, B2]), mutate: ['gitnexus/src/b.ts'] },
      ],
      pairs: [candidatePair(A1, A2, 'ga'), candidatePair(B1, B2, 'gb')],
      potentialRepeat: (pair) => pair.group === 'ga',
      executedFiles: () => ['gitnexus/src/a.ts'],
      rowDeletion: [],
      sizeOf: (file) => sizes.get(file) ?? 0,
      shards: null,
      budgetMs: 300 * MIN,
      model: {
        ...scenarioCostModel({ concurrency: 2, speedFactor: 1 }),
        perRunMs: 2 * MIN,
        perByteMs: 1,
        isolationRunMs: 200 * MIN,
      },
    });
    expect({
      overBudget: shardPlan.overBudget,
      shards: shardPlan.shards.map((shard) => shard.groups),
      ga: estimates
        .filter((entry) => entry.group === 'ga')
        .map((entry) => [entry.isolationPlanned, entry.estimateMs / MIN, entry.isolationMs / MIN]),
    }).toEqual({
      overBudget: ['gb'],
      shards: [['ga']],
      ga: [[false, 2, 600]],
    });
  });
});

describe('isolationOrder', () => {
  it('puts the pairs of groups with planned isolation before those whose isolation was deferred', () => {
    const order = isolationOrder(
      [{ group: 'g1' }, { group: 'g2' }, { group: 'g3' }, { group: 'g2' }],
      (group) => group === 'g2',
    );
    expect(order.map((entry) => [entry.decision.group, entry.planned])).toEqual([
      ['g2', true],
      ['g2', true],
      ['g1', false],
      ['g3', false],
    ]);
  });
});

describe('value flow before isolation', () => {
  const KEY = JSON.stringify([A1, A2]);
  const flow = (status: PairValueFlow['status']): PairValueFlow => ({
    a: A1,
    b: A2,
    status,
    reasons: [],
    entries: [],
    sinks: [],
    opaqueSinks: [],
    degraded: [],
  });
  const trace = (status: PairTrace['status']): PairTrace => ({
    a: A1,
    b: A2,
    status,
    reasons: [],
    sharedSites: 0,
    differences: [],
  });
  const file = (
    staticPairs: PairValueFlow[],
    tracePairs: PairTrace[],
    overrides: Partial<{
      digest: string;
      degraded: boolean;
      traced: boolean;
      replan: ShardReplan;
    }> = {},
  ): ValueFlowFile => ({
    schemaVersion: WORK_SCHEMA_VERSION,
    manifestDigest: overrides.digest ?? DIGEST,
    pairs: { facetEqual: 1, valueDiffering: staticPairs.length },
    pdg: { status: 'indexed', detail: null, indexPrefix: '', wallClockMs: 0 },
    staticValueFlow: {
      degraded: overrides.degraded === true ? ['no-pdg-layer'] : [],
      checker: { version: '7.0.2', tsconfig: null, error: null },
      pdgLayer: 'ready',
      pairs: staticPairs,
    },
    trace: {
      status: overrides.traced === false ? 'not-run' : 'ran',
      detail: null,
      wrap: { added: [], skipped: [], unavailable: [], errors: [] },
      baseline: null,
      traced: null,
      overhead: null,
      tests: [],
      pairs: tracePairs,
      wallClockMs: 0,
    },
    replan: overrides.replan ?? null,
    wallClockMs: {},
  });

  it.each([
    ['no value-flow result', 'missing', null],
    ['another run manifest', 'stale', file([], [], { digest: 'e'.repeat(64) })],
    ['a degraded static run', 'degraded', file([], [], { degraded: true })],
    ['a trace that did not run', 'trace-not-run', file([], [], { traced: false })],
    ['a usable result', 'used', file([], [])],
  ])('reads %s as %s', (_title, use, result) => {
    expect(valueFlowView(result, DIGEST).use).toBe(use);
  });

  it.each([
    ['a clean trace without a static check (equal discarded values)', true, [], [trace('clean')]],
    ['a clean trace and a clean static check', true, [flow('clean')], [trace('clean')]],
    ['a trace veto', false, [flow('clean')], [trace('veto')]],
    ['an inconclusive trace', false, [], [trace('inconclusive')]],
    ['a static veto', false, [flow('veto')], [trace('clean')]],
    ['an unknown static check', false, [flow('unknown')], [trace('clean')]],
    ['no trace for the pair', false, [flow('clean')], []],
  ])('lets %s reach isolation: %s', (_title, passes, staticPairs, tracePairs) => {
    expect(valueFlowPasses(valueFlowView(file(staticPairs, tracePairs), DIGEST), KEY)).toBe(passes);
  });

  it('isolates as without value flow when the result cannot be used', () => {
    expect(valueFlowPasses(valueFlowView(null, DIGEST), KEY)).toBe(true);
  });

  it.each([
    ['no value-flow result', 'provisional', 2, null],
    [
      'another run manifest',
      'provisional',
      2,
      file([], [], { digest: 'e'.repeat(64), replan: ONE_SHARD_REPLAN }),
    ],
    [
      'a degraded static run',
      'provisional',
      2,
      file([], [], { degraded: true, replan: ONE_SHARD_REPLAN }),
    ],
    [
      'a trace that did not run',
      'provisional',
      2,
      file([], [], { traced: false, replan: ONE_SHARD_REPLAN }),
    ],
    ['a usable result without a re-plan', 'provisional', 2, file([], [])],
    ['a usable result with a re-plan', 'value-flow', 1, file([], [], { replan: ONE_SHARD_REPLAN })],
  ])('given %s, follows the %s shard plan of %i shards', (_title, source, shards, result) => {
    const effective = effectiveShardPlan(basePlan(), result);
    expect([effective.source, effective.shardPlan.shards.length]).toEqual([source, shards]);
  });

  // A candidate whose three isolation runs alone take 600 min has its isolation deferred (the
  // group still runs) until value flow vetoes it; every group's main run is about 90 s.
  const isolationHeavy = (): PlanFile => ({
    ...basePlan(),
    costModel: {
      ...scenarioCostModel({ concurrency: 2, speedFactor: 1 }),
      isolationRunMs: 200 * 60_000,
    },
    isolationCandidates: [KEY],
  });

  const replanCases: [string, PairTrace['status'], string[], boolean][] = [
    ['a trace veto', 'veto', [], true],
    ['a clean trace', 'clean', [KEY], false],
  ];
  it.each(replanCases)('replans after %s', (_title, status, candidates, planned) => {
    const replan = replanShards(
      isolationHeavy(),
      valueFlowView(file([], [trace(status)]), DIGEST),
      { executedFiles: () => ['gitnexus/src/a.ts'], sizeOf: () => 100 },
    );
    expect([
      replan.shardPlan.overBudget,
      replan.isolationCandidates,
      replan.estimates.find((entry) => entry.group === 'ga')?.isolationPlanned,
      replan.shardsNeeded,
      replan.shardPlan.shards.map((shard) => shard.groups),
    ]).toEqual([[], candidates, planned, 1, [['ga', 'gb']]]);
  });
});

describe('batchGroups', () => {
  const MIN = 60_000;

  const model = (batchFactor: number): ScenarioCostModel => ({
    ...scenarioCostModel({ concurrency: 2, speedFactor: 1 }),
    perRunMs: MIN,
    batchFactor,
  });

  it('shares one run while the fixed cost once plus the members\u2019 extra stays in budget', () => {
    const batches = batchGroups(
      [
        { id: 'g1', mainMs: 2 * MIN, mutate: 1 },
        { id: 'g2', mainMs: 12 * MIN, mutate: 3 },
        { id: 'g3', mainMs: 2 * MIN, mutate: 0 },
        { id: 'g4', mainMs: 8 * MIN, mutate: 2 },
        { id: 'g5', mainMs: 40 * MIN, mutate: 9 },
        { id: 'g6', mainMs: 3 * MIN, mutate: 1 },
      ],
      model(1),
      20 * MIN,
    );
    // g1, g2, g4: the 1 min fixed cost once plus 1 + 11 + 7 = 20; g3 has no mutate scope; g5 is over.
    expect(batches.map((batch) => [batch.groups, batch.mainMs / MIN])).toEqual([
      [['g1', 'g2', 'g4'], 20],
      [['g3'], 2],
      [['g5'], 40],
      [['g6'], 3],
    ]);
  });

  it('names a batch of several groups apart from every group id, and a single group by its id', () => {
    const [batch, single] = batchGroups(
      [
        { id: 'g1', mainMs: 2 * MIN, mutate: 1 },
        { id: 'g2', mainMs: 2 * MIN, mutate: 1 },
        { id: 'g9', mainMs: 99 * MIN, mutate: 1 },
      ],
      model(1),
      20 * MIN,
    );
    expect([batch.id, single.id]).toEqual([expect.stringMatching(/^b[0-9a-f]{16}$/), 'g9']);
  });

  it('prices a batch at the batch factor over one fixed cost plus the members\u2019 extra', () => {
    const batches = batchGroups(
      [
        { id: 'g1', mainMs: 2 * MIN, mutate: 1 },
        { id: 'g2', mainMs: 12 * MIN, mutate: 3 },
        { id: 'g4', mainMs: 8 * MIN, mutate: 2 },
      ],
      model(1.5),
      20 * MIN,
    );
    // g1 + g2: 1.5 * (1 + 1 + 11) = 19.5; adding g4 makes 1.5 * 20 = 30.
    expect(batches.map((batch) => [batch.groups, batch.mainMs / MIN])).toEqual([
      [['g1', 'g2'], 19.5],
      [['g4'], 8],
    ]);
  });
});

describe('splitBatchResult', () => {
  const observation = (test: string, file: string): Observation => ({
    group: 'bbatch',
    kind: 'main',
    lineage: 'main',
    shard: 0,
    attempt: 0,
    test,
    mutant: `${file}@0123456789abcdef:1:1-1:2:BooleanLiteral:aaaaaaaaaaaaaaaa`,
    file,
    covered: true,
    hookAttributed: false,
    static: false,
    outcome: 'killed-by-test:assertion',
    source: 'row',
    valid: true,
    reasons: [],
  });

  it('keeps each member\u2019s own tests on its own mutate files, relabelled with its group', () => {
    const ga = { ...plannedGroup('ga', [A1, A2]), mutate: ['gitnexus/src/a.ts'] };
    const gb = { ...plannedGroup('gb', [B1, B2]), mutate: ['gitnexus/src/b.ts'] };
    const scope = batchScope('bbatch', [ga, gb]);
    const result: GroupObservations = {
      schemaVersion: 1,
      group: 'bbatch',
      shard: 0,
      manifestDigest: DIGEST,
      status: 'complete',
      reason: null,
      detail: null,
      tests: scope.tests,
      scope,
      baselines: [],
      stryker: null,
      observations: [
        observation(A1, 'gitnexus/src/a.ts'),
        observation(A1, 'gitnexus/src/b.ts'),
        observation(B2, 'gitnexus/src/b.ts'),
        observation(B2, 'gitnexus/src/a.ts'),
      ],
      wallClockMs: 5,
    };
    const split = splitBatchResult(result, [ga, gb]);
    expect({
      scope: [scope.tests, scope.mutate, scope.pairs],
      members: split.map((member) => [
        member.group,
        member.tests,
        member.scope.mutate,
        member.observations.map((entry) => [entry.group, entry.test, entry.file]),
        member.batch,
      ]),
    }).toEqual({
      scope: [[A1, A2, B1, B2], ['gitnexus/src/a.ts', 'gitnexus/src/b.ts'], 2],
      members: [
        [
          'ga',
          [A1, A2],
          ['gitnexus/src/a.ts'],
          [['ga', A1, 'gitnexus/src/a.ts']],
          { id: 'bbatch', groups: ['ga', 'gb'] },
        ],
        [
          'gb',
          [B1, B2],
          ['gitnexus/src/b.ts'],
          [['gb', B2, 'gitnexus/src/b.ts']],
          { id: 'bbatch', groups: ['ga', 'gb'] },
        ],
      ],
    });
  });
});

describe('sampleGroups', () => {
  const ids = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];

  it('picks the same groups for the same seed, in plan order', () => {
    const picked = sampleGroups(ids, 3, 'seed-a');
    expect([picked.length, picked, [...picked].sort()]).toEqual([
      3,
      sampleGroups([...ids].reverse(), 3, 'seed-a').reverse(),
      picked,
    ]);
  });

  it('takes every group when the sample is larger than the shard', () => {
    expect(sampleGroups(ids, 10, 'seed-a')).toEqual(ids);
  });
});

describe('shardIssues', () => {
  const finished: ShardStageReport = {
    schemaVersion: WORK_SCHEMA_VERSION,
    shard: 0,
    of: 1,
    manifestDigest: DIGEST,
    manifestCheck: { ok: true, mismatches: [] },
    deadlineMs: 1,
    concurrency: 2,
    valueFlow: 'used',
    batches: [],
    sample: null,
    groups: { ran: [], notStarted: [], sampledOut: [] },
    rowDeletion: { status: 'none', pairs: 0, planned: 0, runs: 0, estimateMs: 0, wallClockMs: 0 },
    isolation: { candidates: 0, selected: 0, runs: [], skipped: [], deferred: [] },
    finished: true,
    wallClockMs: 1,
  };

  it.each([
    ['a finished shard', finished, []],
    ['no report', null, ['no shard result']],
    [
      'a manifest mismatch',
      { ...finished, manifestCheck: { ok: false, mismatches: ['changed: gitnexus/x.ts'] } },
      ['its prepared copy differs from the run manifest'],
    ],
    ['an unfinished shard', { ...finished, finished: false }, ['the shard did not finish']],
    [
      'a group not started',
      {
        ...finished,
        groups: {
          ...finished.groups,
          notStarted: [{ group: 'g', estimateMs: 1, elapsedMs: 1, owedMs: 0 }],
        },
      },
      ['1 groups not started before the deadline'],
    ],
    [
      'a skipped isolation pair',
      {
        ...finished,
        isolation: {
          ...finished.isolation,
          skipped: [{ a: A1, b: A2, estimateMs: 1, elapsedMs: 1 }],
        },
      },
      ['1 pairs not isolated before the deadline'],
    ],
    [
      'a deferred isolation pair that did not fit (isolation not-run by plan)',
      {
        ...finished,
        isolation: {
          ...finished.isolation,
          deferred: [{ a: A1, b: A2, estimateMs: 1, elapsedMs: 1 }],
        },
      },
      [],
    ],
  ])('reports %s', (_title, report, issues) => {
    expect(shardIssues(report)).toEqual(issues);
  });
});

describe('compareControls', () => {
  it('names every expected pair whose verdict or rule differs or has no verdict', () => {
    const prefix = 'test/fixtures/mutation-scenario-map/';
    const comparison = compareControls(
      [
        {
          id: 'same',
          tests: ['s.case.ts#s > b', 's.case.ts#s > a'],
          verdict: 'row',
          rule: 'row-deletion-asymmetric',
        },
        {
          id: 'other',
          tests: ['o.case.ts#o > a', 'o.case.ts#o > b'],
          verdict: 'review',
          rule: 'facet-differs-same-kills',
        },
        {
          id: 'gone',
          tests: ['g.case.ts#g > a', 'g.case.ts#g > b'],
          verdict: 'distinct',
          rule: 'distinct',
        },
      ],
      [
        {
          a: `${prefix}s.case.ts#s > a`,
          b: `${prefix}s.case.ts#s > b`,
          verdict: 'row',
          rule: 'row-deletion-asymmetric',
        },
        {
          a: `${prefix}o.case.ts#o > a`,
          b: `${prefix}o.case.ts#o > b`,
          verdict: 'repeat-strong',
          rule: 'facet-differs-same-kills',
        },
      ],
      prefix,
    );
    expect(comparison.differences).toEqual(['other', 'gone']);
  });
});
