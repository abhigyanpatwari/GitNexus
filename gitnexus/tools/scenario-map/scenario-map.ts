/**
 * The scenario-map CLI (U14, R14, R16, KTD1, KTD11, KTD13, KTD14, KTD17): one command whose
 * stages map one-to-one onto the CI jobs, so a local `all` run and CI produce the same report.
 * Every stage reads and writes JSON in one work directory (`--work`, outside the checkout); CI
 * jobs exchange those files as artifacts.
 *
 * Stages:
 *   plan        eligibility (R1); the Layer 0 scan (test-dupes over the `--all` corpus plus the
 *               eligible files, findings on eligible files kept); a prepared copy and the run
 *               manifest built right after it (KTD14); Layer 1 (path-coverage `runCoverage`); the
 *               static inventory and runtime join (U3); checks and context (U5, with the file
 *               snapshot and helper-module readers); input facets (U6); candidates (U4, Jaccard
 *               and checks-and-context sources); each group's KTD7 mutate scope (U7); the
 *               row-deletion plans of the facet-equal pairs (U9); the shard plan (KTD17).
 *               The KTD17 estimate of a group ({@link estimateScenarioGroup}) is its main run
 *               (fixed overhead plus mutated bytes times tests), plus row deletion (one Vitest run
 *               per control and deletion of its planned pairs, D10), plus isolation over the pairs
 *               that can still be strong on plan-time facts (equal checks-and-context keys, equal
 *               facets without a residual difference, and no weak disqualifier the verdict engine
 *               already finds before any mutation run): a FIXED cost per isolation run (one
 *               together run per pair, one alone run per test, D9) and the fresh-process mutant
 *               runs over the production bytes either test executed. The row-deletion batch's
 *               fixed cost is reserved once per shard, at the first group that needs it.
 *   shard       `--index <i> --of <n>`: prepares its copy and verifies it against the run
 *               manifest (a mismatch writes `manifest-mismatch` results and runs nothing); runs its
 *               groups' Layer 3 main runs (U7 `runGroup`) in plan order, several groups sharing one
 *               Stryker run ({@link batchGroups}; an Inconclusive batch is re-run group by group),
 *               each batch started only when its whole estimate fits before the deadline with the
 *               row deletion and isolation of the groups already started still owed (KTD17); then
 *               one row-deletion batch (U9) for the pairs of its complete groups; then the
 *               isolation pass (U8) only for pairs that can still be strong: the verdict engine
 *               (U12), given every stage still to come at its best (isolation agrees, trace and
 *               static value flow clean), calls them repeat-strong (D9). Each isolation pair
 *               starts only when its pending runs fit before the deadline. Every result is written
 *               as soon as it exists.
 *   value-flow  the PDG index of a copy (the production roots, or the fixture in controls mode)
 *               under a temporary GITNEXUS_HOME (`node dist/cli/index.js analyze <copy> --pdg
 *               --skip-git --index-only`); the TypeScript checker (the fixture's tsconfig in
 *               controls mode); the static value-flow check (U10) of the facet-equal candidate
 *               pairs whose discarded values differ, with their group's mutate scope; the trace
 *               run (U11) of every facet-equal candidate pair, U10's opaque sinks wrapped. A
 *               failed analyze is the `no-pdg-layer` degraded run (KTD11).
 *   merge       every result found: shard reports, group results, isolation runs, row deletion
 *               and value flow. A missing or unfinished shard leaves the run partial, and the
 *               pairs of its groups without a result Inconclusive (`not-scheduled`, R11). Then the
 *               verdicts (U12), mutant fingerprints, provenance and the report (U13).
 *   all         plan (one shard), shard 0 of 1, value-flow and merge, in one process.
 *   controls    `all` in controls mode over the U17 fixture (extra root, its tsconfig, its own
 *               PDG index), then the verdict and rule of every expected.json pair compared.
 *               Needs a built `dist/` for the PDG index (`node scripts/build.js`).
 *
 * Usage (from gitnexus/; `npm run test:scenario-map -- <stage> …` runs the same):
 *   node --import tsx tools/scenario-map/scenario-map.ts <stage> [flags]
 *   --work <dir>               work directory, outside the checkout; default
 *                              `<os tmpdir>/gitnexus-scenario-map` (`…-controls` for controls)
 *   --mode normal|controls     plan, all: the run mode; `--controls` is `--mode controls`
 *   --seed <text>              plan, all, controls: seed of every sampled choice (spot audit)
 *   --shards <n>               plan: number of shards (default 1)
 *   --index <i> --of <n>       shard: 0-based shard index and the plan's shard count
 *   --deadline-minutes <m>     plan: one shard's budget; shard, all, controls: the deadline
 *                              (default 300, KTD17)
 *   --baseline <report.json>   merge, all, controls: the previous complete run's report
 *   --run-id <id> --run-attempt <n> --run-url <url> --ref <ref> --default-branch
 *                              merge, all, controls: the report header (default run `local`)
 *   --sample <n>               shard, debug: run a sample of n of its groups, picked by
 *                              ascending sha256 of the plan's seed and the group id
 *   --groups <id,…>            shard, debug: run these groups of the shard (with --sample:
 *                              in addition to the sample); the others are left out
 *
 * Work directory (every path relative to `--work`):
 *   .gitnexus-scenario-map       marker: plan may clear a directory that holds it
 *   plan.json                    plan: mode, seed, eligibility, cost model, shard plan (groups
 *                                with their KTD7 scope and estimate), per-group cost breakdown,
 *                                candidate pairs, row-deletion plans, timings
 *   scenario-run-manifest.json   plan: the run manifest (U7, KTD14)
 *   layer0.json                  plan: test-dupes `--json` shape, findings on eligible files
 *   layer2.json                  plan: per test: anchor, join problems, unresolved inputs,
 *                                dupe-ok, checks-and-context key, unsupported forms, facet
 *   coverage/coverage.json       plan: the Layer 1 work file; coverage/candidates.json: pairs
 *   plan/prepared/, coverage/prepared/   plan scratch
 *   observations/<group>.json    shard: group results (U7; a batch member's carries `batch`)
 *   batches/<batch>.json         shard: the whole result of a main-run batch (before the split)
 *   isolation/<group>/<run>.json shard: isolation run results (U8)
 *   row-deletion-shard-<i>.json  shard: row-deletion results (U9)
 *   shard-<i>.json               shard: shard report (written as it goes; `finished` at the end)
 *   shard-<i>/, groups/, row-deletion/   shard scratch
 *   value-flow.json              value-flow: PDG index status, static run, trace run
 *   value-flow/pdg/, trace/      value-flow scratch (the analyze log is value-flow/pdg/analyze.log)
 *   scenario-map-report.json, scenario-map-report.md, issue-body.md   merge
 * A CI shard job needs plan.json, scenario-run-manifest.json, layer2.json and
 * coverage/coverage.json; value-flow needs the same; merge needs every artifact listed above
 * except the scratch directories.
 *
 * Exit codes: 0 the stage finished with complete results (`controls`: every expected verdict and
 * rule holds); 1 it finished with incomplete results: a shard with a manifest mismatch, groups not
 * started before the deadline, row deletion or isolation skipped, or sampled; a degraded value-flow
 * run or a trace that did not run; a partial report (`controls`: a verdict or rule differs); 2 a
 * usage or setup error, including a missing `dist/` build for value-flow, all and controls, or an
 * unexpected error. Codes are always set explicitly: an in-process Vitest run with a failing
 * baseline leaves `process.exitCode` at 1 (D9).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classify } from '../mutation/classify/classify.js';
import { PACKAGE_DIR, buildPathMap } from '../mutation/prepare/path-map.js';
import { prepare } from '../mutation/prepare/prepare.js';
import { parseTestId } from '../mutation/runner/test-ids.js';
import { errorMessage, isMainModule } from '../mutation/shared/cli.js';
import { isInside, readJsonFile } from '../mutation/shared/fs.js';
import { isTestSupportFile, scan, type SourceFile } from '../test-dupes/test-dupes.js';
import {
  checksContextKey,
  computeChecks,
  fsModuleReader,
  fsSnapshotReader,
  subjectOf,
  type UnsupportedForm,
} from './facet/checks.js';
import {
  computeFacet,
  createRunFacetContext,
  facetSubjectOf,
  fsFacetSources,
  residualDifference,
  sameDiscardedValues,
  type FacetContext,
  type FacetSubject,
  type InputFacet,
} from './facet/input-facet.js';
import { loadStaticInventory } from './inventory/cases.js';
import { resolveEligibility } from './inventory/eligible.js';
import { joinRuntime } from './inventory/identity.js';
import {
  evaluateIsolation,
  pairKey,
  planIsolation,
  readIsolationRuns,
  runIsolationRun,
  selectRepeatStagePairs,
  type IsolationResult,
} from './mutation/isolation.js';
import { mergeObservations, type MergedObservation } from './mutation/observations.js';
import {
  DEFAULT_COST_MODEL,
  ISOLATION_RUNS,
  SHARD_DEADLINE_MS,
  SHARD_PLAN_SCHEMA_VERSION,
  fitsBeforeDeadline,
  groupScope,
  packShards,
  resolvePairSchedules,
  type CostModel,
  type GroupScope,
  type PairSchedule,
  type PlannedGroup,
  type ShardPlan,
} from './mutation/plan-shards.js';
import {
  planRowDeletion,
  pairTableSearch,
  runRowDeletion,
  type RowDeletionPlan,
  type RowDeletionResult,
} from './mutation/row-deletion.js';
import {
  GROUP_OBSERVATIONS_SCHEMA_VERSION,
  buildRunManifest,
  observationsFile,
  readGroupObservations,
  readScenarioRunManifest,
  runGroup,
  verifyPreparedCopy,
  writeScenarioRunManifest,
  type GroupObservations,
  type ManifestCheck,
  type ScenarioRunManifest,
} from './mutation/run-group.js';
import { findCandidates, type CandidatePair } from './path-coverage/candidates.js';
import {
  DEFAULT_FIXTURE_ROOT,
  WORK_FILE_SCHEMA_VERSION,
  candidateTestsOf,
  readWorkFile,
  runCoverage,
  type CoverageTest,
  type CoverageWorkFile,
} from './path-coverage/run-coverage.js';
import { fingerprintMutants } from './report/anchors.js';
import { renderIssueBody } from './report/issue-body.js';
import { renderMarkdown } from './report/markdown.js';
import {
  buildReport,
  collectProvenance,
  type RunInfo,
  type ScenarioMapReport,
  type ShardStatus,
} from './report/report.js';
import {
  extraRootsOf,
  fromPackagePath,
  productionRoots,
  toPackagePath,
  type Eligibility,
  type InventoryInstance,
  type JoinProblem,
  type RunMode,
  type TestAnchor,
} from './types.js';
import { bindSideOf } from './value-flow/bind.js';
import { openChecker } from './value-flow/checker.js';
import {
  openLocalBackendEdgeSource,
  staticValueFlow,
  type ClosableEdgeSource,
  type StaticValueFlowRun,
  type ValueFlowPair,
} from './value-flow/pdg-walk.js';
import { runTrace, type TraceRunResult } from './value-flow/trace.js';
import {
  computeVerdicts,
  type PairVerdict,
  type VerdictInput,
  type VerdictPairInput,
  type VerdictReport,
  type VerdictTestInput,
} from './verdict/verdict.js';

// ── Constants ──────────────────────────────────────────────────────────────

export const STAGES = ['plan', 'shard', 'value-flow', 'merge', 'all', 'controls'] as const;
export type Stage = (typeof STAGES)[number];

/** Schema version of every work file this CLI writes. */
export const WORK_SCHEMA_VERSION = 1;
/** Marks a work directory as created by this CLI, so `plan` may clear it. */
export const WORK_MARKER_FILE = '.gitnexus-scenario-map';
/** The built CLI the PDG index runs, relative to the package dir. */
export const DIST_ENTRY = 'dist/cli/index.js';
export const BUILD_COMMAND = 'node scripts/build.js';
export const DEFAULT_SEED = '0';
/** The analyze's worker start budget (D11). */
const WORKER_READY_TIMEOUT_MS = '120000';
const ANALYZE_TIMEOUT_MS = 60 * 60_000;

