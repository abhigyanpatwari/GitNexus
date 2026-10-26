/**
 * Locks the scenario-map CLI (U14, R14, R16, KTD1, KTD17) without spawning Vitest or Stryker:
 * argument parsing and usage errors (exit 2), the stages that run tests refusing to start without
 * a built `dist/`, the merge stage over a small temp work directory whose second shard never reported
 * (the run is partial and that shard's pairs are Inconclusive) and whose group with an empty
 * mutate scope is never run (its pair is Out of scope), the final shard plan value-flow re-plans
 * and its fallback to plan.json's provisional plan (merge and the `shards` count follow it), and
 * the pure helpers behind the plan, shard and controls stages (the D9/D10 cost terms at a target
 * concurrency and speed factor, the shards needed, the value-flow view of the isolation
 * selection, the seeded group sample, the shard completeness check, the expected.json
 * comparison, the batch split of observations and run universes, the slim batch record), and a
 * merge that reports a group result of an older schema as incomplete. Also: a merge whose
 * --baseline does not read, is not JSON or has another schema still writes its report (the
 * incompatible-baseline banner, a warning); a truncated isolation run file leaves the run partial;
 * an invalid trace run leaves it partial; the controls oracle fails on an empty expected.json, an
 * unlisted repeat verdict and a case file without a pair; the PDG analyze budget stays below the
 * CI value-flow step timeout.
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
import { pairKey } from '../../../tools/scenario-map/mutation/isolation.js';
import type { GroupScope, PlannedGroup } from '../../../tools/scenario-map/mutation/plan-shards.js';
import type {
  GroupObservations,
  StrykerSummary,
} from '../../../tools/scenario-map/mutation/run-group.js';
import type { RowDeletionPlan } from '../../../tools/scenario-map/mutation/row-deletion.js';
import type { ScenarioMapReport } from '../../../tools/scenario-map/report/report.js';
import type {
  Observation,
  RunUniverse,
} from '../../../tools/scenario-map/mutation/observations.js';
import type { PairValueFlow } from '../../../tools/scenario-map/value-flow/pdg-walk.js';
import type { PairTrace } from '../../../tools/scenario-map/value-flow/trace.js';
import type {
  FingerprintPair,
  FingerprintRule,
  FingerprintVerdict,
} from '../../../tools/scenario-map/verdict/fingerprint.js';
import type { PairVerdict, RuleId, Verdict } from '../../../tools/scenario-map/verdict/verdict.js';
import {
  ANALYZE_TIMEOUT_MS,
  SCENARIO_COST_MODEL,
  WORK_SCHEMA_VERSION,
  mutantRunScale,
  scenarioCostModel,
  valueFlowPasses,
  valueFlowView,
  batchGroups,
  batchRecordOf,
  batchScope,
  compareControls,
  controlsCaseFiles,
  effectiveShardPlan,
  estimateScenarioGroup,
  isolationOrder,
  mutationTarget,
  parseCliArgs,
  parseExpectedControls,
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

  it.each([
    { argv: ['plan'], scope: 'all' },
    { argv: ['plan', '--mutation', 'none'], scope: 'none' },
    { argv: ['all', '--mutation', 'possible-duplicates'], scope: 'possible-duplicates' },
  ])('takes the mutation scope $scope', ({ argv, scope }) => {
    expect(parseCliArgs(argv, '/base').mutation).toBe(scope);
  });

  it('rejects an unknown mutation scope, and the flag outside plan and all', () => {
    expect(() => parseCliArgs(['plan', '--mutation', 'some'], '/base')).toThrow(
      /--mutation must be one of none, possible-duplicates, all/,
    );
    expect(() => parseCliArgs(['controls', '--mutation', 'none'], '/base')).toThrow(
      /does not apply to the controls stage/,
    );
  });

  it('takes the worker bound of the value-flow trace run', () => {
    const valueFlow = parseCliArgs(['value-flow', '--concurrency', '3'], '/base');
    expect([valueFlow.stage, valueFlow.concurrency]).toEqual(['value-flow', 3]);
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
    ['a coverage slice without its index', ['coverage', '--of', '4'], /coverage needs --index/],
    [
      'slice files on the coverage stage',
      ['coverage', '--index', '0', '--of', '4', '--coverage', 'dir'],
      /does not apply to the coverage stage/,
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

  it('gives the coverage stage its slice and the plan its slice directory', () => {
    const coverage = parseCliArgs(['coverage', '--index', '3', '--of', '12'], '/base');
    const plan = parseCliArgs(['plan', '--coverage', 'slices'], '/base');
    expect([coverage.stage, coverage.index, coverage.of, coverage.coverage, plan.coverage]).toEqual(
      ['coverage', 3, 12, null, path.resolve('/base', 'slices')],
    );
  });

  it('exits 2 for slice files inside the work directory, which plan empties', async () => {
    const { deps, lines, work } = setup();
    const code = await runCli(
      ['plan', '--work', work, '--coverage', path.join(work, 'slices')],
      deps,
    );
    expect([code, lines[0]]).toEqual([2, expect.stringMatching(/must lie outside --work/)]);
  });

  it('exits 2 for a work directory inside the checkout', async () => {
    const { deps, lines, root } = setup();
    const code = await runCli(['plan', '--work', path.join(root, 'work')], deps);
    expect([code, lines[0]]).toEqual([2, expect.stringMatching(/must lie outside the checkout/)]);
  });

  it.each([
    { argv: ['controls'] },
    { argv: ['coverage', '--index', '0', '--of', '2'] },
    { argv: ['plan'] },
    { argv: ['value-flow'] },
    { argv: ['all', '--mutation', 'none'] },
    { argv: ['all', '--mutation', 'all'] },
  ])(
    'exits 2 for $argv without a built dist/, naming the build step, before any stage runs',
    async ({ argv }) => {
      const { deps, lines, work } = setup();
      const code = await runCli([...argv, '--work', work], deps);
      expect([code, lines[0], existsSync(work)]).toEqual([
        2,
        expect.stringContaining('node scripts/build.js'),
        false,
      ]);
    },
  );

  it.each([{ argv: ['shards'] }, { argv: ['merge'] }, { argv: ['plan', '--coverage', 'slices'] }])(
    'lets $argv start without dist/: it runs no test',
    async ({ argv }) => {
      const { deps, lines, work } = setup();
      await runCli([...argv, '--work', work], deps);
      expect(lines.some((line) => line.includes('node scripts/build.js'))).toBe(false);
    },
  );
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
    mutation: 'all',
    eligibility: {
      mode: 'normal',
      files: ['test/unit/a.test.ts', 'test/unit/b.test.ts', 'test/unit/c.test.ts'],
      fingerprintFiles: ['test/unit/a.test.ts', 'test/unit/b.test.ts', 'test/unit/c.test.ts'],
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
    schemaVersion: 2,
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
    runUniverse: null,
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
      issues: [],
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
  it('reports the fingerprint of every pair and no mutation verdict for a fingerprint-only run', async () => {
    const { deps, work } = setup();
    writeTwoShardRun(work);
    const plan: PlanFile = {
      ...basePlan(),
      mutation: 'none',
      shardPlan: { ...basePlan().shardPlan, groups: [], shards: [] },
      shardsNeeded: 0,
    };
    writeFileSync(workLayout(work).plan, JSON.stringify(plan));
    const code = await runCli(['merge', '--work', work, '--run-id', '7'], deps);
    const report = JSON.parse(
      readFileSync(workLayout(work).reportJson, 'utf8'),
    ) as ScenarioMapReport;
    expect({
      code,
      complete: report.completeness.complete,
      mutation: report.mutation,
      mutationPairs: report.pairs.length,
      tests: report.tests.length,
      fingerprint: report.fingerprint.pairs.map((pair) => [pair.a, pair.verdict, pair.rule]),
    }).toEqual({
      code: 0,
      complete: true,
      mutation: 'none',
      mutationPairs: 0,
      tests: 0,
      fingerprint: [
        [A1, 'possible-duplicate', 'facet-unknown'],
        [B1, 'possible-duplicate', 'facet-unknown'],
        [C1, 'possible-duplicate', 'facet-unknown'],
      ],
    });
  });

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

  it('reports a group result of the pre-compact schema as incomplete, its pairs not scheduled', async () => {
    const { deps, work } = setup();
    writeTwoShardRun(work);
    const file = path.join(work, 'observations', 'ga.json');
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...written, schemaVersion: 1 }));
    const code = await runCli(['merge', '--work', work, '--run-id', '7'], deps);
    const report = JSON.parse(
      readFileSync(workLayout(work).reportJson, 'utf8'),
    ) as ScenarioMapReport;
    expect({
      code,
      incomplete: report.completeness.shards.incomplete,
      pair: report.pairs.map((pair) => [pair.a, pair.rule])[0],
    }).toEqual({
      code: 1,
      incomplete: [
        { shard: '1', reason: 'no shard result' },
        {
          shard: 'group ga',
          reason: expect.stringMatching(/has schema 1, not 2: .*re-run its shard$/),
        },
      ],
      pair: [A1, 'not-scheduled'],
    });
  });

  it.each([
    [
      'a truncated report (not JSON)',
      (file: string): void => writeFileSync(file, '{"schemaVersion": 1, "contin'),
      /^unreadable baseline: /,
    ],
    [
      'a report of another schema',
      (file: string): void => writeFileSync(file, JSON.stringify({ schemaVersion: 999 })),
      /^baseline schema version 999, this report \d+$/,
    ],
    ['a missing file', (): void => undefined, /^unreadable baseline: ENOENT/],
  ])(
    'still writes the report with %s as --baseline, under the incompatible-baseline banner',
    async (_title, write, reason) => {
      const { deps, lines, work } = setup();
      writeTwoShardRun(work, ONE_SHARD_REPLAN);
      const baseline = path.join(path.dirname(work), 'baseline.json');
      write(baseline);
      const code = await runCli(['merge', '--work', work, '--baseline', baseline], deps);
      const report = JSON.parse(
        readFileSync(workLayout(work).reportJson, 'utf8'),
      ) as ScenarioMapReport;
      expect({
        code,
        state: report.changes.state,
        banner: report.changes.banner,
        reason: report.changes.reason,
        warned: lines.some((line) => line.startsWith(`merge: warning: --baseline ${baseline}`)),
      }).toEqual({
        code: 0,
        state: 'incompatible',
        banner: 'incompatible baseline',
        reason: expect.stringMatching(reason),
        warned: true,
      });
    },
  );

  it('leaves a truncated isolation run out and the run partial', async () => {
    const { deps, work } = setup();
    writeTwoShardRun(work, ONE_SHARD_REPLAN);
    const file = path.join(work, 'isolation', 'ga', 'ga-together-1.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"schemaVersion": 2, "group": "ga", "observ');
    const code = await runCli(['merge', '--work', work], deps);
    const report = JSON.parse(
      readFileSync(workLayout(work).reportJson, 'utf8'),
    ) as ScenarioMapReport;
    expect([code, report.completeness.partial, report.completeness.shards.incomplete]).toEqual([
      1,
      true,
      [{ shard: 'isolation ga/ga-together-1.json', reason: expect.stringMatching(/JSON/) }],
    ]);
  });

  it('marks the run partial when the trace run is invalid', async () => {
    const { deps, work } = setup();
    writeTwoShardRun(work, ONE_SHARD_REPLAN);
    const layout = workLayout(work);
    const valueFlow = JSON.parse(readFileSync(layout.valueFlow, 'utf8')) as ValueFlowFile;
    const invalid: ValueFlowFile = {
      ...valueFlow,
      pairs: { facetEqual: 1, valueDiffering: 0 },
      trace: {
        ...valueFlow.trace,
        status: 'ran',
        detail: null,
        issues: ['traced run error/infrastructure'],
      },
    };
    writeFileSync(layout.valueFlow, JSON.stringify(invalid));
    const code = await runCli(['merge', '--work', work], deps);
    const report = JSON.parse(readFileSync(layout.reportJson, 'utf8')) as ScenarioMapReport;
    expect([code, report.completeness.shards.incomplete]).toEqual([
      1,
      [
        {
          shard: 'value-flow',
          reason: 'trace run invalid: traced run error/infrastructure',
        },
      ],
    ]);
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

describe('mutationTarget', () => {
  const A3 = 'test/unit/a.test.ts#A > three';
  const groups: GroupScope[] = [
    {
      ...plannedGroup('ga', [A1, A2, A3]),
      mutate: ['gitnexus/src/a.ts', 'gitnexus/src/b.ts'],
      provenanceUnknown: [A3],
    },
    plannedGroup('gb', [B1, B2]),
  ];
  const pairs = [
    candidatePair(A1, A2, 'ga'),
    candidatePair(A1, A3, 'ga'),
    candidatePair(B1, B2, 'gb'),
  ];
  const verdicts = new Map<string, FingerprintVerdict>([
    [pairKey(A1, A2), 'possible-duplicate'],
    [pairKey(A1, A3), 'table-row'],
    [pairKey(B1, B2), 'duplicate'],
  ]);
  const executed = (test: string): string[] | null => (test === A3 ? null : ['gitnexus/src/a.ts']);

  it.each([
    {
      scope: 'all',
      expected: [
        ['ga', 3],
        ['gb', 2],
      ],
      pairs: 3,
    },
    { scope: 'none', expected: [], pairs: 0 },
  ] as const)('keeps every group for $scope, or none', ({ scope, expected, pairs: count }) => {
    const target = mutationTarget(scope, groups, pairs, verdicts, executed, () => true);
    expect([
      target.scopes.map((group) => [group.id, group.tests.length]),
      target.pairs.length,
    ]).toEqual([expected, count]);
  });

  it('keeps the possible duplicates, trimmed to their tests and the files those tests executed', () => {
    const target = mutationTarget(
      'possible-duplicates',
      groups,
      pairs,
      verdicts,
      executed,
      () => true,
    );
    expect(target).toEqual({
      scopes: [
        {
          id: 'ga',
          tests: [A1, A2],
          testFiles: ['test/unit/a.test.ts'],
          pairs: 1,
          mutate: ['gitnexus/src/a.ts'],
          excluded: [],
          closureIncomplete: [],
          provenanceUnknown: [],
        },
      ],
      pairs: [pairs[0]],
    });
  });

  it('mutates no pair with a test outside the mutation-eligible files, whatever the scope', () => {
    const onlyA = (test: string): boolean => test.startsWith('test/unit/a.test.ts');
    const all = mutationTarget('all', groups, pairs, verdicts, executed, onlyA);
    const possible = mutationTarget(
      'possible-duplicates',
      groups,
      pairs,
      verdicts,
      executed,
      onlyA,
    );
    expect([all.pairs, all.scopes.map((group) => group.id), possible.pairs]).toEqual([
      [pairs[0], pairs[1]],
      ['ga'],
      [pairs[0]],
    ]);
  });

  it('keeps every mutate file when a kept test has an unknown provenance', () => {
    const unknown = new Map(verdicts).set(pairKey(A1, A3), 'possible-duplicate');
    const target = mutationTarget(
      'possible-duplicates',
      groups,
      pairs,
      unknown,
      executed,
      () => true,
    );
    expect(target.scopes.map((group) => [group.tests, group.mutate])).toEqual([
      [
        [A1, A2, A3],
        ['gitnexus/src/a.ts', 'gitnexus/src/b.ts'],
      ],
    ]);
  });
});

describe('planShards', () => {
  it('plans no shard when no group has anything to mutate', () => {
    const planned = planShards({
      scopes: [],
      pairs: [],
      potentialRepeat: () => false,
      executedFiles: () => null,
      rowDeletion: [],
      sizeOf: () => 0,
      shards: null,
      budgetMs: 300 * 60_000,
      model: SCENARIO_COST_MODEL,
    });
    expect([planned.shardPlan.shards, planned.shardsNeeded, planned.shardsCapped]).toEqual([
      [],
      0,
      false,
    ]);
  });

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
      issues: [],
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

  it('follows the re-plan of a narrower mutation scope even when the trace did not run', () => {
    const scoped: PlanFile = { ...basePlan(), mutation: 'possible-duplicates' };
    const effective = effectiveShardPlan(
      scoped,
      file([], [], { traced: false, replan: ONE_SHARD_REPLAN }),
    );
    expect([effective.source, effective.shardPlan.shards.length]).toEqual(['value-flow', 1]);
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
    const universe: RunUniverse = {
      group: 'bbatch',
      kind: 'main',
      lineage: 'main',
      shard: 0,
      tests: scope.tests,
      mutants: ['gitnexus/src/a.ts', 'gitnexus/src/b.ts'].map((file) => ({
        id: observation(A1, file).mutant,
        file,
        static: false,
        status: 'Killed' as const,
        reasons: [],
        hookMarker: true,
      })),
      valid: true,
      reasons: [],
    };
    const result: GroupObservations = {
      schemaVersion: 2,
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
      runUniverse: universe,
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
        [
          member.runUniverse?.group,
          member.runUniverse?.tests,
          member.runUniverse?.mutants.map((entry) => entry.file),
        ],
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
          ['ga', [A1, A2], ['gitnexus/src/a.ts']],
          { id: 'bbatch', groups: ['ga', 'gb'] },
        ],
        [
          'gb',
          [B1, B2],
          ['gitnexus/src/b.ts'],
          [['gb', B2, 'gitnexus/src/b.ts']],
          ['gb', [B1, B2], ['gitnexus/src/b.ts']],
          { id: 'bbatch', groups: ['ga', 'gb'] },
        ],
      ],
    });
  });
});

describe('batchRecordOf', () => {
  it('keeps a batch outcome and its members, never its run universe or observations', () => {
    const scope = plannedGroup('bbatch', [A1, B1]);
    const stryker: StrykerSummary = {
      exitCode: 0,
      wallClockMs: 1,
      resultsFile: '/work/groups/bbatch/stryker/results.json',
      mutants: 2,
      evaluated: 2,
      flags: 0,
    };
    const record = batchRecordOf(
      {
        schemaVersion: 2,
        group: 'bbatch',
        shard: 0,
        manifestDigest: DIGEST,
        status: 'complete',
        reason: null,
        detail: null,
        tests: scope.tests,
        scope,
        baselines: [],
        stryker,
        runUniverse: {
          group: 'bbatch',
          kind: 'main',
          lineage: 'main',
          shard: 0,
          tests: scope.tests,
          mutants: [],
          valid: true,
          reasons: [],
        },
        observations: [],
        wallClockMs: 5,
      },
      ['ga', 'gb'],
    );
    expect([
      'runUniverse' in record,
      'observations' in record,
      record.groups,
      record.stryker?.resultsFile,
    ]).toEqual([false, false, ['ga', 'gb'], '/work/groups/bbatch/stryker/results.json']);
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

describe('parseExpectedControls', () => {
  const PAIR = {
    id: 'p',
    tests: ['p.case.ts#p > a', 'p.case.ts#p > b'],
    verdict: 'review',
    rule: 'value-flow-veto',
    fingerprint: { verdict: 'table-row', rule: 'input-values-differ' },
  };

  it('reads each pair of the fixture file', () => {
    expect(parseExpectedControls({ schemaVersion: 1, pairs: [{ ...PAIR, stages: {} }] })).toEqual([
      PAIR,
    ]);
  });

  it.each([
    ['pairs that are no array', { pairs: {} }, /pairs must be an array/],
    ['no pairs at all', { schemaVersion: 1 }, /pairs must be an array/],
    ['an empty pair list', { pairs: [] }, /pairs is empty/],
    ['a pair with one test', { pairs: [{ ...PAIR, tests: ['p.case.ts#p > a'] }] }, /malformed/],
    [
      'a pair without a rule',
      { pairs: [{ id: 'p', tests: PAIR.tests, verdict: 'row' }] },
      /malformed/,
    ],
    [
      'a pair without a fingerprint',
      { pairs: [{ id: 'p', tests: PAIR.tests, verdict: 'row', rule: 'kills-differ' }] },
      /malformed/,
    ],
  ])('rejects %s', (_title, data, message) => {
    expect(() => parseExpectedControls(data)).toThrow(message);
  });
});

describe('controls oracle failures', () => {
  const prefix = 'test/fixtures/mutation-scenario-map/';
  const expectedPair = {
    id: 'p',
    tests: ['p.case.ts#p > a', 'p.case.ts#p > b'] as [string, string],
    verdict: 'review',
    rule: 'value-flow-veto',
    fingerprint: { verdict: 'table-row', rule: 'input-values-differ' },
  };
  const verdictOf = (
    a: string,
    b: string,
    verdict: Verdict,
    rule: RuleId,
  ): Pick<PairVerdict, 'a' | 'b' | 'verdict' | 'rule'> => ({
    a: `${prefix}${a}`,
    b: `${prefix}${b}`,
    verdict,
    rule,
  });
  const listed = verdictOf('p.case.ts#p > a', 'p.case.ts#p > b', 'review', 'value-flow-veto');
  const fingerprintOf = (
    a: string,
    b: string,
    verdict: FingerprintVerdict,
    rule: FingerprintRule,
  ): Pick<FingerprintPair, 'a' | 'b' | 'verdict' | 'rule'> => ({
    a: `${prefix}${a}`,
    b: `${prefix}${b}`,
    verdict,
    rule,
  });
  const listedFingerprint = fingerprintOf(
    'p.case.ts#p > a',
    'p.case.ts#p > b',
    'table-row',
    'input-values-differ',
  );

  it.each([
    ['an empty expected list', [], [], [], [], ['no expected pair']],
    [
      'a strong repeat between two case files that expected.json does not list',
      [expectedPair],
      [
        listed,
        verdictOf('p.case.ts#p > a', 'q.case.ts#q > a', 'repeat-strong', 'all-strong-conditions'),
      ],
      [listedFingerprint],
      ['p.case.ts'],
      ['unlisted repeat-strong: p.case.ts#p > a + q.case.ts#q > a'],
    ],
    [
      'a weak repeat that expected.json does not list',
      [expectedPair],
      [listed, verdictOf('p.case.ts#p > b', 'q.case.ts#q > b', 'repeat-weak', 'weak-disqualifier')],
      [listedFingerprint],
      ['p.case.ts'],
      ['unlisted repeat-weak: p.case.ts#p > b + q.case.ts#q > b'],
    ],
    [
      'a fingerprint duplicate that expected.json does not list',
      [expectedPair],
      [listed],
      [
        listedFingerprint,
        fingerprintOf(
          'p.case.ts#p > a',
          'q.case.ts#q > a',
          'duplicate',
          'same-path-input-expectation',
        ),
      ],
      ['p.case.ts'],
      ['unlisted duplicate: p.case.ts#p > a + q.case.ts#q > a'],
    ],
    [
      'a fingerprint verdict that differs',
      [expectedPair],
      [listed],
      [
        fingerprintOf(
          'p.case.ts#p > a',
          'p.case.ts#p > b',
          'duplicate',
          'same-path-input-expectation',
        ),
      ],
      ['p.case.ts'],
      ['p fingerprint'],
    ],
    [
      'a case file no expected pair exercises',
      [expectedPair],
      [listed],
      [listedFingerprint],
      ['p.case.ts', 'q.case.ts'],
      ['case file without a pair: q.case.ts'],
    ],
    [
      'an unlisted pair that is not a repeat (nothing to report)',
      [expectedPair],
      [listed, verdictOf('p.case.ts#p > a', 'q.case.ts#q > a', 'distinct', 'path-differs')],
      [
        listedFingerprint,
        fingerprintOf('p.case.ts#p > a', 'q.case.ts#q > a', 'distinct', 'path-differs'),
      ],
      ['p.case.ts'],
      [],
    ],
  ] as const)('reports %s', (_title, expected, verdicts, fingerprints, caseFiles, differences) => {
    expect(
      compareControls(expected, verdicts, fingerprints, prefix, caseFiles).differences,
    ).toEqual(differences);
  });

  it('finds the case files of a fixture, nested ones included, relative to its root', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'more'), { recursive: true });
    for (const file of ['b.case.ts', 'a.case.ts', 'more/c.case.ts', 'src/a.ts', 'expected.json']) {
      writeFileSync(path.join(dir, file), '');
    }
    expect(controlsCaseFiles(dir)).toEqual(['a.case.ts', 'b.case.ts', 'more/c.case.ts']);
  });
});

describe('PDG analyze budget', () => {
  it('stays below the CI value-flow step timeout of 50 minutes, so the degraded path is reachable', () => {
    expect(ANALYZE_TIMEOUT_MS).toBeLessThan(50 * 60_000);
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
          fingerprint: { verdict: 'table-row', rule: 'input-values-differ' },
        },
        {
          id: 'other',
          tests: ['o.case.ts#o > a', 'o.case.ts#o > b'],
          verdict: 'review',
          rule: 'facet-differs-same-kills',
          fingerprint: { verdict: 'distinct', rule: 'input-shape-differs' },
        },
        {
          id: 'gone',
          tests: ['g.case.ts#g > a', 'g.case.ts#g > b'],
          verdict: 'distinct',
          rule: 'distinct',
          fingerprint: { verdict: 'distinct', rule: 'path-differs' },
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
      [
        {
          a: `${prefix}s.case.ts#s > a`,
          b: `${prefix}s.case.ts#s > b`,
          verdict: 'table-row',
          rule: 'input-values-differ',
        },
        {
          a: `${prefix}o.case.ts#o > a`,
          b: `${prefix}o.case.ts#o > b`,
          verdict: 'distinct',
          rule: 'input-shape-differs',
        },
      ],
      prefix,
      ['s.case.ts', 'o.case.ts', 'g.case.ts'],
    );
    expect(comparison.differences).toEqual(['other', 'gone', 'gone fingerprint']);
  });
});
