/**
 * Locks the scenario-map CLI (U14, R14, R16, KTD1, KTD17) without spawning Vitest or Stryker:
 * argument parsing and usage errors (exit 2), the controls stage refusing to run without a built
 * `dist/`, the merge stage over a small temp work directory whose second shard never reported
 * (the run is partial and that shard's pairs are Inconclusive), and the pure helpers behind the
 * plan, shard and controls stages (the D9/D10 cost terms, the seeded group sample, the shard
 * completeness check, the expected.json comparison).
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
import {
  SCENARIO_COST_MODEL,
  WORK_SCHEMA_VERSION,
  batchGroups,
  batchScope,
  compareControls,
  estimateScenarioGroup,
  parseCliArgs,
  planShards,
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

/** Writes plan, Layer 1/2, value flow and shard 0's results; shard 1 never reported. */
function writeTwoShardRun(work: string): void {
  const layout = workLayout(work);
  const tests = [A1, A2, B1, B2];
  const groups = [plannedGroup('ga', [A1, A2]), plannedGroup('gb', [B1, B2])];
  const write = (file: string, value: unknown): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  const plan: PlanFile = {
    schemaVersion: WORK_SCHEMA_VERSION,
    mode: { kind: 'normal' },
    seed: 's1',
    eligibility: {
      mode: 'normal',
      files: ['test/unit/a.test.ts', 'test/unit/b.test.ts'],
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
    estimates: [],
    pairs: [candidatePair(A1, A2, 'ga'), candidatePair(B1, B2, 'gb')],
    rowDeletion: [],
    stats: { tests: 4, groups: 2, pairs: 2, facetEqualPairs: 0, wallClockMs: {} },
  };
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
    isolation: { candidates: 0, selected: 0, runs: [], skipped: [] },
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
  it('marks a run with a missing shard partial and leaves that shard’s pairs Inconclusive', async () => {
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
      ],
      written: [true, true],
    });
  });
});

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('estimateScenarioGroup', () => {
  it('adds the D10 row-deletion runs and the D9 fixed isolation runs to the main run', () => {
    const model = {
      ...SCENARIO_COST_MODEL,
      perRunMs: 1000,
      perByteTestMs: 1,
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
    // main 1000 + 100 * 3; row deletion 3 * 7; isolation 3 * 100 + 40 * 0.5 * 3 runs * 10.
    expect([
      estimate.mainMs,
      estimate.rowDeletionMs,
      estimate.isolationMs,
      estimate.estimateMs,
    ]).toEqual([1300, 21, 900, 2221]);
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
});

describe('batchGroups', () => {
  const MIN = 60_000;

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
      MIN,
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
      MIN,
      20 * MIN,
    );
    expect([batch.id, single.id]).toEqual([expect.stringMatching(/^b[0-9a-f]{16}$/), 'g9']);
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
    batches: [],
    sample: null,
    groups: { ran: [], notStarted: [], sampledOut: [] },
    rowDeletion: { status: 'none', pairs: 0, planned: 0, runs: 0, estimateMs: 0, wallClockMs: 0 },
    isolation: { candidates: 0, selected: 0, runs: [], skipped: [] },
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