/**
 * KTD17 cost model plus the D9 and D10 terms, in milliseconds. `perByteTestMs` is re-measured on
 * the eligible category (U14 measured slice, 16 groups, WSL2, concurrency 2): one group run took
 * 1.5 to 1.9 min for up to 11 KB of mutated code and 10.9 min for 597 KB with 2 tests, while the
 * KTD17 first calibration (10 ms per byte and test) estimated 200 min; 1.1 ms per byte and test
 * plus `perRunMs` (100 s) covers every measured group. `isolationRunMs`: the fixed part
 * of one isolation run (two baselines, the scope driver's prepare, Stryker's start and its
 * fresh test-runner processes), about 130 s besides its mutant runs (U8, WSL2, concurrency 2).
 * `rowDeletionBatchMs`: the batch's copy and its manifest check, about 48 s (U9);
 * `rowDeletionRunMs`: one control or deletion Vitest run, 2.5 to 5 s (U9; the upper end).
 */
export interface ScenarioCostModel extends CostModel {
  isolationRunMs: number;
  rowDeletionBatchMs: number;
  rowDeletionRunMs: number;
}

export const SCENARIO_COST_MODEL: Readonly<ScenarioCostModel> = Object.freeze({
  ...DEFAULT_COST_MODEL,
  perByteTestMs: 1.1,
  isolationRunMs: 130_000,
  rowDeletionBatchMs: 48_000,
  rowDeletionRunMs: 5_000,
});

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(byText);
const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

// ── Arguments ──────────────────────────────────────────────────────────────

export class UsageError extends Error {
  override name = 'UsageError';
}

export const USAGE =
  'usage: npm run test:scenario-map -- <plan|shard|value-flow|merge|all|controls> [--work <dir>]\n' +
  '  plan:       [--mode normal|controls | --controls] [--seed <text>] [--shards <n>] ' +
  '[--deadline-minutes <m>]\n' +
  '  shard:      --index <i> --of <n> [--deadline-minutes <m>] [--sample <n>] [--groups <id,…>]\n' +
  '  value-flow: (no flags)\n' +
  '  merge:      [--baseline <report.json>] [--run-id <id>] [--run-attempt <n>] ' +
  '[--run-url <url>] [--ref <ref>] [--default-branch]\n' +
  '  all:        the plan flags except --shards, and the merge flags\n' +
  '  controls:   [--seed <text>] [--deadline-minutes <m>] and the merge flags';

export interface CliOptions {
  stage: Stage;
  /** Absolute work directory. */
  workDir: string;
  mode: RunMode;
  seed: string;
  shards: number;
  /** Shard stage only; null otherwise. */
  index: number | null;
  of: number | null;
  /** Debug sample size of the shard stage; null runs every group. */
  sample: number | null;
  /** Debug group selection of the shard stage; null when not given. */
  groups: string[] | null;
  /** `--deadline-minutes` in milliseconds; null takes the plan's budget (KTD17 default). */
  deadlineMs: number | null;
  /** Absolute path of the baseline report; null when none. */
  baseline: string | null;
  run: RunInfo;
}

const FLAG_OPTIONS = {
  work: { type: 'string' },
  mode: { type: 'string' },
  controls: { type: 'boolean' },
  seed: { type: 'string' },
  shards: { type: 'string' },
  index: { type: 'string' },
  of: { type: 'string' },
  sample: { type: 'string' },
  groups: { type: 'string' },
  'deadline-minutes': { type: 'string' },
  baseline: { type: 'string' },
  'run-id': { type: 'string' },
  'run-attempt': { type: 'string' },
  'run-url': { type: 'string' },
  ref: { type: 'string' },
  'default-branch': { type: 'boolean' },
} as const;

type Flag = keyof typeof FLAG_OPTIONS;

const REPORT_FLAGS: readonly Flag[] = [
  'baseline',
  'run-id',
  'run-attempt',
  'run-url',
  'ref',
  'default-branch',
];
const STAGE_FLAGS: Readonly<Record<Stage, readonly Flag[]>> = {
  plan: ['work', 'mode', 'controls', 'seed', 'shards', 'deadline-minutes'],
  shard: ['work', 'index', 'of', 'sample', 'groups', 'deadline-minutes'],
  'value-flow': ['work'],
  merge: ['work', ...REPORT_FLAGS],
  all: ['work', 'mode', 'controls', 'seed', 'deadline-minutes', ...REPORT_FLAGS],
  controls: ['work', 'seed', 'deadline-minutes', ...REPORT_FLAGS],
};

const isStage = (value: string): value is Stage => (STAGES as readonly string[]).includes(value);

/** A non-negative decimal integer flag value; anything else is a usage error. */
function integerFlag(flag: string, value: string | undefined, minimum: number): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value) || Number(value) < minimum || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`--${flag} must be an integer of at least ${minimum}, got ${value}`);
  }
  return Number(value);
}

/** `--groups a,b`: distinct, non-empty group ids. */
function groupsFlag(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new UsageError(`--groups must list distinct group ids, got ${value}`);
  }
  return ids;
}

function modeOf(stage: Stage, mode: string | undefined, controls: boolean | undefined): RunMode {
  if (mode !== undefined && mode !== 'normal' && mode !== 'controls') {
    throw new UsageError(`--mode must be normal or controls, got ${mode}`);
  }
  if (controls === true && mode === 'normal') {
    throw new UsageError('--controls contradicts --mode normal');
  }
  const kind = stage === 'controls' || controls === true ? 'controls' : (mode ?? 'normal');
  return kind === 'controls'
    ? { kind: 'controls', fixtureRoot: DEFAULT_FIXTURE_ROOT }
    : { kind: 'normal' };
}

/** Parses `<stage> [flags]`; every problem is a {@link UsageError}. */
export function parseCliArgs(argv: readonly string[], cwd: string): CliOptions {
  const [stage, ...rest] = argv;
  if (stage === undefined) throw new UsageError('no stage given');
  if (!isStage(stage)) throw new UsageError(`unknown stage ${JSON.stringify(stage)}`);
  let values: {
    [K in Flag]?: (typeof FLAG_OPTIONS)[K]['type'] extends 'boolean' ? boolean : string;
  };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: FLAG_OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
  const allowed = new Set<string>(STAGE_FLAGS[stage]);
  const misplaced = Object.keys(values).filter((flag) => !allowed.has(flag));
  if (misplaced.length > 0) {
    throw new UsageError(`--${misplaced[0]} does not apply to the ${stage} stage`);
  }
  const index = integerFlag('index', values.index, 0);
  const of = integerFlag('of', values.of, 1);
  if (stage === 'shard' && (index === null || of === null)) {
    throw new UsageError('shard needs --index <i> and --of <n>');
  }
  if (index !== null && of !== null && index >= of) {
    throw new UsageError(`--index ${index} is not below --of ${of}`);
  }
  const deadlineMinutes = integerFlag('deadline-minutes', values['deadline-minutes'], 1);
  const mode = modeOf(stage, values.mode, values.controls);
  const defaultWork = path.join(
    os.tmpdir(),
    mode.kind === 'controls' ? 'gitnexus-scenario-map-controls' : 'gitnexus-scenario-map',
  );
  return {
    stage,
    workDir: path.resolve(cwd, values.work ?? defaultWork),
    mode,
    seed: values.seed ?? DEFAULT_SEED,
    shards: integerFlag('shards', values.shards, 1) ?? 1,
    index,
    of,
    sample: integerFlag('sample', values.sample, 1),
    groups: groupsFlag(values.groups),
    deadlineMs: deadlineMinutes === null ? null : deadlineMinutes * 60_000,
    baseline: values.baseline === undefined ? null : path.resolve(cwd, values.baseline),
    run: {
      id: values['run-id'] ?? 'local',
      attempt: integerFlag('run-attempt', values['run-attempt'], 1) ?? 1,
      url: values['run-url'] ?? null,
      ref: values.ref ?? null,
      defaultBranch: values['default-branch'] === true,
    },
  };
}

// ── Work directory ─────────────────────────────────────────────────────────

export interface WorkLayout {
  root: string;
  plan: string;
  manifest: string;
  layer0: string;
  layer2: string;
  coverageDir: string;
  coverage: string;
  candidates: string;
  planPrepared: string;
  shardReport: (shard: number) => string;
  shardPrepared: (shard: number) => string;
  rowDeletion: (shard: number) => string;
  valueFlow: string;
  pdgDir: string;
  reportJson: string;
  reportMarkdown: string;
  issueBody: string;
}

/** Where each stage keeps its files; see the module comment. */
export function workLayout(root: string): WorkLayout {
  return {
    root,
    plan: path.join(root, 'plan.json'),
    manifest: path.join(root, 'scenario-run-manifest.json'),
    layer0: path.join(root, 'layer0.json'),
    layer2: path.join(root, 'layer2.json'),
    coverageDir: path.join(root, 'coverage'),
    coverage: path.join(root, 'coverage', 'coverage.json'),
    candidates: path.join(root, 'coverage', 'candidates.json'),
    planPrepared: path.join(root, 'plan', 'prepared'),
    shardReport: (shard) => path.join(root, `shard-${shard}.json`),
    shardPrepared: (shard) => path.join(root, `shard-${shard}`, 'prepared'),
    rowDeletion: (shard) => path.join(root, `row-deletion-shard-${shard}.json`),
    valueFlow: path.join(root, 'value-flow.json'),
    pdgDir: path.join(root, 'value-flow', 'pdg'),
    reportJson: path.join(root, 'scenario-map-report.json'),
    reportMarkdown: path.join(root, 'scenario-map-report.md'),
    issueBody: path.join(root, 'issue-body.md'),
  };
}

/** Empties a work directory this CLI created (or an empty one) and marks it. */
function resetWorkDir(root: string): void {
  if (existsSync(root) && readdirSync(root).length > 0) {
    if (!existsSync(path.join(root, WORK_MARKER_FILE))) {
      throw new UsageError(`${root} is not empty and was not created by this tool`);
    }
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, WORK_MARKER_FILE), '');
}

// ── Work files ─────────────────────────────────────────────────────────────

/** Per-group KTD17 inputs and estimate; see {@link estimateScenarioGroup}. */
export interface GroupWork {
  group: string;
  tests: number;
  /** Bytes of the group's whole mutate files. */
  mutatedBytes: number;
  /** Pairs that can reach the repeat stage on plan-time facts. */
  isolationPairs: number;
  /** Their together runs plus one alone run per distinct test. */
  isolationRuns: number;
  /** Sum over those pairs of the mutated bytes either test executed (the universe bound). */
  isolationBytes: number;
  /** Pairs with a planned row deletion, and their control and deletion runs. */
  rowDeletionPairs: number;
  rowDeletionRuns: number;
}

export interface GroupCostBreakdown extends GroupWork {
  mainMs: number;
  rowDeletionMs: number;
  isolationMs: number;
  /** Their sum: the group's `estimateMs` in the shard plan. */
  estimateMs: number;
}

export interface PlanFile {
  schemaVersion: typeof WORK_SCHEMA_VERSION;
  mode: RunMode;
  seed: string;
  eligibility: Eligibility;
  manifestDigest: string;
  costModel: ScenarioCostModel;
  shardPlan: ShardPlan;
  /** Sorted by group. */
  estimates: GroupCostBreakdown[];
  /** Candidate pairs (U4), sorted by `a`, then `b`. */
  pairs: CandidatePair[];
  /** Row-deletion plans of the facet-equal pairs (U9). */
  rowDeletion: RowDeletionPlan[];
  stats: {
    tests: number;
    groups: number;
    pairs: number;
    facetEqualPairs: number;
    wallClockMs: Record<string, number>;
  };
}

/** What later stages read of one test's inventory, checks and facet (U3, U5, U6). */
export interface Layer2Test {
  id: string;
  /** Package path. */
  file: string;
  anchor: TestAnchor | null;
  notOracleValidated: boolean;
  dupeOk: string | null;
  joinProblems: JoinProblem[];
  inventoryUnresolved: string[];
  checksContext: string | null;
  unsupportedForms: UnsupportedForm[];
  unresolvedSelectors: string[];
  facet: InputFacet | null;
}

export interface Layer2File {
  schemaVersion: typeof WORK_SCHEMA_VERSION;
  tests: Layer2Test[];
}

export interface ShardGroupRun {
  group: string;
  /** The main-run batch that ran it; null when it ran alone. */
  batch: string | null;
  status: GroupObservations['status'];
  reason: GroupObservations['reason'];
  /** The run's wall clock: the whole batch's when batched. */
  wallClockMs: number;
  mainEstimateMs: number;
  estimateMs: number;
  mutants: number | null;
  evaluated: number | null;
}

export interface ShardBatchRun {
  id: string;
  groups: string[];
  mainEstimateMs: number;
  status: GroupObservations['status'];
  reason: GroupObservations['reason'];
  wallClockMs: number;
  mutants: number | null;
}

export interface ShardIsolationRun {
  id: string;
  group: string;
  kind: 'together' | 'alone';
  tests: number;
  universe: number;
  status: 'complete' | 'inconclusive';
  reason: string | null;
  estimateMs: number;
  wallClockMs: number;
}

export interface ShardStageReport {
  schemaVersion: typeof WORK_SCHEMA_VERSION;
  shard: number;
  of: number;
  manifestDigest: string;
  /** Null until the copy is verified. */
  manifestCheck: ManifestCheck | null;
  deadlineMs: number;
  /** The debug selection (`--sample`, `--groups`); null when every group ran. */
  sample: { size: number | null; seed: string; groups: string[] } | null;
  /** Main-run batches of more than one group, in run order. */
  batches: ShardBatchRun[];
  groups: {
    ran: ShardGroupRun[];
    notStarted: { group: string; estimateMs: number; elapsedMs: number; owedMs: number }[];
    /** Groups of the shard left out by `--sample` or `--groups`. */
    sampledOut: string[];
  };
  rowDeletion: {
    status: 'none' | 'ran' | 'skipped';
    /** Plans of the complete groups, those with a deletion, and their Vitest runs. */
    pairs: number;
    planned: number;
    runs: number;
    estimateMs: number;
    wallClockMs: number;
  };
  isolation: {
    /** Pairs of complete groups the provisional verdicts call repeat-strong. */
    candidates: number;
    selected: number;
    runs: ShardIsolationRun[];
    skipped: { a: string; b: string; estimateMs: number; elapsedMs: number }[];
  };
  finished: boolean;
  wallClockMs: number;
}

export interface RowDeletionFile {
  schemaVersion: typeof WORK_SCHEMA_VERSION;
  shard: number;
  manifestDigest: string;
  results: RowDeletionResult[];
}

export interface ValueFlowFile {
  schemaVersion: typeof WORK_SCHEMA_VERSION;
  manifestDigest: string;
  pairs: { facetEqual: number; valueDiffering: number };
  pdg: {
    status: 'indexed' | 'failed' | 'skipped';
    detail: string | null;
    indexPrefix: string;
    wallClockMs: number;
  };
  staticValueFlow: StaticValueFlowRun;
  trace: TraceRunResult;
  wallClockMs: Record<string, number>;
}

const versioned = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.schemaVersion === WORK_SCHEMA_VERSION;

const isPlanFile = (value: unknown): value is PlanFile =>
  versioned(value) &&
  isRecord(value.mode) &&
  isRecord(value.shardPlan) &&
  Array.isArray(value.pairs) &&
  Array.isArray(value.estimates) &&
  Array.isArray(value.rowDeletion) &&
  typeof value.manifestDigest === 'string';

const isLayer2File = (value: unknown): value is Layer2File =>
  versioned(value) && Array.isArray(value.tests);

const isShardStageReport = (value: unknown): value is ShardStageReport =>
  versioned(value) &&
  typeof value.shard === 'number' &&
  isRecord(value.groups) &&
  isRecord(value.rowDeletion) &&
  isRecord(value.isolation);

const isRowDeletionFile = (value: unknown): value is RowDeletionFile =>
  versioned(value) && Array.isArray(value.results) && typeof value.manifestDigest === 'string';

const isValueFlowFile = (value: unknown): value is ValueFlowFile =>
  versioned(value) &&
  isRecord(value.staticValueFlow) &&
  isRecord(value.trace) &&
  typeof value.manifestDigest === 'string';

function readWork<T>(file: string, what: string, check: (value: unknown) => value is T): T {
  if (!existsSync(file)) throw new UsageError(`${file} is missing: run the plan stage first`);
  const data = readJsonFile(file);
  if (!check(data)) throw new Error(`${file} is not a scenario-map ${what} file`);
  return data;
}

/** An optional work file: null when absent or not of the expected shape. */
function readOptional<T>(file: string, check: (value: unknown) => value is T): T | null {
  if (!existsSync(file)) return null;
  try {
    const data = readJsonFile(file);
    return check(data) ? data : null;
  } catch {
    return null;
  }
}

// ── Cost model and shard plan (KTD17, D9, D10) ─────────────────────────────

/** One group's estimate; see the module comment and {@link ScenarioCostModel}. */
export function estimateScenarioGroup(
  work: GroupWork,
  model: Readonly<ScenarioCostModel> = SCENARIO_COST_MODEL,
): GroupCostBreakdown {
  const mainMs = Math.ceil(model.perRunMs + work.mutatedBytes * work.tests * model.perByteTestMs);
  const rowDeletionMs = Math.ceil(work.rowDeletionRuns * model.rowDeletionRunMs);
  const isolationMs = Math.ceil(
    work.isolationRuns * model.isolationRunMs +
      work.isolationBytes * model.mutantsPerByte * ISOLATION_RUNS * model.freshProcessMs,
  );
  return {
    ...work,
    mainMs,
    rowDeletionMs,
    isolationMs,
    estimateMs: mainMs + rowDeletionMs + isolationMs,
  };
}

export interface ShardPlanningInput {
  scopes: readonly GroupScope[];
  pairs: readonly CandidatePair[];
  /** Whether a pair can reach the repeat stage on plan-time facts. */
  potentialRepeat: (pair: CandidatePair) => boolean;
  /** Repo paths a test executed (Layer 1); null when its provenance is unknown. */
  executedFiles: (test: string) => readonly string[] | null;
  rowDeletion: readonly RowDeletionPlan[];
  sizeOf: (repoPath: string) => number;
  shards: number;
  budgetMs: number;
  model: Readonly<ScenarioCostModel>;
}

/** Each group's estimate and the KTD17 packing over them; pure given `sizeOf`. */
export function planShards(input: ShardPlanningInput): {
  shardPlan: ShardPlan;
  estimates: GroupCostBreakdown[];
} {
  const pairsByGroup = new Map<string, CandidatePair[]>();
  for (const pair of input.pairs) {
    pairsByGroup.set(pair.group, [...(pairsByGroup.get(pair.group) ?? []), pair]);
  }
  const rowPlans = new Map(input.rowDeletion.map((plan) => [pairKey(plan.a, plan.b), plan]));
  const scopes = [...input.scopes].sort((x, y) => byText(x.id, y.id));
  const estimates = scopes.map((scope): GroupCostBreakdown => {
    const mutate = new Set(scope.mutate);
    const bytesOf = (files: readonly string[]): number => sum(files.map(input.sizeOf));
    const mutatedBytes = bytesOf(scope.mutate);
    const pairs = pairsByGroup.get(scope.id) ?? [];
    const potential = pairs.filter(input.potentialRepeat);
    const universeBytes = (pair: CandidatePair): number => {
      const [a, b] = [input.executedFiles(pair.a), input.executedFiles(pair.b)];
      if (a === null || b === null) return mutatedBytes;
      return bytesOf(sortedUnique([...a, ...b]).filter((file) => mutate.has(file)));
    };
    const planned = pairs.flatMap((pair) => {
      const plan = rowPlans.get(pairKey(pair.a, pair.b));
      return plan !== undefined && plan.deletions.length > 0 ? [plan] : [];
    });
    return estimateScenarioGroup(
      {
        group: scope.id,
        tests: scope.tests.length,
        mutatedBytes,
        isolationPairs: potential.length,
        isolationRuns: potential.length + new Set(potential.flatMap((p) => [p.a, p.b])).size,
        isolationBytes: sum(potential.map(universeBytes)),
        rowDeletionPairs: planned.length,
        rowDeletionRuns: sum(planned.map((plan) => 1 + plan.deletions.length)),
      },
      input.model,
    );
  });
  const groups = scopes.map(
    (scope, i): PlannedGroup => ({
      ...scope,
      mutatedBytes: estimates[i].mutatedBytes,
      estimateMs: estimates[i].estimateMs,
    }),
  );
  return {
    shardPlan: {
      schemaVersion: SHARD_PLAN_SCHEMA_VERSION,
      budgetMs: input.budgetMs,
      costModel: { ...input.model },
      groups,
      ...packShards(groups, input.shards, input.budgetMs),
    },
    estimates,
  };
}

/** `size` of `ids`, by ascending sha256 of the seed and the id, returned in input order. */
export function sampleGroups(ids: readonly string[], size: number, seed: string): string[] {
  const picked = new Set(
    [...ids]
      .map((id) => ({ id, rank: sha256(`${seed}\u0000${id}`) }))
      .sort((x, y) => byText(x.rank, y.rank) || byText(x.id, y.id))
      .slice(0, size)
      .map((entry) => entry.id),
  );
  return ids.filter((id) => picked.has(id));
}

// ── Verdict input (U12) ────────────────────────────────────────────────────

/** Each pair's stage results by {@link pairKey}; null where a stage did not run. */
export interface StageLookups {
  isolation: (key: string) => VerdictPairInput['isolation'];
  rowDeletion: (key: string) => VerdictPairInput['rowDeletion'];
  staticValueFlow: (key: string) => VerdictPairInput['staticValueFlow'];
  trace: (key: string) => VerdictPairInput['trace'];
}

export interface VerdictAssembly {
  work: Pick<CoverageWorkFile, 'tests'>;
  layer2: readonly Layer2Test[];
  scopes: readonly Pick<GroupScope, 'excluded'>[];
  pairs: readonly CandidatePair[];
  schedules: readonly PairSchedule[];
  stages: StageLookups;
  observations: readonly MergedObservation[];
  degraded: VerdictInput['valueFlowDegraded'];
  /** Only these tests (default every test of the work file). */
  tests?: ReadonlySet<string>;
}

/** The verdict engine's input from the stage artifacts (pattern of the U12 controls driver). */
export function assembleVerdictInput(input: VerdictAssembly): VerdictInput {
  const records = new Map(input.layer2.map((test) => [test.id, test]));
  const excluded = new Map<string, string[]>();
  for (const scope of input.scopes) {
    for (const entry of scope.excluded) excluded.set(entry.test, entry.files);
  }
  const schedules = new Map(input.schedules.map((entry) => [pairKey(entry.a, entry.b), entry]));
  const tests = input.work.tests
    .filter((test) => input.tests === undefined || input.tests.has(test.id))
    .map((test): VerdictTestInput => {
      const record = records.get(test.id);
      if (record === undefined) throw new Error(`layer2.json has no record of ${test.id}`);
      return {
        id: test.id,
        eligible: true,
        notOracleValidated: record.notOracleValidated,
        dupeOk: record.dupeOk,
        joinProblems: record.joinProblems,
        inventoryUnresolved: record.inventoryUnresolved,
        provenance: test.provenance,
        concurrent: test.concurrent,
        excludedFiles: excluded.get(test.id) ?? [],
        checksContext: record.checksContext,
        unsupportedForms: record.unsupportedForms,
        unresolvedSelectors: record.unresolvedSelectors,
        facet: record.facet,
      };
    });
  const pairs = input.pairs.map((pair): VerdictPairInput => {
    const key = pairKey(pair.a, pair.b);
    const schedule = schedules.get(key);
    if (schedule === undefined) throw new Error(`no schedule for the pair ${key}`);
    return {
      a: pair.a,
      b: pair.b,
      group: pair.group,
      identicalBlocks: pair.identicalBlocks,
      pathUnattributable: pair.pathUnattributable,
      schedule,
      isolation: input.stages.isolation(key),
      rowDeletion: input.stages.rowDeletion(key),
      staticValueFlow: input.stages.staticValueFlow(key),
      trace: input.stages.trace(key),
    };
  });
  return {
    tests,
    pairs,
    observations: input.observations,
    valueFlowDegraded: input.degraded,
  };
}

/** The best case of every stage still to come (D9): what the provisional verdicts assume. */
const BEST_ISOLATION: VerdictPairInput['isolation'] = {
  status: 'agrees',
  reason: null,
  disqualifiers: [],
};
const BEST_STATIC: VerdictPairInput['staticValueFlow'] = { status: 'clean', reasons: [] };
const BEST_TRACE: VerdictPairInput['trace'] = { status: 'clean', reasons: [] };

function layer2Maps(tests: readonly Layer2Test[]): {
  facets: Map<string, InputFacet>;
  checksContext: Map<string, string | null>;
} {
  return {
    facets: new Map(
      tests.flatMap((test): [string, InputFacet][] =>
        test.facet === null ? [] : [[test.id, test.facet]],
      ),
    ),
    checksContext: new Map(tests.map((test) => [test.id, test.checksContext])),
  };
}

// ── Stage context ──────────────────────────────────────────────────────────

export interface StageContext {
  /** Absolute repo checkout. */
  repoRoot: string;
  /** Absolute `gitnexus/` package directory. */
  packageDir: string;
  layout: WorkLayout;
  log: (line: string) => void;
  /** Milliseconds on a monotonic clock. */
  now: () => number;
  /** The checkout's commit; null when unknown. */
  sourceRevision: () => string | null;
}

const runtimeRecordsOf = (
  tests: readonly CoverageTest[],
): { file: string; taskId: string; fullName: string; location: CoverageTest['location'] }[] =>
  tests.map(({ file, taskId, fullName, location }) => ({ file, taskId, fullName, location }));

/** The runtime join of every test of the given files (U3). */
function joinFiles(
  repoRoot: string,
  tests: readonly CoverageTest[],
  files: readonly string[],
): InventoryInstance[] {
  const wanted = new Set(files);
  return joinRuntime(
    loadStaticInventory(repoRoot, files),
    runtimeRecordsOf(tests.filter((test) => wanted.has(test.file))).map((record) => ({
      ...record,
      location: record.location ?? undefined,
    })),
  ).instances;
}

// ── Plan stage ─────────────────────────────────────────────────────────────

/** The test-dupes `--json` report over the `--all` corpus, findings on eligible files kept. */
export function scanLayer0(repoRoot: string, eligibleFiles: readonly string[]): unknown {
  const listed = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
    .split('\n')
    .filter(Boolean);
  const eligible = new Set(eligibleFiles.map(fromPackagePath));
  const files = sortedUnique([...listed.filter(isTestSupportFile), ...eligible]).flatMap(
    (file): SourceFile[] => {
      try {
        return [{ path: file, source: readFileSync(path.join(repoRoot, file), 'utf8') }];
      } catch {
        return []; // deleted in the working tree but still in the index
      }
    },
  );
  const { findings, skipped } = scan(files, null);
  return {
    version: 1,
    base: null,
    all: true,
    scanned: files.length,
    skipped: skipped.filter((file) => eligible.has(file)),
    findings: findings
      .filter((finding) => eligible.has(finding.file))
      .sort((x, y) => byText(x.file, y.file) || x.line - y.line),
  };
}

interface Layer2Run {
  tests: Layer2Test[];
  facetContext: FacetContext;
  subjects: Map<string, FacetSubject>;
}

async function computeLayer2(repoRoot: string, work: CoverageWorkFile): Promise<Layer2Run> {
  const files = sortedUnique(work.tests.map((test) => test.file));
  const instances = joinFiles(repoRoot, work.tests, files);
  const checkOptions = {
    snapshots: fsSnapshotReader(repoRoot),
    modules: fsModuleReader(repoRoot),
  };
  const facetContext = createRunFacetContext({
    repoRoot,
    extraRoots: work.extraRoots,
    testFiles: files,
  });
  const provenance = new Map(work.tests.map((test) => [test.id, test.provenance]));
  const subjects = new Map<string, FacetSubject>();
  const tests: Layer2Test[] = [];
  for (const instance of instances) {
    const checkSubject = subjectOf(instance);
    const checks = checkSubject === null ? null : computeChecks(checkSubject, checkOptions);
    const facetSubject = facetSubjectOf(instance, provenance.get(instance.id) ?? null);
    if (facetSubject !== null) subjects.set(instance.id, facetSubject);
    tests.push({
      id: instance.id,
      file: instance.file,
      anchor: instance.anchor,
      notOracleValidated: instance.notOracleValidated,
      dupeOk: instance.dupeOk,
      joinProblems: instance.unsupported,
      inventoryUnresolved: instance.unresolved,
      checksContext: checksContextKey(instance, checkOptions),
      unsupportedForms: checks?.unsupported ?? [],
      unresolvedSelectors: checks?.unresolved ?? [],
      facet: facetSubject === null ? null : await computeFacet(facetSubject, facetContext),
    });
  }
  return { tests, facetContext, subjects };
}

/** Facet-equal: both facets known with the same fingerprint (residual differences included). */
const facetEqual = (facets: ReadonlyMap<string, InputFacet>, pair: CandidatePair): boolean => {
  const [a, b] = [facets.get(pair.a), facets.get(pair.b)];
  return a !== undefined && b !== undefined && a.fingerprint === b.fingerprint;
};

export interface PlanStageOptions {
  mode: RunMode;
  seed: string;
  shards: number;
  budgetMs: number;
}

/** The plan stage; see the module comment. */
export async function runPlanStage(
  ctx: StageContext,
  options: PlanStageOptions,
): Promise<PlanFile> {
  const { repoRoot, layout, log } = ctx;
  const wallClockMs: Record<string, number> = {};
  const timed = async <T>(name: string, step: () => T | Promise<T>): Promise<T> => {
    const started = ctx.now();
    const result = await step();
    wallClockMs[name] = Math.round(ctx.now() - started);
    log(`plan: ${name} ${minutes(wallClockMs[name])}`);
    return result;
  };
  resetWorkDir(layout.root);
  const eligibility = await timed('eligibility', () =>
    resolveEligibility({ repoRoot, mode: options.mode }),
  );
  if (eligibility.files.length === 0) throw new UsageError('no eligible test files');
  log(`plan: ${eligibility.files.length} eligible test files (${options.mode.kind} mode)`);
  const layer0 = await timed('layer 0', () => {
    try {
      return scanLayer0(repoRoot, eligibility.files);
    } catch (error) {
      log(`plan: layer 0 scan did not run: ${errorMessage(error)}`);
      return null;
    }
  });
  writeJson(layout.layer0, layer0);

  // The run manifest is hashed right after prepare; its test list follows Layer 1 (the digest
  // covers the files and tool versions only).
  const snapshot = await timed('prepare', () => {
    prepare({
      repoRoot,
      outDir: layout.planPrepared,
      mutate: [],
      pathMap: buildPathMap(eligibility.extraRoots),
    });
    return buildRunManifest({ preparedRoot: layout.planPrepared, mode: options.mode, tests: [] });
  });
  const { work } = await timed('layer 1', () =>
    runCoverage({ repoRoot, outDir: layout.coverageDir, mode: options.mode }),
  );
  const ids = sortedUnique(work.tests.map((test) => test.id));
  const manifest: ScenarioRunManifest = {
    ...snapshot,
    tests: ids.map((id) => ({ id, file: parseTestId(id).file })),
  };
  writeScenarioRunManifest(layout.root, manifest);

  const layer2 = await timed('layer 2', () => computeLayer2(repoRoot, work));
  const { facets, checksContext } = layer2Maps(layer2.tests);
  const candidates = await timed('candidates', () =>
    findCandidates(candidateTestsOf(work, checksContext)),
  );
  writeJson(layout.candidates, { schemaVersion: WORK_FILE_SCHEMA_VERSION, ...candidates });

  const scopes = await timed('scopes', () => {
    const files = sortedUnique(work.tests.map((test) => test.file));
    const verdicts = classify({ repoRoot, testFiles: files }).files;
    const closures = new Map(
      verdicts.map((verdict) => [
        verdict.file,
        { closure: verdict.closure, complete: verdict.status === 'accepted' },
      ]),
    );
    const provenance = new Map(work.tests.map((test) => [test.id, test.provenance]));
    return candidates.groups.map((group) =>
      groupScope({ group, provenance, closures, extraRoots: eligibility.extraRoots }),
    );
  });

  const sources = fsFacetSources(repoRoot);
  const equalPairs = candidates.pairs.filter((pair) => facetEqual(facets, pair));
  const rowDeletion = await timed('row-deletion plans', () =>
    equalPairs.flatMap((pair): RowDeletionPlan[] => {
      const [fa, fb] = [facets.get(pair.a), facets.get(pair.b)];
      const [sa, sb] = [layer2.subjects.get(pair.a), layer2.subjects.get(pair.b)];
      if (fa === undefined || fb === undefined || sa === undefined || sb === undefined) return [];
      return [
        planRowDeletion(
          {
            a: pair.a,
            b: pair.b,
            facets: [fa, fb],
            search: pairTableSearch(layer2.facetContext, [sa, sb]),
          },
          { tables: layer2.facetContext.tables, read: (file) => sources.read(file) },
        ),
      ];
    }),
  );

  const executed = new Map(
    work.tests.map((test) => [
      test.id,
      test.provenance.known ? test.provenance.executedFiles : null,
    ]),
  );
  // The verdict engine lists every weak disqualifier even for an unscheduled pair: a pair with one
  // that no later stage can lift (anything but the hook stratum, which needs the runs) never
  // reaches isolation, so it adds no isolation cost to the estimate.
  const rowPlans = new Map(rowDeletion.map((entry) => [pairKey(entry.a, entry.b), entry]));
  const planTime = computeVerdicts(
    assembleVerdictInput({
      work,
      layer2: layer2.tests,
      scopes,
      pairs: candidates.pairs,
      schedules: candidates.pairs.map(
        (pair): PairSchedule => ({
          ...pair,
          status: 'inconclusive',
          reason: 'not-scheduled',
          shard: null,
          detail: null,
        }),
      ),
      stages: {
        isolation: () => BEST_ISOLATION,
        rowDeletion: (key) => {
          const entry = rowPlans.get(key);
          if (entry === undefined) return null;
          return entry.status === 'inconclusive'
            ? { outcome: 'inconclusive', reasons: entry.reasons }
            : { outcome: entry.status === 'planned' ? 'symmetric' : 'not-applicable', reasons: [] };
        },
        staticValueFlow: () => BEST_STATIC,
        trace: () => BEST_TRACE,
      },
      observations: [],
      degraded: [],
    }),
  );
  const strongCapable = new Set(
    [...planTime.pairs, ...planTime.kept]
      .filter((verdict) => verdict.disqualifiers.every((entry) => entry.kind === 'hook-stratum'))
      .map((verdict) => pairKey(verdict.a, verdict.b)),
  );
  const { shardPlan, estimates } = planShards({
    scopes,
    pairs: candidates.pairs,
    potentialRepeat: (pair) => {
      const keys = [checksContext.get(pair.a), checksContext.get(pair.b)];
      const [fa, fb] = [facets.get(pair.a), facets.get(pair.b)];
      return (
        strongCapable.has(pairKey(pair.a, pair.b)) &&
        typeof keys[0] === 'string' &&
        keys[0] === keys[1] &&
        fa !== undefined &&
        fb !== undefined &&
        fa.fingerprint === fb.fingerprint &&
        residualDifference(fa, fb).length === 0
      );
    },
    executedFiles: (test) => executed.get(test) ?? null,
    rowDeletion,
    sizeOf: (file) => {
      try {
        return statSync(path.join(repoRoot, file)).size;
      } catch {
        return 0;
      }
    },
    shards: options.shards,
    budgetMs: options.budgetMs,
    model: SCENARIO_COST_MODEL,
  });

  const plan: PlanFile = {
    schemaVersion: WORK_SCHEMA_VERSION,
    mode: options.mode,
    seed: options.seed,
    eligibility,
    manifestDigest: manifest.digest,
    costModel: { ...SCENARIO_COST_MODEL },
    shardPlan,
    estimates,
    pairs: candidates.pairs,
    rowDeletion,
    stats: {
      tests: work.tests.length,
      groups: candidates.groups.length,
      pairs: candidates.pairs.length,
      facetEqualPairs: equalPairs.length,
      wallClockMs,
    },
  };
  writeJson(layout.layer2, { schemaVersion: WORK_SCHEMA_VERSION, tests: layer2.tests });
  writeJson(layout.plan, plan);
  log(
    `plan: ${work.tests.length} tests, ${candidates.pairs.length} candidate pairs ` +
      `(${equalPairs.length} facet-equal) in ${candidates.groups.length} groups; ` +
      `${rowDeletion.filter((entry) => entry.deletions.length > 0).length} pairs with a planned ` +
      `row deletion; ${shardPlan.overBudget.length} groups over budget`,
  );
  for (const shard of shardPlan.shards) {
    log(`plan: shard ${shard.index}: ${shard.groups.length} groups, ${minutes(shard.estimateMs)}`);
  }
  return plan;
}

// ── Main-run batches ───────────────────────────────────────────────────────

/**
 * One batch's budget: consecutive groups share a main run while `perRunMs` once plus each
 * member's main estimate above it stays within it. A larger batch amortises more fixed overhead
 * (two baselines, the scope driver's prepare, Stryker's start and dry run: about 1.5 min per run,
 * U14 measured slice) but risks more work at the deadline and on a fallback.
 */
export const BATCH_BUDGET_MS = 30 * 60_000;

export interface MainBatch {
  /** The group id of a single group; else `b` + 16 hex digits of sha1 over the member ids. */
  id: string;
  /** Member group ids, in plan order. */
  groups: string[];
  mainMs: number;
}

/**
 * Batches the groups of a shard, in plan order of their first member; see {@link BATCH_BUDGET_MS}.
 * A group with an empty mutate scope runs alone (the scope driver refuses it), and so does a
 * group whose own estimate exceeds the budget.
 */
export function batchGroups(
  groups: readonly { id: string; mainMs: number; mutate: number }[],
  perRunMs: number,
  budgetMs: number = BATCH_BUDGET_MS,
): MainBatch[] {
  const batches: { groups: string[]; mainMs: number }[] = [];
  let open: { groups: string[]; mainMs: number } | null = null;
  for (const group of groups) {
    if (group.mutate === 0) {
      batches.push({ groups: [group.id], mainMs: group.mainMs });
      continue;
    }
    const extra = Math.max(0, group.mainMs - perRunMs);
    if (open !== null && open.mainMs + extra <= budgetMs) {
      open.groups.push(group.id);
      open.mainMs += extra;
      continue;
    }
    open = { groups: [group.id], mainMs: group.mainMs };
    batches.push(open);
  }
  return batches.map((batch) => ({
    id:
      batch.groups.length === 1
        ? batch.groups[0]
        : `b${createHash('sha1').update(batch.groups.join('\n')).digest('hex').slice(0, 16)}`,
    groups: batch.groups,
    mainMs: batch.mainMs,
  }));
}

const scopeOnly = (scope: GroupScope): GroupScope => ({
  id: scope.id,
  tests: scope.tests,
  testFiles: scope.testFiles,
  pairs: scope.pairs,
  mutate: scope.mutate,
  excluded: scope.excluded,
  closureIncomplete: scope.closureIncomplete,
  provenanceUnknown: scope.provenanceUnknown,
});

/** The KTD7 scope of a batch: the union of its members' tests, files and marks. */
export function batchScope(id: string, members: readonly GroupScope[]): GroupScope {
  return {
    id,
    tests: sortedUnique(members.flatMap((member) => member.tests)),
    testFiles: sortedUnique(members.flatMap((member) => member.testFiles)),
    pairs: sum(members.map((member) => member.pairs)),
    mutate: sortedUnique(members.flatMap((member) => member.mutate)),
    excluded: members.flatMap((member) => member.excluded).sort((x, y) => byText(x.test, y.test)),
    closureIncomplete: sortedUnique(members.flatMap((member) => member.closureIncomplete)),
    provenanceUnknown: sortedUnique(members.flatMap((member) => member.provenanceUnknown)),
  };
}

/** A group result that names the main-run batch it came from. */
export interface BatchedGroupObservations extends GroupObservations {
  batch: { id: string; groups: string[] };
}

/**
 * Splits a batch's result into one result per member: the member's own tests' observations of
 * its own mutate files (KTD7), relabelled with its group id, so its universe, kill sets and path
 * are those of its own scope; status, baselines and the Stryker summary are the batch's.
 */
export function splitBatchResult(
  result: GroupObservations,
  members: readonly GroupScope[],
): BatchedGroupObservations[] {
  const ids = members.map((member) => member.id);
  return members.map((member) => {
    const tests = new Set(member.tests);
    const files = new Set(member.mutate);
    return {
      ...result,
      group: member.id,
      tests: [...member.tests],
      scope: scopeOnly(member),
      observations: result.observations
        .filter((entry) => tests.has(entry.test) && files.has(entry.file))
        .map((entry) => ({ ...entry, group: member.id })),
      batch: { id: result.group, groups: ids },
    };
  });
}

// ── Shard stage ────────────────────────────────────────────────────────────

/** A group result for a shard whose copy does not match the run manifest (KTD14). */
function writeMismatchResult(
  workDir: string,
  group: PlannedGroup,
  shard: number,
  manifest: ScenarioRunManifest,
  mismatches: readonly string[],
): void {
  const result: GroupObservations = {
    schemaVersion: GROUP_OBSERVATIONS_SCHEMA_VERSION,
    group: group.id,
    shard,
    manifestDigest: manifest.digest,
    status: 'inconclusive',
    reason: 'manifest-mismatch',
    detail: `the prepared copy differs from the run manifest: ${mismatches.join('; ')}`,
    tests: [...group.tests],
    scope: scopeOnly(group),
    baselines: [],
    stryker: null,
    observations: [],
    wallClockMs: 0,
  };
  writeJson(observationsFile(workDir, group.id), result);
}

export interface ShardStageOptions {
  index: number;
  of: number;
  sample: number | null;
  groups: string[] | null;
  /** Null takes the plan's budget. */
  deadlineMs: number | null;
}

/** Whether a shard report shows every planned piece of its work done. */
export function shardIssues(report: ShardStageReport | null): string[] {
  if (report === null) return ['no shard result'];
  if (report.manifestCheck !== null && !report.manifestCheck.ok) {
    return ['its prepared copy differs from the run manifest'];
  }
  const issues: string[] = [];
  if (!report.finished) issues.push('the shard did not finish');
  if (report.groups.notStarted.length > 0) {
    issues.push(`${report.groups.notStarted.length} groups not started before the deadline`);
  }
  if (report.groups.sampledOut.length > 0) {
    issues.push(`${report.groups.sampledOut.length} groups left out by --sample or --groups`);
  }
  if (report.rowDeletion.status === 'skipped')
    issues.push('row deletion not run before the deadline');
  if (report.isolation.skipped.length > 0) {
    issues.push(`${report.isolation.skipped.length} pairs not isolated before the deadline`);
  }
  return issues;
}

/** The shard stage; see the module comment. */
export async function runShardStage(
  ctx: StageContext,
  options: ShardStageOptions,
): Promise<ShardStageReport> {
  const { repoRoot, layout, log } = ctx;
  const started = ctx.now();
  const elapsed = (): number => ctx.now() - started;
  const plan = readWork(layout.plan, 'plan', isPlanFile);
  const shardCount = plan.shardPlan.shards.length;
  if (options.of !== shardCount) {
    throw new UsageError(`--of ${options.of}: the plan has ${shardCount} shard(s)`);
  }
  const manifest = readScenarioRunManifest(layout.manifest);
  if (manifest.digest !== plan.manifestDigest) {
    throw new Error(`${layout.manifest} is not the run manifest of ${layout.plan}`);
  }
  const work = readWorkFile(layout.coverage);
  const layer2 = readWork(layout.layer2, 'layer 2', isLayer2File);
  const model = plan.costModel;
  const deadlineMs = options.deadlineMs ?? plan.shardPlan.budgetMs;
  const shard = options.index;
  const assignment = plan.shardPlan.shards.find((entry) => entry.index === shard);
  if (assignment === undefined) throw new UsageError(`the plan has no shard ${shard}`);
  const unknown = (options.groups ?? []).filter((id) => !assignment.groups.includes(id));
  if (unknown.length > 0)
    throw new UsageError(`--groups: not in shard ${shard}: ${unknown.join(', ')}`);
  const sampled = new Set(
    options.sample === null ? [] : sampleGroups(assignment.groups, options.sample, plan.seed),
  );
  const chosen = new Set([...sampled, ...(options.groups ?? [])]);
  const selected = options.sample !== null || options.groups !== null;
  const toRun = selected ? assignment.groups.filter((id) => chosen.has(id)) : assignment.groups;
  const planned = new Map(plan.shardPlan.groups.map((group) => [group.id, group]));
  const estimates = new Map(plan.estimates.map((entry) => [entry.group, entry]));

  // Results left by an earlier run of this shard would read as this run's.
  for (const group of assignment.groups) {
    rmSync(observationsFile(layout.root, group), { force: true });
    rmSync(path.join(layout.root, 'isolation', group), { recursive: true, force: true });
  }
  rmSync(layout.rowDeletion(shard), { force: true });
  const report: ShardStageReport = {
    schemaVersion: WORK_SCHEMA_VERSION,
    shard,
    of: options.of,
    manifestDigest: manifest.digest,
    manifestCheck: null,
    deadlineMs,
    batches: [],
    sample: selected
      ? { size: options.sample, seed: plan.seed, groups: options.groups ?? [] }
      : null,
    groups: {
      ran: [],
      notStarted: [],
      sampledOut: assignment.groups.filter((group) => !toRun.includes(group)),
    },
    rowDeletion: { status: 'none', pairs: 0, planned: 0, runs: 0, estimateMs: 0, wallClockMs: 0 },
    isolation: { candidates: 0, selected: 0, runs: [], skipped: [] },
    finished: false,
    wallClockMs: 0,
  };
  const save = (): void => {
    report.wallClockMs = Math.round(elapsed());
    writeJson(layout.shardReport(shard), report);
  };
  save();

  const preparedRoot = layout.shardPrepared(shard);
  prepare({
    repoRoot,
    outDir: preparedRoot,
    mutate: [],
    pathMap: buildPathMap(extraRootsOf(manifest.mode)),
  });
  report.manifestCheck = verifyPreparedCopy(manifest, preparedRoot);
  if (!report.manifestCheck.ok) {
    for (const id of toRun) {
      const group = planned.get(id);
      if (group !== undefined) {
        writeMismatchResult(layout.root, group, shard, manifest, report.manifestCheck.mismatches);
      }
    }
    report.finished = true;
    save();
    log(`shard ${shard}: manifest mismatch: ${report.manifestCheck.mismatches.join('; ')}`);
    return report;
  }
  const packageDir = path.join(preparedRoot, PACKAGE_DIR);
  log(
    `shard ${shard}: ${toRun.length} of ${assignment.groups.length} groups; deadline ${minutes(deadlineMs)}`,
  );

  // Main runs (U7) in batches, each started only when it fits with the deferred work still owed
  // (KTD17).
  let owedMs = 0;
  let batchReserved = false;
  const results: GroupObservations[] = [];
  const groupOf = (id: string): PlannedGroup => {
    const group = planned.get(id);
    if (group === undefined) throw new Error(`group ${id} of shard ${shard} is not in the plan`);
    return group;
  };
  const estimateOf = (id: string): GroupCostBreakdown => {
    const estimate = estimates.get(id);
    if (estimate === undefined) throw new Error(`group ${id} of shard ${shard} has no estimate`);
    return estimate;
  };
  const record = (result: GroupObservations, batch: string | null, wallClockMs: number): void => {
    const estimate = estimateOf(result.group);
    results.push(result);
    report.groups.ran.push({
      group: result.group,
      batch,
      status: result.status,
      reason: result.reason,
      wallClockMs,
      mainEstimateMs: estimate.mainMs,
      estimateMs: estimate.estimateMs,
      mutants: result.stryker?.mutants ?? null,
      evaluated: result.stryker?.evaluated ?? null,
    });
    save();
  };
  const runAlone = async (id: string): Promise<void> => {
    const group = groupOf(id);
    log(
      `shard ${shard}: group ${id}: ${group.tests.length} tests, ${group.pairs} pairs, ` +
        `${group.mutate.length} files; main run estimated at ${minutes(estimateOf(id).mainMs)}`,
    );
    const result = await runGroup({
      repoRoot,
      workDir: layout.root,
      shard,
      manifest,
      packageDir,
      scope: group,
    });
    record(result, null, result.wallClockMs);
    log(
      `shard ${shard}: group ${id}: ${result.status}${result.reason === null ? '' : ` (${result.reason})`} ` +
        `in ${minutes(result.wallClockMs)}; ${result.stryker?.mutants ?? 0} mutants`,
    );
  };
  const notStarted = (id: string, at: number): void => {
    report.groups.notStarted.push({
      group: id,
      estimateMs: estimateOf(id).estimateMs,
      elapsedMs: Math.round(at),
      owedMs,
    });
    save();
    log(`shard ${shard}: group ${id} not started (estimate ${minutes(estimateOf(id).estimateMs)})`);
  };
  const batches = batchGroups(
    toRun.map((id) => ({
      id,
      mainMs: estimateOf(id).mainMs,
      mutate: groupOf(id).mutate.length,
    })),
    model.perRunMs,
  );
  for (const batch of batches) {
    const members = batch.groups.map(groupOf);
    const deferred = sum(
      batch.groups.map((id) => estimateOf(id).rowDeletionMs + estimateOf(id).isolationMs),
    );
    const reserve =
      !batchReserved && batch.groups.some((id) => estimateOf(id).rowDeletionRuns > 0)
        ? model.rowDeletionBatchMs
        : 0;
    const at = elapsed();
    if (!fitsBeforeDeadline(batch.mainMs + deferred + reserve, at + owedMs, deadlineMs)) {
      for (const id of batch.groups) notStarted(id, at);
      continue;
    }
    owedMs += deferred + reserve;
    batchReserved ||= reserve > 0;
    if (members.length === 1) {
      await runAlone(batch.id);
      continue;
    }
    log(
      `shard ${shard}: batch ${batch.id}: ${members.length} groups, ` +
        `${sum(members.map((member) => member.tests.length))} tests; main run estimated at ` +
        `${minutes(batch.mainMs)}`,
    );
    const result = await runGroup({
      repoRoot,
      workDir: layout.root,
      shard,
      manifest,
      packageDir,
      scope: batchScope(batch.id, members),
    });
    const batchFile = path.join(layout.root, 'batches', `${batch.id}.json`);
    mkdirSync(path.dirname(batchFile), { recursive: true });
    renameSync(observationsFile(layout.root, batch.id), batchFile);
    report.batches.push({
      id: batch.id,
      groups: batch.groups,
      mainEstimateMs: batch.mainMs,
      status: result.status,
      reason: result.reason,
      wallClockMs: result.wallClockMs,
      mutants: result.stryker?.mutants ?? null,
    });
    log(
      `shard ${shard}: batch ${batch.id}: ${result.status}${result.reason === null ? '' : ` (${result.reason})`} ` +
        `in ${minutes(result.wallClockMs)}; ${result.stryker?.mutants ?? 0} mutants`,
    );
    if (result.status === 'complete') {
      for (const split of splitBatchResult(result, members)) {
        writeJson(observationsFile(layout.root, split.group), split);
        record(split, batch.id, result.wallClockMs);
      }
      continue;
    }
    // One test must not make the other groups Inconclusive: re-run the members one by one.
    for (const id of batch.groups) {
      const now = elapsed();
      if (fitsBeforeDeadline(estimateOf(id).mainMs, now + owedMs, deadlineMs)) await runAlone(id);
      else notStarted(id, now);
    }
  }

  // One row-deletion batch for the pairs of the complete groups (U9, D10).
  const complete = new Set(results.filter((r) => r.status === 'complete').map((r) => r.group));
  const groupOfPair = new Map(plan.pairs.map((pair) => [pairKey(pair.a, pair.b), pair.group]));
  const rowPlans = plan.rowDeletion.filter((entry) =>
    complete.has(groupOfPair.get(pairKey(entry.a, entry.b)) ?? ''),
  );
  const withDeletions = rowPlans.filter((entry) => entry.deletions.length > 0);
  const rowRuns = sum(withDeletions.map((entry) => 1 + entry.deletions.length));
  const rowEstimate =
    withDeletions.length === 0 ? 0 : model.rowDeletionBatchMs + rowRuns * model.rowDeletionRunMs;
  const rowFits = fitsBeforeDeadline(rowEstimate, elapsed(), deadlineMs);
  const rowStarted = ctx.now();
  const rowResults = await runRowDeletion({
    repoRoot,
    workDir: layout.root,
    manifest,
    plans: rowFits ? rowPlans : rowPlans.filter((entry) => entry.deletions.length === 0),
  });
  const rowFile: RowDeletionFile = {
    schemaVersion: WORK_SCHEMA_VERSION,
    shard,
    manifestDigest: manifest.digest,
    results: rowResults,
  };
  writeJson(layout.rowDeletion(shard), rowFile);
  report.rowDeletion = {
    status: withDeletions.length === 0 ? 'none' : rowFits ? 'ran' : 'skipped',
    pairs: rowPlans.length,
    planned: withDeletions.length,
    runs: rowRuns,
    estimateMs: rowEstimate,
    wallClockMs: Math.round(ctx.now() - rowStarted),
  };
  save();
  log(
    `shard ${shard}: row deletion ${report.rowDeletion.status}: ${withDeletions.length} planned ` +
      `pairs in ${minutes(report.rowDeletion.wallClockMs)}`,
  );

  // Isolation only for pairs that can still be strong (D9).
  const shardPairs = plan.pairs.filter((pair) => complete.has(pair.group));
  const mainObservations = mergeObservations(results.flatMap((result) => result.observations));
  const schedules = resolvePairSchedules({
    plan: plan.shardPlan,
    manifestDigest: manifest.digest,
    pairs: shardPairs,
    outcomes: results,
  });
  const rowByKey = new Map(rowResults.map((result) => [pairKey(result.a, result.b), result]));
  const provisional = computeVerdicts(
    assembleVerdictInput({
      work,
      layer2: layer2.tests,
      scopes: plan.shardPlan.groups,
      pairs: shardPairs,
      schedules,
      stages: {
        isolation: () => BEST_ISOLATION,
        rowDeletion: (key) => rowByKey.get(key) ?? null,
        staticValueFlow: () => BEST_STATIC,
        trace: () => BEST_TRACE,
      },
      observations: mainObservations,
      degraded: [],
      tests: new Set(shardPairs.flatMap((pair) => [pair.a, pair.b])),
    }),
  );
  const strong = new Set(
    [...provisional.pairs, ...provisional.kept]
      .filter((verdict) => verdict.verdict === 'repeat-strong')
      .map((verdict) => pairKey(verdict.a, verdict.b)),
  );
  const { facets, checksContext } = layer2Maps(layer2.tests);
  const decisions = selectRepeatStagePairs(
    shardPairs.filter((pair) => strong.has(pairKey(pair.a, pair.b))),
    { merged: mainObservations, checksContext, facets },
  ).filter((decision) => decision.selected);
  report.isolation.candidates = strong.size;
  report.isolation.selected = decisions.length;
  save();
  const isolationPlan = planIsolation(decisions);
  const done = new Set<string>();
  const runKey = (spec: { group: string; id: string }): string => `${spec.group}/${spec.id}`;
  for (const decision of decisions) {
    const pending = isolationPlan.runs.filter(
      (spec) =>
        spec.group === decision.group &&
        spec.pairs.includes(decision.key) &&
        !done.has(runKey(spec)),
    );
    const costOf = (universe: number): number =>
      model.isolationRunMs + universe * model.freshProcessMs;
    const estimateMs = sum(pending.map((spec) => costOf(spec.universe.length)));
    const at = elapsed();
    if (!fitsBeforeDeadline(estimateMs, at, deadlineMs)) {
      report.isolation.skipped.push({
        a: decision.a,
        b: decision.b,
        estimateMs,
        elapsedMs: Math.round(at),
      });
      save();
      continue;
    }
    for (const spec of pending) {
      log(
        `shard ${shard}: isolation ${spec.kind} run ${spec.id} (${spec.universe.length} mutants)`,
      );
      const result = await runIsolationRun(spec, {
        repoRoot,
        workDir: layout.root,
        shard,
        manifest,
        packageDir,
      });
      done.add(runKey(spec));
      report.isolation.runs.push({
        id: spec.id,
        group: spec.group,
        kind: spec.kind,
        tests: spec.tests.length,
        universe: spec.universe.length,
        status: result.status,
        reason: result.reason,
        estimateMs: costOf(spec.universe.length),
        wallClockMs: result.wallClockMs,
      });
      save();
    }
  }
  report.finished = true;
  save();
  log(
    `shard ${shard}: done in ${minutes(report.wallClockMs)}: ${results.length} groups ran ` +
      `(${report.batches.length} batches), ` +
      `${report.groups.notStarted.length} not started; ${decisions.length} pairs isolated in ` +
      `${report.isolation.runs.length} runs`,
  );
  return report;
}

// ── Value-flow stage ───────────────────────────────────────────────────────

interface PdgIndex {
  status: 'indexed' | 'failed';
  indexedRoot: string;
  indexPrefix: string;
  home: string;
  detail: string | null;
  wallClockMs: number;
}

/** Indexes a copy for the PDG walk (D11); a failed analyze is reported, never thrown. */
function indexPdg(ctx: StageContext, mode: RunMode): PdgIndex {
  const started = ctx.now();
  const dir = ctx.layout.pdgDir;
  rmSync(dir, { recursive: true, force: true });
  const copy = path.join(dir, 'copy');
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const filter = (source: string): boolean => path.basename(source) !== 'node_modules';
  // Controls: the fixture itself; normal: only the production roots the walk reads (KTD7), so
  // index paths equal repo paths. Both come from the working tree, as the prepared copies do.
  const roots = mode.kind === 'controls' ? [`${mode.fixtureRoot}/`] : productionRoots();
  const indexPrefix = mode.kind === 'controls' ? `${mode.fixtureRoot}/` : '';
  for (const root of roots) {
    const target = mode.kind === 'controls' ? copy : path.join(copy, root);
    cpSync(path.join(ctx.repoRoot, root), target, { recursive: true, filter });
  }
  const logFile = path.join(dir, 'analyze.log');
  const fd = openSync(logFile, 'w');
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      process.execPath,
      [
        path.join(ctx.packageDir, DIST_ENTRY),
        'analyze',
        copy,
        '--pdg',
        '--skip-git',
        '--index-only',
      ],
      {
        cwd: ctx.packageDir,
        env: {
          ...process.env,
          GITNEXUS_HOME: home,
          GITNEXUS_WORKER_READY_TIMEOUT_MS: WORKER_READY_TIMEOUT_MS,
        },
        stdio: ['ignore', fd, fd],
        timeout: ANALYZE_TIMEOUT_MS,
      },
    );
  } finally {
    closeSync(fd);
  }
  const failed = result.status !== 0;
  const why = result.error ? `: ${result.error.message}` : '';
  return {
    status: failed ? 'failed' : 'indexed',
    indexedRoot: copy,
    indexPrefix,
    home,
    detail: failed
      ? `analyze exited with ${result.status ?? result.signal ?? 'no status'}${why} (log: ${logFile})`
      : null,
    wallClockMs: Math.round(ctx.now() - started),
  };
}

/** An edge source without a PDG layer: the walk marks the run `no-pdg-layer` (KTD11). */
const noLayerSource: ClosableEdgeSource = {
  layerState: () => Promise.resolve('no-layer'),
  reachingDefs: () => Promise.resolve({ edges: [], truncated: true }),
  callSummary: () => Promise.resolve(null),
  close: () => Promise.resolve(),
};

/** The value-flow stage; see the module comment. */
export async function runValueFlowStage(ctx: StageContext): Promise<ValueFlowFile> {
  const { repoRoot, layout, log } = ctx;
  const plan = readWork(layout.plan, 'plan', isPlanFile);
  const manifest = readScenarioRunManifest(layout.manifest);
  if (manifest.digest !== plan.manifestDigest) {
    throw new Error(`${layout.manifest} is not the run manifest of ${layout.plan}`);
  }
  const work = readWorkFile(layout.coverage);
  const layer2 = readWork(layout.layer2, 'layer 2', isLayer2File);
  const { facets } = layer2Maps(layer2.tests);
  const wallClockMs: Record<string, number> = {};
  const equal = plan.pairs.filter((pair) => facetEqual(facets, pair));
  const differing = equal.filter((pair) => {
    const [a, b] = [facets.get(pair.a), facets.get(pair.b)];
    return a !== undefined && b !== undefined && !sameDiscardedValues(a, b);
  });
  log(`value-flow: ${equal.length} facet-equal pairs, ${differing.length} with differing values`);

  let staticRun: StaticValueFlowRun = {
    degraded: [],
    checker: { version: null, tsconfig: null, error: null },
    pdgLayer: 'unknown',
    pairs: [],
  };
  let pdg: ValueFlowFile['pdg'] = {
    status: 'skipped',
    detail: null,
    indexPrefix: '',
    wallClockMs: 0,
  };
  if (differing.length > 0) {
    const index = indexPdg(ctx, plan.mode);
    pdg = {
      status: index.status,
      detail: index.detail,
      indexPrefix: index.indexPrefix,
      wallClockMs: index.wallClockMs,
    };
    wallClockMs.pdgIndex = index.wallClockMs;
    log(
      `value-flow: PDG index ${index.status} in ${minutes(index.wallClockMs)}${index.detail === null ? '' : `: ${index.detail}`}`,
    );
    const started = ctx.now();
    const checker = await openChecker({
      repoRoot,
      tsconfig:
        plan.mode.kind === 'controls' ? `${plan.mode.fixtureRoot}/tsconfig.json` : undefined,
    });
    const savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = index.home;
    let edges = noLayerSource;
    try {
      if (index.status === 'indexed') {
        try {
          edges = await openLocalBackendEdgeSource(index.indexedRoot);
        } catch (error) {
          pdg.detail = `the index did not open: ${errorMessage(error)}`;
        }
      }
      const ids = new Set(differing.flatMap((pair) => [pair.a, pair.b]));
      const files = sortedUnique(work.tests.filter((t) => ids.has(t.id)).map((t) => t.file));
      const instances = new Map(
        joinFiles(repoRoot, work.tests, files).map((instance) => [instance.id, instance]),
      );
      const mutateOf = new Map(plan.shardPlan.groups.map((group) => [group.id, group.mutate]));
      const read = (file: string): string | null => {
        try {
          return readFileSync(path.join(repoRoot, file), 'utf8');
        } catch {
          return null;
        }
      };
      const pairs = differing.flatMap((pair): ValueFlowPair[] => {
        const sides = [pair.a, pair.b].map((id) => {
          const record = instances.get(id)?.site?.record;
          const facet = facets.get(id);
          const source = record === undefined ? null : read(record.file);
          return record === undefined || facet === undefined || source === null
            ? null
            : bindSideOf(record, facet.discarded, source);
        });
        const [a, b] = sides;
        if (a === null || b === null) return [];
        return [{ a: pair.a, b: pair.b, sides: [a, b], mutate: mutateOf.get(pair.group) ?? [] }];
      });
      staticRun = await staticValueFlow(pairs, {
        read,
        indexPrefix: index.indexPrefix,
        edges,
        checker,
      });
    } finally {
      if (checker.status === 'ready') checker.checker.close();
      await edges.close();
      if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = savedHome;
    }
    wallClockMs.static = Math.round(ctx.now() - started);
    const counts = new Map<string, number>();
    for (const pair of staticRun.pairs) counts.set(pair.status, (counts.get(pair.status) ?? 0) + 1);
    log(
      `value-flow: static check ${JSON.stringify(Object.fromEntries(counts))}; degraded ` +
        `${JSON.stringify(staticRun.degraded)} in ${minutes(wallClockMs.static)}`,
    );
  }

  const traceStarted = ctx.now();
  const trace = await runTrace({
    repoRoot,
    workDir: layout.root,
    manifest,
    pairs: equal.map(({ a, b }) => ({ a, b })),
    opaqueCallees: sortedUnique(
      staticRun.pairs.flatMap((pair) => pair.opaqueSinks.map((sink) => sink.callee)),
    ),
  });
  wallClockMs.trace = Math.round(ctx.now() - traceStarted);
  log(
    `value-flow: trace ${trace.status}${trace.detail === null ? '' : ` (${trace.detail})`} in ` +
      `${minutes(wallClockMs.trace)}`,
  );
  const result: ValueFlowFile = {
    schemaVersion: WORK_SCHEMA_VERSION,
    manifestDigest: manifest.digest,
    pairs: { facetEqual: equal.length, valueDiffering: differing.length },
    pdg,
    staticValueFlow: staticRun,
    trace,
    wallClockMs,
  };
  writeJson(layout.valueFlow, result);
  return result;
}

/** Why a value-flow result is incomplete; empty when complete. */
export function valueFlowIssues(result: ValueFlowFile): string[] {
  return [
    ...(result.staticValueFlow.degraded.length > 0
      ? [`degraded: ${result.staticValueFlow.degraded.join(', ')}`]
      : []),
    ...(result.trace.status === 'not-run' && result.pairs.facetEqual > 0
      ? [`trace not run: ${result.trace.detail ?? 'unknown'}`]
      : []),
  ];
}

// ── Merge stage ────────────────────────────────────────────────────────────

export interface MergeStageOptions {
  run: RunInfo;
  baseline: string | null;
}

export interface MergeResult {
  report: ScenarioMapReport;
  verdicts: VerdictReport;
  complete: boolean;
}

/** The merge stage; see the module comment. */
export async function runMergeStage(
  ctx: StageContext,
  options: MergeStageOptions,
): Promise<MergeResult> {
  const { repoRoot, layout, log } = ctx;
  const plan = readWork(layout.plan, 'plan', isPlanFile);
  const work = readWorkFile(layout.coverage);
  const layer2 = readWork(layout.layer2, 'layer 2', isLayer2File);
  const digest = plan.manifestDigest;
  let baseline: unknown = null;
  if (options.baseline !== null) {
    try {
      baseline = readJsonFile(options.baseline);
    } catch (error) {
      throw new UsageError(`--baseline ${options.baseline}: ${errorMessage(error)}`);
    }
  }

  // Shards (R11, KTD14): what each one finished; a missing one leaves the run partial.
  const incomplete: ShardStatus['incomplete'] = [];
  let completeShards = 0;
  const rowResults: RowDeletionResult[] = [];
  for (const { index } of plan.shardPlan.shards) {
    const shardReport = readOptional(layout.shardReport(index), isShardStageReport);
    const issues =
      shardReport !== null && shardReport.manifestDigest !== digest
        ? ['its result belongs to another run manifest']
        : shardIssues(shardReport);
    if (issues.length === 0) completeShards += 1;
    else incomplete.push({ shard: String(index), reason: issues.join('; ') });
    const rows = readOptional(layout.rowDeletion(index), isRowDeletionFile);
    if (rows !== null && rows.manifestDigest === digest) rowResults.push(...rows.results);
  }
  const groupResults = plan.shardPlan.groups.flatMap((group): GroupObservations[] => {
    const file = observationsFile(layout.root, group.id);
    if (!existsSync(file)) return [];
    try {
      return [readGroupObservations(file)];
    } catch {
      return [];
    }
  });
  const isolationRuns = readIsolationRuns(layout.root).filter(
    (run) => run.manifestDigest === digest,
  );
  const valueFlowFile = readOptional(layout.valueFlow, isValueFlowFile);
  const valueFlow =
    valueFlowFile !== null && valueFlowFile.manifestDigest === digest ? valueFlowFile : null;
  if (valueFlow === null) {
    incomplete.push({
      shard: 'value-flow',
      reason:
        valueFlowFile === null
          ? 'no value-flow result'
          : 'its result belongs to another run manifest',
    });
  } else {
    const issues = valueFlowIssues(valueFlow);
    if (issues.some((issue) => issue.startsWith('trace not run'))) {
      incomplete.push({ shard: 'value-flow', reason: issues.join('; ') });
    }
  }

  // Observations, schedules, isolation (U7, U8).
  const mainObservations = groupResults
    .filter((result) => result.manifestDigest === digest)
    .flatMap((result) => result.observations);
  const mainMerged = mergeObservations(mainObservations);
  const merged = mergeObservations([
    ...mainObservations,
    ...isolationRuns.flatMap((run) => run.observations),
  ]);
  const schedules = resolvePairSchedules({
    plan: plan.shardPlan,
    manifestDigest: digest,
    pairs: plan.pairs,
    outcomes: groupResults,
  });
  const { facets, checksContext } = layer2Maps(layer2.tests);
  const isolation = evaluateIsolation(
    selectRepeatStagePairs(plan.pairs, { merged: mainMerged, checksContext, facets }),
    { merged: mainMerged, runs: isolationRuns, manifestDigest: digest },
  );

  const byKey = <T extends { a: string; b: string }>(list: readonly T[]): Map<string, T> =>
    new Map(list.map((entry) => [pairKey(entry.a, entry.b), entry]));
  const [isolationOf, rowOf] = [byKey<IsolationResult>(isolation), byKey(rowResults)];
  const staticOf = byKey(valueFlow?.staticValueFlow.pairs ?? []);
  const traceOf = byKey(valueFlow?.trace.pairs ?? []);
  const evidence = assembleVerdictInput({
    work,
    layer2: layer2.tests,
    scopes: plan.shardPlan.groups,
    pairs: plan.pairs,
    schedules,
    stages: {
      isolation: (key) => isolationOf.get(key) ?? null,
      rowDeletion: (key) => rowOf.get(key) ?? null,
      staticValueFlow: (key) => staticOf.get(key) ?? null,
      trace: (key) => traceOf.get(key) ?? null,
    },
    observations: merged,
    degraded: valueFlow?.staticValueFlow.degraded ?? [],
  });
  const verdicts = computeVerdicts(evidence);

  const read = (file: string): string | null => {
    try {
      return readFileSync(path.join(repoRoot, file), 'utf8');
    } catch {
      return null;
    }
  };
  const report = buildReport({
    run: options.run,
    seed: plan.seed,
    provenance: collectProvenance({
      repoRoot,
      testFiles: plan.eligibility.files,
      productionFiles: sortedUnique(plan.shardPlan.groups.flatMap((group) => group.mutate)),
      fixtureFiles: [],
      sourceRevision: ctx.sourceRevision(),
    }),
    eligibility: plan.eligibility,
    eligibleTests: work.tests.map((test) => test.id),
    shards: { planned: plan.shardPlan.shards.length, complete: completeShards, incomplete },
    layer0: existsSync(layout.layer0) ? readJsonFile(layout.layer0) : null,
    evidence,
    verdicts,
    anchors: new Map(layer2.tests.map((test) => [test.id, test.anchor])),
    fingerprints: fingerprintMutants(
      merged.map((entry) => entry.mutant),
      read,
    ),
    baseline,
  });
  writeFileSync(layout.reportJson, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(layout.reportMarkdown, renderMarkdown(report));
  writeFileSync(layout.issueBody, renderIssueBody(report));
  log(
    `merge: ${report.completeness.complete ? 'complete' : 'partial'} report: ` +
      `${report.summary.evaluated}; verdicts ${JSON.stringify(report.summary.byVerdict)}`,
  );
  for (const entry of incomplete) log(`merge: incomplete ${entry.shard}: ${entry.reason}`);
  log(`merge: ${layout.reportJson}, ${layout.reportMarkdown}, ${layout.issueBody}`);
  return { report, verdicts, complete: report.completeness.complete };
}

// ── Controls (Success Criteria) ────────────────────────────────────────────

export interface ExpectedControlsPair {
  id: string;
  /** Test ids relative to the fixture root (D4). */
  tests: [string, string];
  verdict: string;
  rule: string;
}

/** The pairs of the fixture's expected.json; a malformed file throws. */
export function parseExpectedControls(data: unknown): ExpectedControlsPair[] {
  const pairs = isRecord(data) ? data.pairs : undefined;
  if (!Array.isArray(pairs)) throw new Error('expected.json: pairs must be an array');
  return pairs.map((pair: unknown): ExpectedControlsPair => {
    const ok =
      isRecord(pair) &&
      typeof pair.id === 'string' &&
      Array.isArray(pair.tests) &&
      pair.tests.length === 2 &&
      pair.tests.every((test: unknown) => typeof test === 'string') &&
      typeof pair.verdict === 'string' &&
      typeof pair.rule === 'string';
    if (!ok) throw new Error(`expected.json: malformed pair ${JSON.stringify(pair)}`);
    return {
      id: String(pair.id),
      tests: [String(pair.tests[0]), String(pair.tests[1])],
      verdict: String(pair.verdict),
      rule: String(pair.rule),
    };
  });
}

export interface ControlsComparison {
  /** One line per expected pair. */
  lines: string[];
  /** Ids of the pairs whose verdict or rule differs, or that have no verdict. */
  differences: string[];
}

/** Compares the verdict and rule of every expected pair (findings and kept pairs). */
export function compareControls(
  expected: readonly ExpectedControlsPair[],
  verdicts: readonly Pick<PairVerdict, 'a' | 'b' | 'verdict' | 'rule'>[],
  prefix: string,
): ControlsComparison {
  const byKey = new Map(verdicts.map((verdict) => [pairKey(verdict.a, verdict.b), verdict]));
  const lines: string[] = [];
  const differences: string[] = [];
  for (const pair of expected) {
    const got = byKey.get(pairKey(prefix + pair.tests[0], prefix + pair.tests[1]));
    const want = `${pair.verdict}/${pair.rule}`;
    const actual = got === undefined ? 'no verdict' : `${got.verdict}/${got.rule}`;
    const holds = actual === want;
    if (!holds) differences.push(pair.id);
    lines.push(
      `${holds ? 'ok      ' : 'DIFFERS '} ${pair.id}: ${actual}${holds ? '' : ` (expected ${want})`}`,
    );
  }
  return { lines, differences };
}

// ── Main ───────────────────────────────────────────────────────────────────

export interface CliDeps {
  repoRoot: string;
  packageDir: string;
  /** Resolves relative flag paths. */
  cwd: string;
  log: (line: string) => void;
  now: () => number;
  sourceRevision: (repoRoot: string) => string | null;
}

const DIST_STAGES: ReadonlySet<Stage> = new Set(['value-flow', 'all', 'controls']);

/** Throws a usage error naming the build step when `dist/` is missing (D11). */
function ensureDist(packageDir: string): void {
  if (!existsSync(path.join(packageDir, DIST_ENTRY))) {
    throw new UsageError(
      `${path.join(packageDir, DIST_ENTRY)} is missing: the PDG index needs the built CLI; ` +
        `run \`${BUILD_COMMAND}\` from gitnexus/ first`,
    );
  }
}

async function runStage(options: CliOptions, ctx: StageContext): Promise<number> {
  const plan = (mode: RunMode, shards: number): Promise<PlanFile> =>
    runPlanStage(ctx, {
      mode,
      seed: options.seed,
      shards,
      budgetMs: options.deadlineMs ?? SHARD_DEADLINE_MS,
    });
  const shard = (index: number, of: number, selection: boolean): Promise<ShardStageReport> =>
    runShardStage(ctx, {
      index,
      of,
      sample: selection ? options.sample : null,
      groups: selection ? options.groups : null,
      deadlineMs: options.deadlineMs,
    });
  const merge = (): Promise<MergeResult> =>
    runMergeStage(ctx, { run: options.run, baseline: options.baseline });
  const timed = async <T>(name: string, step: () => Promise<T>): Promise<T> => {
    const started = ctx.now();
    const result = await step();
    ctx.log(`scenario-map: ${name} stage ${minutes(ctx.now() - started)}`);
    return result;
  };
  switch (options.stage) {
    case 'plan':
      await timed('plan', () => plan(options.mode, options.shards));
      return 0;
    case 'shard': {
      const report = await timed('shard', () => shard(options.index ?? 0, options.of ?? 1, true));
      return shardIssues(report).length === 0 ? 0 : 1;
    }
    case 'value-flow': {
      const result = await timed('value-flow', () => runValueFlowStage(ctx));
      return valueFlowIssues(result).length === 0 ? 0 : 1;
    }
    case 'merge':
      return (await timed('merge', merge)).complete ? 0 : 1;
    case 'all':
    case 'controls': {
      await timed('plan', () => plan(options.mode, 1));
      await timed('shard', () => shard(0, 1, false));
      await timed('value-flow', () => runValueFlowStage(ctx));
      const merged = await timed('merge', merge);
      if (options.stage === 'all') return merged.complete ? 0 : 1;
      const fixtureRoot =
        options.mode.kind === 'controls' ? options.mode.fixtureRoot : DEFAULT_FIXTURE_ROOT;
      const expected = parseExpectedControls(
        readJsonFile(path.join(ctx.repoRoot, fixtureRoot, 'expected.json')),
      );
      const comparison = compareControls(
        expected,
        [...merged.verdicts.pairs, ...merged.verdicts.kept],
        `${toPackagePath(fixtureRoot)}/`,
      );
      for (const line of comparison.lines) ctx.log(`controls: ${line}`);
      ctx.log(
        comparison.differences.length === 0
          ? `controls: all ${expected.length} pairs match expected.json`
          : `controls: ${comparison.differences.length} of ${expected.length} pairs differ: ` +
              comparison.differences.join(', '),
      );
      return comparison.differences.length === 0 ? 0 : 1;
    }
  }
}

/** Runs one CLI invocation and returns its exit code; never throws. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv, deps.cwd);
    if (isInside(deps.repoRoot, options.workDir) || isInside(options.workDir, deps.repoRoot)) {
      throw new UsageError(
        `--work ${options.workDir} must lie outside the checkout ${deps.repoRoot}`,
      );
    }
    if (DIST_STAGES.has(options.stage)) ensureDist(deps.packageDir);
  } catch (error) {
    deps.log(`scenario-map: ${errorMessage(error)}`);
    deps.log(USAGE);
    return 2;
  }
  const ctx: StageContext = {
    repoRoot: deps.repoRoot,
    packageDir: deps.packageDir,
    layout: workLayout(options.workDir),
    log: deps.log,
    now: deps.now,
    sourceRevision: () => deps.sourceRevision(deps.repoRoot),
  };
  try {
    return await runStage(options, ctx);
  } catch (error) {
    deps.log(`scenario-map: ${options.stage}: ${errorMessage(error)}`);
    if (error instanceof UsageError) deps.log(USAGE);
    return 2;
  }
}

function gitHead(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const packageDir = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const code = await runCli(process.argv.slice(2), {
    repoRoot: path.dirname(packageDir),
    packageDir,
    cwd: process.cwd(),
    // LadybugDB captures stdout once the PDG index is open: write past it.
    log: (line) => writeSync(1, `${line}\n`),
    now: () => performance.now(),
    sourceRevision: gitHead,
  });
  // Explicit, whatever an in-process Vitest run left in process.exitCode (D9); open Vitest or
  // LadybugDB handles must not keep the process alive.
  process.exit(code);
}

if (isMainModule(import.meta.url)) {
  void main();
}
