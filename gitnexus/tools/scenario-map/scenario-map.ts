/**
 * The scenario-map CLI (U14, R14, R16, KTD1, KTD11, KTD13, KTD14, KTD17): one command whose
 * stages map one-to-one onto the CI jobs, so a local `all` run and CI produce the same report.
 * Every stage reads and writes JSON in one work directory (`--work`, outside the checkout); CI
 * jobs exchange those files as artifacts. Order (local and CI): plan, then value-flow, then the
 * shards, then merge; value flow runs before the shards so the final shard plan and a shard's
 * isolation count only the pairs value flow leaves able to be strong (a plan deviation from
 * KTD14's parallel value-flow job). CI reads the matrix size from the `shards` stage, and runs
 * Layer 1 in coverage slices before the plan (fingerprint plan E5).
 *
 * Stages:
 *   coverage    `--index <i> --of <n>`: Layer 1 over slice i of the files Layer 1 runs
 *               ({@link layer1FilesOf}; pass the plan's `--mutation`) (path-coverage/slices.ts,
 *               balanced like the CI test shards), written as
 *               `<work>/coverage-slice-<i>.json`; exit 1 when a file of the slice failed or wrote
 *               no record.
 *   plan        eligibility (R1); the Layer 0 scan (test-dupes over the `--all` corpus plus the
 *               eligible files, findings on eligible files kept); a prepared copy and the run
 *               manifest built right after it (KTD14); Layer 1 over {@link layer1FilesOf}: every
 *               fingerprint file for `--mutation all` and controls, otherwise only the files with a
 *               test whose static checks-and-context key another test shares or that has none
 *               (path-coverage/prefilter.ts; E7), or with `--changed-since <ref>` (a diff-scoped
 *               run, E8: the test files added or modified since the merge base of `ref` and HEAD)
 *               only those files and the files sharing their tests' keys, the candidate pairs
 *               then kept only when they have a test of a changed file (path-coverage `runCoverage`, or
 *               with `--coverage <dir>` the merge of the coverage stage's slice files in that
 *               directory, read before the work directory is emptied and checked against the
 *               plan's mutation scope, mode and revision; their Layer 1 file list replaces the
 *               prefilter, and a slice that did not report leaves its files unrecorded); the
 *               static inventory and runtime join (U3); checks and context (U5, with the file
 *               snapshot and helper-module readers); input facets (U6); candidates (U4, Jaccard
 *               and checks-and-context sources); each group's KTD7 mutate scope (U7); the
 *               row-deletion plans of the facet-equal pairs (U9); the mutation target of
 *               `--mutation` ({@link mutationTarget}: every group, none, or the groups with a
 *               possible duplicate on the fingerprint before the trace, trimmed to its tests and the
 *               files they executed); the provisional shard plan (KTD17) over that target, which
 *               value-flow re-plans. Nothing to mutate plans no shard.
 *               The KTD17 estimate of a group ({@link estimateScenarioGroup}) is its main run
 *               (a fixed cost plus mutated bytes, the form calibrated on a 24-core WSL2 host at
 *               concurrency 2, KTD17 and design §7: the cost does not grow with the group's
 *               tests), plus row deletion (one Vitest run
 *               per control and deletion of its planned pairs, D10), plus isolation over the pairs
 *               that can still be strong on plan-time facts (equal checks-and-context keys, equal
 *               facets without a residual difference, and no weak disqualifier the verdict engine
 *               already finds before any mutation run): a FIXED cost per isolation run (one
 *               together run per pair, one alone run per test, D9) and the fresh-process mutant
 *               runs over the production bytes either test executed. The row-deletion batch's
 *               fixed cost is reserved once per shard, at the first group that needs it. The
 *               estimate is for a target Stryker concurrency (`--concurrency`, default 2; the
 *               mutant runs scale by the measured parallel efficiency, fixed costs do not) and a
 *               target machine (`--speed-factor`, default 1.5, the CI runners' wall clock over the
 *               calibration machine's). `shardsNeeded` is the fewest shards (at most 20) whose
 *               packing keeps every shard, its fixed cost and one row-deletion batch within the
 *               budget; the plan packs into it unless `--shards` is given. Only a group whose main
 *               run and row deletion alone exceed the budget is over budget (`group-over-budget`);
 *               a group whose isolation estimate does not fit as well still runs, with its
 *               isolation deferred: a shard isolates its pairs only when their measured universe
 *               fits the time left, and otherwise they stay isolation `not-run` (weak cap). A
 *               group whose mutate
 *               scope is empty executes no production file: it is packed into no shard and never
 *               run, and merge gives it a complete result without observations, so the verdict
 *               engine makes its pairs Out of scope (`covers-no-evaluated-mutant`).
 *   shard       `--index <i> --of <n>`: prepares its copy and verifies it against the run
 *               manifest (a mismatch writes `manifest-mismatch` results and runs nothing); runs its
 *               groups' Layer 3 main runs (U7 `runGroup`) in plan order, several groups sharing one
 *               Stryker run ({@link batchGroups}; an Inconclusive batch is re-run group by group),
 *               each batch started only when its whole estimate fits before the deadline with the
 *               row deletion and isolation of the groups already started still owed (KTD17); then
 *               one row-deletion batch (U9) for the pairs of its complete groups; then the
 *               isolation pass (U8) only for pairs that can still be strong: the verdict engine
 *               (U12), given value-flow.json's static and trace results and isolation at its best
 *               (agrees), calls them repeat-strong (D9). A pair value flow sends to Review (a veto
 *               or an unknown static check) or Inconclusive (a trace that is inconclusive) is not
 *               isolated, and its isolation is not owed when batches start. Without a usable
 *               value-flow result (missing, another run manifest, degraded, trace not run) value
 *               flow counts as clean and every repeat-stage pair is isolated (fail-safe). Each
 *               isolation pair starts only when its pending runs, priced on the universe its main
 *               run measured, fit before the deadline: first the pairs of groups whose isolation
 *               was planned (reserved), then those of groups whose isolation was deferred. Main and
 *               isolation runs use `--concurrency` (default the plan's). Every result is written
 *               as soon as it exists.
 *   value-flow  for mutation scope `all` only (a duplicate has equal values, so the fingerprint
 *               never needs it): the PDG index of a copy (the production roots, or the fixture in
 *               controls mode) under a temporary GITNEXUS_HOME (`node dist/cli/index.js analyze
 *               <copy> --pdg --skip-git --index-only`); the TypeScript checker (the fixture's
 *               tsconfig in controls mode); the static value-flow check (U10) of the facet-equal
 *               candidate pairs whose discarded values differ, with their group's mutate scope; the trace
 *               run (U11) of every facet-equal candidate pair, U10's opaque sinks wrapped. A
 *               failed analyze is the `no-pdg-layer` degraded run (KTD11). Then the final shard
 *               plan ({@link replanShards}): the plan's estimate, packing, budget, cost model and
 *               requested shard count, with the isolation term counting only the isolation
 *               candidates value flow leaves; its `shardPlan` (with the over-budget groups),
 *               estimates and `shardsNeeded` (at most 20) go into value-flow.json as `replan`.
 *               A degraded result, or one whose trace did not run, re-plans nothing for scope
 *               `all`; a narrower scope always re-plans over its target after the trace (a usable
 *               trace decides more pairs, so the target only narrows).
 *   shards      prints the final shard count and nothing else (CI: the matrix size; run it with
 *               `npm run --silent` or node directly): the re-plan's when value-flow.json is
 *               usable for this run manifest, else the provisional plan's
 *               ({@link effectiveShardPlan}). Shard and merge follow the same plan.
 *   merge       every result found: shard reports, group results, isolation runs, row deletion
 *               and value flow. A missing or unfinished shard leaves the run partial, and the
 *               pairs of its groups without a result Inconclusive (`not-scheduled`, R11); so does
 *               a group result it cannot read (another schema, such as the fully materialised
 *               schema 1, or a malformed row), which it lists as incomplete, and an isolation run
 *               result it cannot read (its pairs fall to isolation not-run, a weak cap). Observations follow
 *               the compact model (mutation/observations.ts: run universes plus explicit
 *               observations). Then the fingerprint verdict of every candidate pair
 *               (verdict/fingerprint.ts), the mutation verdicts (U12) of the pairs whose tests both
 *               ran in a mutated group ({@link mutationEvidence}), mutant fingerprints, provenance
 *               and the report (U13). A `--baseline` that does not read, is not JSON or has another
 *               schema is not an error: the report gets the incompatible-baseline banner and no
 *               delta, and merge logs a warning.
 *   all         plan (one shard), value-flow, shard 0 of 1 (skipped when nothing is to be
 *               mutated) and merge, in one process.
 *   controls    `all` in controls mode over the U17 fixture (extra root, its tsconfig, its own
 *               PDG index), then the verdict and rule of every expected.json pair compared; it
 *               also fails on an empty expected.json, on a repeat verdict (strong or weak) of a
 *               pair expected.json does not list, and on a `*.case.ts` file without an expected
 *               pair, so the oracle never passes vacuously.
 *               Needs a built `dist/` for the PDG index (`node scripts/build.js`).
 *
 * Usage (from gitnexus/; `npm run test:scenario-map -- <stage> …` runs the same):
 *   node --import tsx tools/scenario-map/scenario-map.ts <stage> [flags]
 *   --work <dir>               work directory, outside the checkout; default
 *                              `<os tmpdir>/gitnexus-scenario-map` (`…-controls` for controls)
 *   --mode normal|controls     plan, all: the run mode; `--controls` is `--mode controls`
 *   --seed <text>              plan, all, controls: seed of every sampled choice (spot audit)
 *   --mutation <scope>         plan, all: how much mutation evidence the run gathers
 *                              (types.ts `MutationScope`): `none` (fingerprint only, no shards),
 *                              `possible-duplicates` (the groups with a possible duplicate,
 *                              trimmed to its tests and the files they executed) or `all`
 *                              (default; controls always `all`)
 *   --shards <n>               plan: number of shards (default `shardsNeeded`; all and
 *                              controls: 1)
 *   --concurrency <n>          plan, all, controls: Stryker concurrency of the estimate
 *                              (default 2); shard, all, controls: of the main and isolation runs
 *                              (default the plan's). It also bounds every in-process Vitest run
 *                              (`maxWorkers`): plan's Layer 1, the shard's baselines and row
 *                              deletion, value-flow's trace run (value-flow: default the plan's),
 *                              so a local run never fans out over every core
 *   --speed-factor <x>         plan, all, controls: the target machine's wall clock over the
 *                              calibration machine's in the estimate (default 1.5)
 *   --index <i> --of <n>       shard: 0-based shard index and the final plan's shard count
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
 *   plan.json                    plan: mode, seed, eligibility, cost model (target concurrency
 *                                and speed factor), shard plan (groups with their KTD7 scope and
 *                                estimate), shardsNeeded, per-group cost breakdown, isolation
 *                                candidates, candidate pairs, row-deletion plans, timings
 *   scenario-run-manifest.json   plan: the run manifest (U7, KTD14)
 *   layer0.json                  plan: test-dupes `--json` shape, findings on eligible files
 *   layer2.json                  plan: per test: anchor, join problems, unresolved inputs,
 *                                dupe-ok, checks-and-context key, unsupported forms, facet
 *   coverage/coverage.json       plan: the Layer 1 work file; coverage/candidates.json: pairs
 *   plan/prepared/, coverage/prepared/   plan scratch
 *   observations/<group>.json    shard: group results (U7, run-group.ts schema 2: run universe and
 *                                explicit observations; a batch member's carries `batch`)
 *   batches/<batch>.json         shard: a main-run batch's outcome without observations (its
 *                                members' results hold them; `stryker.resultsFile` names the
 *                                driver's results.json, shard scratch)
 *   isolation/<group>/<run>.json shard: isolation run results (U8)
 *   row-deletion-shard-<i>.json  shard: row-deletion results (U9)
 *   shard-<i>.json               shard: shard report (written as it goes; `finished` at the end)
 *   shard-<i>/, groups/, row-deletion/   shard scratch
 *   value-flow.json              value-flow: PDG index status, static run, trace run, the final
 *                                shard plan (`replan`: shardPlan, estimates, shardsNeeded,
 *                                surviving isolation candidates)
 *   value-flow/pdg/, trace/      value-flow scratch (the analyze log is value-flow/pdg/analyze.log)
 *   scenario-map-report.json, scenario-map-report.md, issue-body.md   merge
 * value-flow needs plan.json, scenario-run-manifest.json, layer2.json and coverage/coverage.json;
 * a CI shard job needs the same plus value-flow.json; merge needs every artifact listed above
 * except the scratch directories.
 *
 * Exit codes: 0 the stage finished with complete results (`controls`: every expected verdict and
 * rule holds); 1 it finished with incomplete results: a shard with a manifest mismatch, groups not
 * started before the deadline, row deletion or isolation skipped, or sampled; a degraded value-flow
 * run or a trace that did not run or whose run is invalid; a partial report (`controls`: a verdict or rule differs); 2 a
 * usage or setup error, including a missing `dist/` build for plan, value-flow, all and controls
 * (the fingerprint's integration tests load the built CLI; prepared copies get the checkout's
 * `vendor/` and `dist/`, path-coverage/partitions.ts `copyBuildOutput`), or an
 * unexpected error. Codes are always set explicitly: an in-process Vitest run with a failing
 * baseline leaves `process.exitCode` at 1 (D9).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classify, type FileVerdict } from '../mutation/classify/classify.js';
import { PACKAGE_DIR, buildPathMap } from '../mutation/prepare/path-map.js';
import { prepare } from '../mutation/prepare/prepare.js';
import { parseTestId } from '../mutation/runner/test-ids.js';
import { errorMessage, isMainModule } from '../mutation/shared/cli.js';
import { overlaps, readJsonFile } from '../mutation/shared/fs.js';
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
import { fingerprintScope, resolveEligibility } from './inventory/eligible.js';
import { joinRuntime } from './inventory/identity.js';
import {
  evaluateIsolation,
  pairKey,
  planIsolation,
  readIsolationRuns,
  runIsolationRun,
  selectRepeatStagePairs,
  type IsolationResult,
  type IsolationRunResult,
} from './mutation/isolation.js';
import {
  mergeObservations,
  observedMutants,
  type MergedObservations,
  type RunUniverse,
} from './mutation/observations.js';
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
  type GroupOutcome,
  type GroupScope,
  type PairSchedule,
  type PlannedGroup,
  type ShardPlan,
} from './mutation/plan-shards.js';
import {
  planRowDeletion,
  pairTableSearch,
  runRowDeletion,
  type RowDeletionEnv,
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
  writeGroupObservations,
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
import { sequentialMatcherFor } from './path-coverage/partitions.js';
import { layer1Files } from './path-coverage/prefilter.js';
import {
  COVERAGE_SLICE_SCHEMA_VERSION,
  coverageSliceName,
  coverageSlices,
  mergeCoverageSlices,
  readCoverageSlices,
  type CoverageSliceFile,
} from './path-coverage/slices.js';
import { fingerprintMutants } from './report/anchors.js';
import { UnreadableBaseline } from './report/baseline.js';
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
  MUTATION_SCOPES,
  extraRootsOf,
  fromPackagePath,
  productionRoots,
  toPackagePath,
  type Eligibility,
  type InventoryInstance,
  type JoinProblem,
  type MutationScope,
  type RunMode,
  type TestAnchor,
} from './types.js';
import {
  byText,
  isRecord,
  sha1,
  sha256,
  sortedUnique,
  toPosixRelative,
  writeJson,
} from './util.js';
import { bindSideOf } from './value-flow/bind.js';
import { openChecker } from './value-flow/checker.js';
import {
  openLocalBackendEdgeSource,
  staticValueFlow,
  type ClosableEdgeSource,
  type PairValueFlow,
  type StaticValueFlowRun,
  type ValueFlowPair,
} from './value-flow/pdg-walk.js';
import { runTrace, type PairTrace, type TraceRunResult } from './value-flow/trace.js';
import {
  computeFingerprints,
  type FingerprintPair,
  type FingerprintVerdict,
} from './verdict/fingerprint.js';
import {
  computeVerdicts,
  type PairVerdict,
  type VerdictInput,
  type VerdictPairInput,
  type VerdictReport,
  type VerdictTestInput,
} from './verdict/verdict.js';

// ── Constants ──────────────────────────────────────────────────────────────

export const STAGES = [
  'coverage',
  'plan',
  'shard',
  'value-flow',
  'shards',
  'merge',
  'all',
  'controls',
] as const;
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
/**
 * The PDG analyze's budget. It must stay well below the CI value-flow step's `timeout-minutes`
 * (50, .github/workflows/test-scenario-map.yml "Run value flow"): a hung analyze then ends as the
 * `no-pdg-layer` degraded run, and the static check, the trace and value-flow.json still happen
 * (locally the index takes about 3 minutes).
 */
export const ANALYZE_TIMEOUT_MS = 25 * 60_000;

/**
 * KTD17 cost model plus the D9 and D10 terms, in milliseconds (KTD17, design §7). The main-run form
 * is calibrated on a 24-core WSL2 host at concurrency 2, over 16 groups of the eligible category
 * run alone: 1.46 min plus 12.97 min per MB of mutated code (`perRunMs` 88 s, `perByteMs` 0.78 ms),
 * with no factor for the group's tests (a 10-test group cost what a 2-test group of the same size
 * did; the KTD17 first calibration, 10 ms per byte and test, estimated 200 min for a 10.9 min
 * run), so `perByteTestMs` is 0. A batch costs `batchFactor` (1.23, the calibration batches)
 * times one fixed cost plus its members' byte terms. Known ceiling: static mutants rerun every
 * test of the run, so a run of many tests over much module-level code costs more than the form
 * says; no cheap static-mutant count exists before the run, and the measured static-heavy batch
 * (734 static mutants, 14 tests) stayed within the batch factor. `isolationRunMs`: the fixed part
 * of one isolation run (two baselines, the scope driver's prepare, Stryker's start and its
 * fresh test-runner processes), about 130 s besides its mutant runs (U8, WSL2, concurrency 2).
 * `rowDeletionBatchMs`: the batch's copy and its manifest check, about 48 s (U9);
 * `rowDeletionRunMs`: one control or deletion Vitest run, 2.5 to 5 s (U9; the upper end).
 * `parallelEfficiency`: two main-run batches of the eligible category ran at concurrency 2 and 4
 * on the calibration machine (24 cores): 9.3 and 10.2 min, then 5.9 and 7.3 min; with about
 * 1.5 min of fixed cost each, the mutant runs sped up 1.76 and 1.51 times (efficiency 0.76 and
 * 0.51, 0.62 together). A 4-vCPU runner at concurrency 4 may gain less.
 */
export interface ScenarioCostModel extends CostModel {
  /** Main-run cost per mutated byte, whatever the number of tests (calibrated, KTD17). */
  perByteMs: number;
  /** A main-run batch over its members' fixed cost once plus their byte terms (calibrated). */
  batchFactor: number;
  isolationRunMs: number;
  rowDeletionBatchMs: number;
  rowDeletionRunMs: number;
  /** A shard's prepare and manifest check before its first group: 45 to 60 s calibrated. */
  shardFixedMs: number;
  /** The Stryker concurrency every other term was measured at. */
  calibrationConcurrency: number;
  /**
   * Speed-up of the mutant runs per step of concurrency over the calibration's: at concurrency
   * `c` they take `1 / (1 + e * (c / calibration - 1))` of their calibrated time (fewer workers
   * than the calibration's slow them down linearly). Fixed costs do not scale.
   */
  parallelEfficiency: number;
  /** The Stryker concurrency the estimate is for. */
  concurrency: number;
  /** Wall clock of the target machine over the calibration machine's (CI: about 1.5). */
  speedFactor: number;
}

export const SCENARIO_COST_MODEL: Readonly<ScenarioCostModel> = Object.freeze({
  ...DEFAULT_COST_MODEL,
  perRunMs: 88_000,
  perByteTestMs: 0,
  perByteMs: 0.78,
  batchFactor: 1.23,
  isolationRunMs: 130_000,
  rowDeletionBatchMs: 48_000,
  rowDeletionRunMs: 5_000,
  shardFixedMs: 60_000,
  calibrationConcurrency: 2,
  parallelEfficiency: 0.6,
  concurrency: 2,
  speedFactor: 1,
});

/** Stryker concurrency of a plan's estimate and of a shard's runs unless given (KTD17). */
export const DEFAULT_CONCURRENCY = 2;
/** The plan's default wall-clock factor of the CI runners over the calibration machine. */
export const DEFAULT_SPEED_FACTOR = 1.5;
/** `shardsNeeded` never exceeds this many shards. */
export const MAX_SHARDS = 20;

/** {@link SCENARIO_COST_MODEL} for a target concurrency and machine. */
export const scenarioCostModel = (target: {
  concurrency: number;
  speedFactor: number;
}): ScenarioCostModel => ({ ...SCENARIO_COST_MODEL, ...target });

/** The share of their calibrated time the mutant runs take at the model's concurrency. */
export function mutantRunScale(model: Readonly<ScenarioCostModel>): number {
  const steps = model.concurrency / model.calibrationConcurrency;
  return 1 / (steps >= 1 ? 1 + model.parallelEfficiency * (steps - 1) : steps);
}

/** One isolation run's estimate over a universe of `mutants` (D9). */
export const isolationRunEstimate = (model: Readonly<ScenarioCostModel>, mutants: number): number =>
  Math.ceil(
    model.speedFactor *
      (model.isolationRunMs + mutants * model.freshProcessMs * mutantRunScale(model)),
  );

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

// ── Arguments ──────────────────────────────────────────────────────────────

export class UsageError extends Error {
  override name = 'UsageError';
}

export const USAGE =
  'usage: npm run test:scenario-map -- ' +
  '<coverage|plan|value-flow|shards|shard|merge|all|controls> [--work <dir>]\n' +
  '  coverage:   --index <i> --of <n> [--mode normal|controls | --controls] ' +
  '[--mutation none|possible-duplicates|all] [--concurrency <n>]\n' +
  '  plan:       [--mode normal|controls | --controls] [--seed <text>] [--shards <n>] ' +
  '[--mutation none|possible-duplicates|all] [--deadline-minutes <m>] [--concurrency <n>] ' +
  '[--speed-factor <x>] [--coverage <dir> | --changed-since <ref>]\n' +
  '  shard:      --index <i> --of <n> [--deadline-minutes <m>] [--concurrency <n>] ' +
  '[--sample <n>] [--groups <id,…>]\n' +
  '  value-flow: [--concurrency <n>]\n' +
  '  shards:     (no flags; prints the final shard count)\n' +
  '  merge:      [--baseline <report.json>] [--run-id <id>] [--run-attempt <n>] ' +
  '[--run-url <url>] [--ref <ref>] [--default-branch]\n' +
  '  all:        the plan flags except --shards and --coverage, and the merge flags\n' +
  '  controls:   [--seed <text>] [--deadline-minutes <m>] [--concurrency <n>] ' +
  '[--speed-factor <x>] and the merge flags\n' +
  '  --concurrency bounds both Stryker and every in-process Vitest run (its maxWorkers); ' +
  `default the plan's, ${DEFAULT_CONCURRENCY} for coverage, plan, all and controls`;

export interface CliOptions {
  stage: Stage;
  /** Absolute work directory. */
  workDir: string;
  mode: RunMode;
  seed: string;
  /** `--mutation` (default `all`); the controls stage always gathers `all`. */
  mutation: MutationScope;
  /** `--shards`; null lets the plan use `shardsNeeded`. */
  shards: number | null;
  /** Shard and coverage stages only; null otherwise. */
  index: number | null;
  of: number | null;
  /** Debug sample size of the shard stage; null runs every group. */
  sample: number | null;
  /** Debug group selection of the shard stage; null when not given. */
  groups: string[] | null;
  /** `--deadline-minutes` in milliseconds; null takes the plan's budget (KTD17 default). */
  deadlineMs: number | null;
  /**
   * Stryker concurrency: of the plan's estimate, of a shard's runs (default the plan's); also the
   * worker bound of every in-process Vitest run.
   */
  concurrency: number | null;
  /** The plan's wall-clock factor of the target machine (default {@link DEFAULT_SPEED_FACTOR}). */
  speedFactor: number | null;
  /** Absolute path of the baseline report; null when none. */
  baseline: string | null;
  /** Plan stage: absolute directory of the coverage stage's slice files; null runs Layer 1. */
  coverage: string | null;
  /** `--changed-since <ref>`: a diff-scoped run (E8); null for the whole suite. */
  changedSince: string | null;
  run: RunInfo;
}

const FLAG_OPTIONS = {
  work: { type: 'string' },
  mode: { type: 'string' },
  controls: { type: 'boolean' },
  seed: { type: 'string' },
  mutation: { type: 'string' },
  shards: { type: 'string' },
  index: { type: 'string' },
  of: { type: 'string' },
  sample: { type: 'string' },
  groups: { type: 'string' },
  'deadline-minutes': { type: 'string' },
  concurrency: { type: 'string' },
  'speed-factor': { type: 'string' },
  baseline: { type: 'string' },
  'run-id': { type: 'string' },
  'run-attempt': { type: 'string' },
  'run-url': { type: 'string' },
  ref: { type: 'string' },
  'default-branch': { type: 'boolean' },
  coverage: { type: 'string' },
  'changed-since': { type: 'string' },
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
  coverage: ['work', 'mode', 'controls', 'index', 'of', 'mutation', 'concurrency'],
  plan: [
    'work',
    'mode',
    'controls',
    'seed',
    'mutation',
    'shards',
    'deadline-minutes',
    'concurrency',
    'speed-factor',
    'coverage',
    'changed-since',
  ],
  shard: ['work', 'index', 'of', 'sample', 'groups', 'deadline-minutes', 'concurrency'],
  'value-flow': ['work', 'concurrency'],
  shards: ['work'],
  merge: ['work', ...REPORT_FLAGS],
  all: [
    'work',
    'mode',
    'controls',
    'seed',
    'mutation',
    'deadline-minutes',
    'concurrency',
    'speed-factor',
    'changed-since',
    ...REPORT_FLAGS,
  ],
  controls: ['work', 'seed', 'deadline-minutes', 'concurrency', 'speed-factor', ...REPORT_FLAGS],
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

/** A positive decimal flag value (`1.5`); anything else is a usage error. */
function decimalFlag(flag: string, value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+(\.\d+)?$/.test(value) || !(Number(value) > 0)) {
    throw new UsageError(`--${flag} must be a positive number, got ${value}`);
  }
  return Number(value);
}

/** `--mutation <scope>`: one of {@link MUTATION_SCOPES}; default `all`. */
function mutationFlag(value: string | undefined): MutationScope {
  const scope = MUTATION_SCOPES.find((entry) => entry === (value ?? 'all'));
  if (scope === undefined) {
    throw new UsageError(`--mutation must be one of ${MUTATION_SCOPES.join(', ')}, got ${value}`);
  }
  return scope;
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
  if ((stage === 'shard' || stage === 'coverage') && (index === null || of === null)) {
    throw new UsageError(`${stage} needs --index <i> and --of <n>`);
  }
  if (index !== null && of !== null && index >= of) {
    throw new UsageError(`--index ${index} is not below --of ${of}`);
  }
  const deadlineMinutes = integerFlag('deadline-minutes', values['deadline-minutes'], 1);
  const changedSince = values['changed-since'] ?? null;
  if (changedSince !== null && (changedSince === '' || changedSince.startsWith('-'))) {
    throw new UsageError(`--changed-since must name a git revision, got ${changedSince}`);
  }
  if (changedSince !== null && values.coverage !== undefined) {
    throw new UsageError('--changed-since runs Layer 1 itself; it does not take --coverage');
  }
  const mode = modeOf(stage, values.mode, values.controls);
  if (changedSince !== null && mode.kind === 'controls') {
    throw new UsageError('--changed-since scopes a diff of the suite, not the controls fixture');
  }
  const defaultWork = path.join(
    os.tmpdir(),
    mode.kind === 'controls' ? 'gitnexus-scenario-map-controls' : 'gitnexus-scenario-map',
  );
  return {
    stage,
    workDir: path.resolve(cwd, values.work ?? defaultWork),
    mode,
    seed: values.seed ?? DEFAULT_SEED,
    mutation: mutationFlag(values.mutation),
    shards: integerFlag('shards', values.shards, 1),
    index,
    of,
    sample: integerFlag('sample', values.sample, 1),
    groups: groupsFlag(values.groups),
    deadlineMs: deadlineMinutes === null ? null : deadlineMinutes * 60_000,
    concurrency: integerFlag('concurrency', values.concurrency, 1),
    speedFactor: decimalFlag('speed-factor', values['speed-factor']),
    baseline: values.baseline === undefined ? null : path.resolve(cwd, values.baseline),
    coverage: values.coverage === undefined ? null : path.resolve(cwd, values.coverage),
    changedSince,
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
  /** The coverage stage's slice file. */
  coverageSlice: (index: number) => string;
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
    coverageSlice: (index) => path.join(root, coverageSliceName(index)),
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
  /** The isolation bound, planned or not. */
  isolationMs: number;
  /** False when the isolation does not fit one shard's budget: deferred ({@link withinBudget}). */
  isolationPlanned: boolean;
  /** Main run, row deletion and planned isolation: the group's `estimateMs` in the shard plan. */
  estimateMs: number;
}

export interface PlanFile {
  schemaVersion: typeof WORK_SCHEMA_VERSION;
  mode: RunMode;
  seed: string;
  /** How much mutation evidence the run gathers: the shard plan covers only that. */
  mutation: MutationScope;
  eligibility: Eligibility;
  /**
   * `--changed-since`: the fingerprint's test files the diff changed; candidate pairs need a test
   * of one (E8). Null for a whole-suite run.
   */
  changedFiles: string[] | null;
  manifestDigest: string;
  /** The cost model at the target concurrency and speed factor. */
  costModel: ScenarioCostModel;
  /**
   * The provisional shard plan, packed into `--shards` or `shardsNeeded`; value-flow re-plans it
   * ({@link effectiveShardPlan}).
   */
  shardPlan: ShardPlan;
  /** `--shards`; null packs into `shardsNeeded`. */
  shardsRequested: number | null;
  /** The fewest shards whose packing keeps every shard in budget, at most {@link MAX_SHARDS}. */
  shardsNeeded: number;
  /** True when even {@link MAX_SHARDS} shards do not keep every shard in budget. */
  shardsCapped: boolean;
  /** Sorted by group. */
  estimates: GroupCostBreakdown[];
  /** {@link pairKey}s of the pairs the isolation term counts, sorted. */
  isolationCandidates: string[];
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
  reason: IsolationRunResult['reason'];
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
  /** Stryker concurrency of its main and isolation runs. */
  concurrency: number;
  /** Whether the isolation selection read value-flow.json ({@link valueFlowView}). */
  valueFlow: ValueFlowUse;
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
    /** Pairs whose planned isolation did not fit before the deadline: the shard is incomplete. */
    skipped: { a: string; b: string; estimateMs: number; elapsedMs: number }[];
    /**
     * Pairs of groups whose isolation was deferred (over one shard's budget) and whose measured
     * universe did not fit the time left: isolation `not-run` by plan, not an incomplete shard.
     */
    deferred: { a: string; b: string; estimateMs: number; elapsedMs: number }[];
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
  /** The final shard plan; null when this result cannot be used ({@link valueFlowView}). */
  replan: ShardReplan | null;
  wallClockMs: Record<string, number>;
}

/** The shard plan re-built from the isolation candidates value flow leaves ({@link replanShards}). */
export interface ShardReplan {
  shardPlan: ShardPlan;
  estimates: GroupCostBreakdown[];
  shardsNeeded: number;
  shardsCapped: boolean;
  /** The plan's isolation candidates that pass value flow, sorted. */
  isolationCandidates: string[];
}

const versioned = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.schemaVersion === WORK_SCHEMA_VERSION;

const isPlanFile = (value: unknown): value is PlanFile =>
  versioned(value) &&
  isRecord(value.mode) &&
  MUTATION_SCOPES.some((scope) => scope === value.mutation) &&
  isRecord(value.shardPlan) &&
  Array.isArray(value.pairs) &&
  Array.isArray(value.estimates) &&
  Array.isArray(value.rowDeletion) &&
  Array.isArray(value.isolationCandidates) &&
  (value.changedFiles === null || Array.isArray(value.changedFiles)) &&
  (value.shardsRequested === null || typeof value.shardsRequested === 'number') &&
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

// A trace result without `issues` predates the run-validity check: not this file's shape.
const isValueFlowFile = (value: unknown): value is ValueFlowFile =>
  versioned(value) &&
  isRecord(value.staticValueFlow) &&
  isRecord(value.trace) &&
  Array.isArray(value.trace.issues) &&
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
  const scale = mutantRunScale(model);
  const factor = model.speedFactor;
  const mainMs = Math.ceil(factor * (model.perRunMs + work.mutatedBytes * model.perByteMs * scale));
  const rowDeletionMs = Math.ceil(factor * work.rowDeletionRuns * model.rowDeletionRunMs);
  const isolationMs = Math.ceil(
    factor *
      (work.isolationRuns * model.isolationRunMs +
        work.isolationBytes * model.mutantsPerByte * ISOLATION_RUNS * model.freshProcessMs * scale),
  );
  return {
    ...work,
    mainMs,
    rowDeletionMs,
    isolationMs,
    isolationPlanned: true,
    estimateMs: mainMs + rowDeletionMs + isolationMs,
  };
}

/**
 * A group's estimate against one shard's budget: its isolation is planned (and counted) only when
 * the whole estimate fits; otherwise it is deferred and the group costs its main run and row
 * deletion, so only a group whose main run and row deletion alone exceed the budget is over it.
 */
export function withinBudget(estimate: GroupCostBreakdown, budgetMs: number): GroupCostBreakdown {
  const planned = estimate.mainMs + estimate.rowDeletionMs + estimate.isolationMs <= budgetMs;
  return {
    ...estimate,
    isolationPlanned: planned,
    estimateMs: estimate.mainMs + estimate.rowDeletionMs + (planned ? estimate.isolationMs : 0),
  };
}

/** A main-run batch's estimate: the batch factor over one fixed cost plus the members' rest. */
export function batchEstimate(model: Readonly<ScenarioCostModel>, memberMainMs: number[]): number {
  if (memberMainMs.length === 1) return memberMainMs[0];
  const fixedMs = model.speedFactor * model.perRunMs;
  return Math.ceil(
    model.batchFactor *
      (fixedMs + sum(memberMainMs.map((mainMs) => Math.max(0, mainMs - fixedMs)))),
  );
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
  /** Shards to pack into; null packs into `shardsNeeded`. */
  shards: number | null;
  budgetMs: number;
  model: Readonly<ScenarioCostModel>;
  /** Default {@link MAX_SHARDS}. */
  maxShards?: number;
}

export interface ShardPlanning {
  shardPlan: ShardPlan;
  estimates: GroupCostBreakdown[];
  shardsNeeded: number;
  shardsCapped: boolean;
}

/**
 * Each group's estimate and the KTD17 packing over them; pure given `sizeOf`. A group with an
 * empty mutate scope executes no production file: it is never run (its pairs are Out of scope,
 * {@link notRunOutcomes}), costs nothing and is packed into no shard. `shardsNeeded` is the
 * fewest shards whose packing keeps every shard, plus its fixed cost and one row-deletion batch,
 * within the budget.
 */
export function planShards(input: ShardPlanningInput): ShardPlanning {
  const pairsByGroup = new Map<string, CandidatePair[]>();
  for (const pair of input.pairs) {
    const known = pairsByGroup.get(pair.group);
    if (known === undefined) pairsByGroup.set(pair.group, [pair]);
    else known.push(pair);
  }
  const rowPlans = new Map(input.rowDeletion.map((plan) => [pairKey(plan.a, plan.b), plan]));
  const scopes = [...input.scopes].sort((x, y) => byText(x.id, y.id));
  const estimates = scopes.map((scope): GroupCostBreakdown => {
    if (scope.mutate.length === 0) {
      return estimateScenarioGroup(
        {
          group: scope.id,
          tests: scope.tests.length,
          mutatedBytes: 0,
          isolationPairs: 0,
          isolationRuns: 0,
          isolationBytes: 0,
          rowDeletionPairs: 0,
          rowDeletionRuns: 0,
        },
        { ...input.model, perRunMs: 0 },
      );
    }
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
  const budgeted = estimates.map((estimate) => withinBudget(estimate, input.budgetMs));
  const groups = scopes.map(
    (scope, i): PlannedGroup => ({
      ...scope,
      mutatedBytes: budgeted[i].mutatedBytes,
      estimateMs: budgeted[i].estimateMs,
    }),
  );
  const runnable = groups.filter((group) => group.mutate.length > 0);
  // Nothing to run (mutation scope `none`, or no possible duplicate): no shard at all.
  if (runnable.length === 0) {
    return {
      shardPlan: {
        schemaVersion: SHARD_PLAN_SCHEMA_VERSION,
        budgetMs: input.budgetMs,
        costModel: { ...input.model },
        groups,
        shards: [],
        overBudget: [],
      },
      estimates: budgeted,
      shardsNeeded: 0,
      shardsCapped: false,
    };
  }
  const { model } = input;
  const reserve = Math.ceil(model.speedFactor * (model.shardFixedMs + model.rowDeletionBatchMs));
  const maxShards = input.maxShards ?? MAX_SHARDS;
  let shardsNeeded = maxShards;
  let shardsCapped = true;
  for (let count = 1; count <= maxShards; count++) {
    const packing = packShards(runnable, count, input.budgetMs);
    if (packing.shards.every((shard) => shard.estimateMs + reserve <= input.budgetMs)) {
      shardsNeeded = count;
      shardsCapped = false;
      break;
    }
  }
  return {
    shardPlan: {
      schemaVersion: SHARD_PLAN_SCHEMA_VERSION,
      budgetMs: input.budgetMs,
      costModel: { ...model },
      groups,
      ...packShards(runnable, input.shards ?? shardsNeeded, input.budgetMs),
    },
    estimates: budgeted,
    shardsNeeded,
    shardsCapped,
  };
}

/** Why a group with an empty mutate scope has a result without a run. */
export const EMPTY_SCOPE_DETAIL = 'no production file executed: nothing to mutate, not run';

/**
 * The outcome of each group with an empty mutate scope (KTD7): complete, with no observation, so
 * its pairs are evaluated over an empty universe and the verdict engine's existing rule makes
 * them Out of scope (`covers-no-evaluated-mutant`). `shard` -1: no shard ran it.
 */
export function notRunOutcomes(
  groups: readonly GroupScope[],
  manifestDigest: string,
): GroupOutcome[] {
  return groups
    .filter((group) => group.mutate.length === 0)
    .map((group) => ({
      group: group.id,
      shard: -1,
      manifestDigest,
      status: 'complete',
      reason: null,
      detail: EMPTY_SCOPE_DETAIL,
      tests: [...group.tests],
    }));
}

// ── Value flow before isolation ────────────────────────────────────────────

/**
 * How a shard's isolation selection reads value flow: `used` (value-flow.json of this run
 * manifest, not degraded, its trace ran), else `missing`, `stale` (another run manifest),
 * `degraded` (a run-level static flag) or `trace-not-run`; in every case but `used` the shard
 * assumes value flow clean and isolates as without it (fail-safe: more cost, never fewer checks).
 */
export type ValueFlowUse = 'used' | 'missing' | 'stale' | 'degraded' | 'trace-not-run';

export interface ValueFlowView {
  use: ValueFlowUse;
  /** Static results and trace pairs by {@link pairKey}; empty unless `used`. */
  staticOf: ReadonlyMap<string, PairValueFlow>;
  traceOf: ReadonlyMap<string, PairTrace>;
}

/** The view of a value-flow result for a run manifest; see {@link ValueFlowUse}. */
export function valueFlowView(file: ValueFlowFile | null, manifestDigest: string): ValueFlowView {
  const none = (use: ValueFlowUse): ValueFlowView => ({
    use,
    staticOf: new Map(),
    traceOf: new Map(),
  });
  if (file === null) return none('missing');
  if (file.manifestDigest !== manifestDigest) return none('stale');
  if (file.staticValueFlow.degraded.length > 0) return none('degraded');
  if (file.trace.status !== 'ran' && file.pairs.facetEqual > 0) return none('trace-not-run');
  return {
    use: 'used',
    staticOf: new Map(file.staticValueFlow.pairs.map((pair) => [pairKey(pair.a, pair.b), pair])),
    traceOf: new Map(file.trace.pairs.map((pair) => [pairKey(pair.a, pair.b), pair])),
  };
}

/**
 * Whether value flow leaves a pair able to be strong: its trace is clean and its static check is
 * clean or was not needed (no static result: the discarded values are equal). Always true unless
 * the view is `used`. The estimate reads it; the isolation selection asks the verdict engine.
 */
export function valueFlowPasses(view: ValueFlowView, key: string): boolean {
  if (view.use !== 'used') return true;
  const flow = view.staticOf.get(key);
  return (
    view.traceOf.get(key)?.status === 'clean' &&
    (flow === undefined || flow.status === 'clean' || flow.status === 'not-required')
  );
}

/** What a re-plan reads besides the plan file: Layer 1 provenance and the checkout's file sizes. */
export interface ReplanFacts {
  /** Repo paths a test executed; null when its provenance is unknown. */
  executedFiles: (test: string) => readonly string[] | null;
  sizeOf: (repoPath: string) => number;
}

/**
 * The shard plan re-built after value flow: the target's groups and pairs (default the plan's
 * groups and pairs), the plan's row-deletion plans, budget, cost model and requested shard count,
 * with the isolation term counting only the plan's isolation candidates in the target that value
 * flow leaves able to be strong ({@link valueFlowPasses}; every one when the view is not `used`).
 * Pure given `facts`.
 */
export function replanShards(
  plan: PlanFile,
  view: ValueFlowView,
  facts: ReplanFacts,
  target: MutationTarget = { scopes: plan.shardPlan.groups, pairs: plan.pairs },
): ShardReplan {
  const targeted = new Set(target.pairs.map((pair) => pairKey(pair.a, pair.b)));
  const survivors = plan.isolationCandidates.filter(
    (key) => targeted.has(key) && valueFlowPasses(view, key),
  );
  const surviving = new Set(survivors);
  const replanned = planShards({
    scopes: target.scopes,
    pairs: target.pairs,
    potentialRepeat: (pair) => surviving.has(pairKey(pair.a, pair.b)),
    executedFiles: facts.executedFiles,
    rowDeletion: plan.rowDeletion,
    sizeOf: facts.sizeOf,
    shards: plan.shardsRequested,
    budgetMs: plan.shardPlan.budgetMs,
    model: plan.costModel,
  });
  return {
    shardPlan: replanned.shardPlan,
    estimates: replanned.estimates,
    shardsNeeded: replanned.shardsNeeded,
    shardsCapped: replanned.shardsCapped,
    isolationCandidates: survivors,
  };
}

export interface EffectiveShardPlan {
  /** `value-flow`: the re-plan of a usable value-flow result; `provisional`: plan.json's. */
  source: 'value-flow' | 'provisional';
  shardPlan: ShardPlan;
  estimates: GroupCostBreakdown[];
  shardsNeeded: number;
  shardsCapped: boolean;
}

/**
 * The shard plan shards and merge follow: value-flow.json's re-plan when that result is usable
 * for this run manifest ({@link valueFlowView}) or, for a mutation scope narrower than `all`,
 * belongs to it (its target is then the plan-time target or narrower), else plan.json's
 * provisional plan, exactly as without a value-flow stage.
 */
export function effectiveShardPlan(
  plan: PlanFile,
  valueFlow: ValueFlowFile | null,
): EffectiveShardPlan {
  const replan = valueFlow?.replan ?? null;
  const view = valueFlowView(valueFlow, plan.manifestDigest);
  const scoped = plan.mutation !== 'all' && view.use !== 'stale' && view.use !== 'missing';
  if (replan !== null && (view.use === 'used' || scoped)) {
    return {
      source: 'value-flow',
      shardPlan: replan.shardPlan,
      estimates: replan.estimates,
      shardsNeeded: replan.shardsNeeded,
      shardsCapped: replan.shardsCapped,
    };
  }
  return {
    source: 'provisional',
    shardPlan: plan.shardPlan,
    estimates: plan.estimates,
    shardsNeeded: plan.shardsNeeded,
    shardsCapped: plan.shardsCapped,
  };
}

/** Layer 1 provenance and checkout file sizes for {@link replanShards}. */
function replanFactsOf(repoRoot: string, work: CoverageWorkFile): ReplanFacts {
  const executed = new Map(
    work.tests.map((test) => [
      test.id,
      test.provenance.known ? test.provenance.executedFiles : null,
    ]),
  );
  return {
    executedFiles: (test) => executed.get(test) ?? null,
    sizeOf: (file) => {
      try {
        return statSync(path.join(repoRoot, file)).size;
      } catch {
        return 0;
      }
    },
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
  observations: MergedObservations;
  degraded: VerdictInput['valueFlowDegraded'];
  /** Package paths of the mutation-eligible test files (`Eligibility.files`). */
  mutationEligible: ReadonlySet<string>;
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
        eligible: input.mutationEligible.has(test.file),
        // Every test Layer 1 ran is in the fingerprint's scope (fingerprint F8).
        fingerprintEligible: true,
        passed: test.state === 'passed',
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

/**
 * The fingerprint verdict of every candidate pair by {@link pairKey}, a kept pair excluded, with
 * each pair's trace (null: not known yet, as at plan time).
 */
export function fingerprintVerdictsOf(
  work: Pick<CoverageWorkFile, 'tests'>,
  layer2: readonly Layer2Test[],
  pairs: readonly CandidatePair[],
  trace: (key: string) => VerdictPairInput['trace'],
): Map<string, FingerprintVerdict> {
  const evidence = assembleVerdictInput({
    work,
    layer2,
    scopes: [],
    pairs,
    schedules: pairs.map(
      (pair): PairSchedule => ({
        ...pair,
        status: 'inconclusive',
        reason: 'not-scheduled',
        shard: null,
        detail: null,
      }),
    ),
    stages: { isolation: () => null, rowDeletion: () => null, staticValueFlow: () => null, trace },
    observations: { explicit: [], universes: [] },
    degraded: [],
    // The fingerprint reads `fingerprintEligible`, never the mutation eligibility.
    mutationEligible: new Set(),
  });
  return new Map(
    computeFingerprints(evidence).pairs.map((pair) => [pairKey(pair.a, pair.b), pair.verdict]),
  );
}

/** Whether a test id's file is one of the mutation-eligible files (package paths). */
export const mutationEligibleTest = (files: readonly string[]): ((test: string) => boolean) => {
  const eligible = new Set(files);
  return (test) => eligible.has(parseTestId(test).file);
};

/** The groups and pairs a run's mutation scope mutates. */
export interface MutationTarget {
  scopes: GroupScope[];
  pairs: CandidatePair[];
}

/**
 * The mutation target of a scope (plan F7, E4): `none` nothing; `all` every pair whose two tests
 * are mutation-eligible; `possible-duplicates` those whose fingerprint verdict is a possible
 * duplicate. Each kept group is trimmed to the tests of its kept pairs and, when every such test's
 * provenance is known, to the mutate files they executed (no other file holds a mutant they can
 * kill); a group of scope `all` that keeps every test stays as planned. Pure.
 */
export function mutationTarget(
  scope: MutationScope,
  scopes: readonly GroupScope[],
  pairs: readonly CandidatePair[],
  verdictOf: ReadonlyMap<string, FingerprintVerdict>,
  executedFiles: (test: string) => readonly string[] | null,
  mutationEligible: (test: string) => boolean,
): MutationTarget {
  if (scope === 'none') return { scopes: [], pairs: [] };
  const kept = pairs.filter(
    (pair) =>
      mutationEligible(pair.a) &&
      mutationEligible(pair.b) &&
      (scope === 'all' || verdictOf.get(pairKey(pair.a, pair.b)) === 'possible-duplicate'),
  );
  const testsOf = new Map<string, Set<string>>();
  for (const pair of kept) {
    const tests = testsOf.get(pair.group) ?? new Set<string>();
    testsOf.set(pair.group, tests.add(pair.a).add(pair.b));
  }
  const trimmed = scopes.flatMap((group): GroupScope[] => {
    const own = testsOf.get(group.id);
    if (own === undefined) return [];
    const tests = group.tests.filter((test) => own.has(test));
    if (scope === 'all' && tests.length === group.tests.length) return [group];
    const executed = tests.map(executedFiles);
    const reached = executed.every((files) => files !== null)
      ? new Set(executed.flatMap((files) => files ?? []))
      : null;
    const files = new Set(tests.map((test) => parseTestId(test).file));
    return [
      {
        id: group.id,
        tests,
        testFiles: group.testFiles.filter((file) => files.has(file)),
        pairs: kept.filter((pair) => pair.group === group.id).length,
        mutate:
          reached === null ? [...group.mutate] : group.mutate.filter((file) => reached.has(file)),
        excluded: group.excluded.filter((entry) => own.has(entry.test)),
        closureIncomplete: group.closureIncomplete.filter((file) => files.has(file)),
        provenanceUnknown: group.provenanceUnknown.filter((test) => own.has(test)),
      },
    ];
  });
  return { scopes: trimmed, pairs: kept };
}

/**
 * The verdict engine's input for a mutation scope: every pair (`all`), else only the pairs whose
 * two tests both ran in their mutated group, and those tests (none for `none`). Pure.
 */
export function mutationEvidence(
  scope: MutationScope,
  evidence: VerdictInput,
  groups: readonly Pick<GroupScope, 'id' | 'tests'>[],
): VerdictInput {
  if (scope === 'all') return evidence;
  const ran = new Map(groups.map((group) => [group.id, new Set(group.tests)]));
  const pairs = evidence.pairs.filter((pair) => {
    const tests = ran.get(pair.group);
    return tests !== undefined && tests.has(pair.a) && tests.has(pair.b);
  });
  const tests = new Set(pairs.flatMap((pair) => [pair.a, pair.b]));
  return { ...evidence, tests: evidence.tests.filter((test) => tests.has(test.id)), pairs };
}

/** The run universes of group or isolation results (null for a run without results). */
const universesOf = (results: readonly { runUniverse: RunUniverse | null }[]): RunUniverse[] =>
  results.flatMap((result) => (result.runUniverse === null ? [] : [result.runUniverse]));

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
  /** classify's verdicts of the run's test files: the facet closures and the KTD7 scopes. */
  verdicts: FileVerdict[];
}

async function computeLayer2(repoRoot: string, work: CoverageWorkFile): Promise<Layer2Run> {
  const files = sortedUnique(work.tests.map((test) => test.file));
  const instances = joinFiles(repoRoot, work.tests, files);
  const checkOptions = {
    snapshots: fsSnapshotReader(repoRoot),
    modules: fsModuleReader(repoRoot),
  };
  const verdicts = classify({ repoRoot, testFiles: files }).files;
  const facetContext = createRunFacetContext({
    repoRoot,
    extraRoots: work.extraRoots,
    testFiles: files,
    verdicts,
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
  return { tests, facetContext, subjects, verdicts };
}

/** Facet-equal: both facets known with the same fingerprint (residual differences included). */
const facetEqual = (facets: ReadonlyMap<string, InputFacet>, pair: CandidatePair): boolean => {
  const [a, b] = [facets.get(pair.a), facets.get(pair.b)];
  return a !== undefined && b !== undefined && a.fingerprint === b.fingerprint;
};

/**
 * The test files Layer 1 runs (E7): path-coverage/prefilter.ts's for a diff-scoped run (E8, the
 * changed files and their key partners) and for mutation scope `none` and `possible-duplicates`;
 * every fingerprint file for scope `all` and in controls mode (every candidate group's evidence).
 */
export function layer1FilesOf(
  repoRoot: string,
  files: readonly string[],
  mutation: MutationScope,
  mode: RunMode,
  changed: ReadonlySet<string> | null = null,
): string[] {
  if (changed === null && (mutation === 'all' || mode.kind === 'controls')) return [...files];
  return layer1Files(repoRoot, files, changed).files;
}

/** Why Layer 1 left `skipped` files out (the plan's log); empty when it left none. */
function skippedNote(skipped: number, diffScoped: boolean): string {
  if (skipped === 0) return '';
  if (diffScoped) return `; the other ${skipped} can hold no finding with a changed test`;
  return (
    `; the other ${skipped} hold only tests whose checks-and-context key no other test shares, ` +
    'so none of their pairs can be a duplicate'
  );
}

/**
 * The fingerprint's test files (package paths) among the repo paths a diff names, a changed
 * `__snapshots__/<name>.snap` naming its test file `<name>` beside the directory. Changed helper
 * modules and fixtures do not count (fingerprint plan E8).
 */
export function changedTestFiles(
  diffNames: readonly string[],
  fingerprintFiles: readonly string[],
): string[] {
  const named = new Set(
    diffNames.map((name) => name.replace(/\/__snapshots__\/([^/]+)\.snap$/, '/$1')),
  );
  return fingerprintFiles.filter((file) => named.has(fromPackagePath(file)));
}

/** Repo paths added or modified since the merge base of `ref` and HEAD. */
function gitChangedFiles(repoRoot: string, ref: string): string[] {
  try {
    return execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=d', `${ref}...HEAD`],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    throw new UsageError(`--changed-since ${ref}: git diff failed: ${errorMessage(error)}`);
  }
}

/**
 * The coverage stage's slice files in `dir`, read before the plan empties its work directory and
 * checked against the plan's run: the slices' mutation scope, mode and revision must be its own.
 */
function readSlicesFor(
  ctx: StageContext,
  dir: string,
  run: { mutation: MutationScope; mode: RunMode },
): CoverageSliceFile[] {
  const reported = readCoverageSlices(dir);
  const [first] = reported;
  if (first === undefined) throw new UsageError(`${dir} holds no coverage slice file`);
  const revision = ctx.sourceRevision();
  const problems = [
    first.mutation === run.mutation ? null : `mutation ${first.mutation}, not ${run.mutation}`,
    first.work.mode === run.mode.kind ? null : `mode ${first.work.mode}, not ${run.mode.kind}`,
    first.revision === null || revision === null || first.revision === revision
      ? null
      : `revision ${first.revision}, not ${revision}`,
  ].filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    throw new UsageError(`${dir}: the coverage slices are another run's: ${problems.join('; ')}`);
  }
  return reported;
}

/**
 * Layer 1 from the coverage slices (path-coverage/slices.ts): their Layer 1 files re-split, the
 * slices merged and written where one Layer 1 run writes its work file.
 */
function mergeCoverage(
  ctx: StageContext,
  reported: readonly CoverageSliceFile[],
  mode: RunMode,
): CoverageWorkFile {
  const [first] = reported;
  const assignment = coverageSlices(
    first.layer1,
    first.of,
    ctx.packageDir,
    sequentialMatcherFor(mode.kind),
  );
  const work = mergeCoverageSlices(assignment, reported);
  ctx.log(`plan: layer 1 from ${reported.length} of ${first.of} coverage slices`);
  writeJson(ctx.layout.coverage, work);
  return work;
}

export interface CoverageStageOptions {
  index: number;
  of: number;
  mode: RunMode;
  /** The run's mutation scope: the plan stage must slice the same files (E7). */
  mutation: MutationScope;
  concurrency: number;
}

/**
 * The coverage stage: Layer 1 over slice `index` of `of` (path-coverage/slices.ts), written as
 * the slice file the plan stage's `--coverage` merges. True when every file of the slice was
 * recorded without errors.
 */
export async function runCoverageStage(
  ctx: StageContext,
  options: CoverageStageOptions,
): Promise<boolean> {
  const { repoRoot, layout, log } = ctx;
  resetWorkDir(layout.root);
  const { fingerprintFiles } = fingerprintScope({ repoRoot, mode: options.mode });
  const layer1 = layer1FilesOf(repoRoot, fingerprintFiles, options.mutation, options.mode);
  const assignment = coverageSlices(
    layer1,
    options.of,
    ctx.packageDir,
    sequentialMatcherFor(options.mode.kind),
  );
  const files = assignment[options.index] ?? [];
  log(
    `coverage: slice ${options.index} of ${options.of}: ${files.length} of the ${layer1.length} ` +
      `test files Layer 1 runs (${fingerprintFiles.length} in the fingerprint's scope)`,
  );
  const { work, wallClockMs } = await runCoverage({
    repoRoot,
    outDir: layout.coverageDir,
    mode: options.mode,
    maxWorkers: options.concurrency,
    files,
  });
  const slice: CoverageSliceFile = {
    schemaVersion: COVERAGE_SLICE_SCHEMA_VERSION,
    index: options.index,
    of: options.of,
    layer1,
    mutation: options.mutation,
    revision: ctx.sourceRevision(),
    work,
  };
  writeJson(layout.coverageSlice(options.index), slice);
  const failed = work.files.filter((file) => !file.recorded || file.errors.length > 0);
  log(
    `coverage: ${work.tests.length} tests, ${failed.length} files failed or unrecorded, ` +
      minutes(wallClockMs),
  );
  return failed.length === 0;
}

/**
 * The row-deletion plans a shard runs: those of its complete groups whose two tests the group
 * still holds after the mutation target's trim (both mutation-eligible and in scope).
 */
export function shardRowPlans(
  rowDeletion: readonly RowDeletionPlan[],
  pairs: readonly CandidatePair[],
  groups: ReadonlyMap<string, { tests: readonly string[] }>,
  complete: ReadonlySet<string>,
): RowDeletionPlan[] {
  const groupOfPair = new Map(pairs.map((pair) => [pairKey(pair.a, pair.b), pair.group]));
  return rowDeletion.filter((entry) => {
    const group = groupOfPair.get(pairKey(entry.a, entry.b)) ?? '';
    const tests = new Set(groups.get(group)?.tests ?? []);
    return complete.has(group) && tests.has(entry.a) && tests.has(entry.b);
  });
}

export interface PlanStageOptions {
  mode: RunMode;
  seed: string;
  mutation: MutationScope;
  /** Null packs into `shardsNeeded`. */
  shards: number | null;
  budgetMs: number;
  /** Stryker concurrency and wall-clock factor of the estimate. */
  concurrency: number;
  speedFactor: number;
  /** The coverage stage's slice files to merge instead of running Layer 1; null runs it. */
  coverage: string | null;
  /** A diff-scoped run's base revision (E8); null for the whole suite. */
  changedSince: string | null;
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
  // Read before the reset: the slice directory may lie inside the work directory.
  const slices = options.coverage === null ? null : readSlicesFor(ctx, options.coverage, options);
  resetWorkDir(layout.root);
  const eligibility = await timed('eligibility', () =>
    resolveEligibility({ repoRoot, mode: options.mode }),
  );
  if (eligibility.fingerprintFiles.length === 0) throw new UsageError('no eligible test files');
  log(
    `plan: ${eligibility.fingerprintFiles.length} test files in the fingerprint's scope, ` +
      `${eligibility.files.length} mutation-eligible (${options.mode.kind} mode)`,
  );
  const layer0 = await timed('layer 0', () => {
    try {
      return scanLayer0(repoRoot, eligibility.fingerprintFiles);
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
  const changed =
    options.changedSince === null
      ? null
      : new Set(
          changedTestFiles(
            gitChangedFiles(repoRoot, options.changedSince),
            eligibility.fingerprintFiles,
          ),
        );
  if (changed !== null) {
    log(
      `plan: diff scope since ${options.changedSince}: ${changed.size} changed test files in ` +
        "the fingerprint's scope; candidate pairs need a test of one",
    );
  }
  // The coverage slices carry the files they split (E5); otherwise the prefilter picks them.
  const layer1 =
    slices?.[0].layer1 ??
    (await timed('layer 1 files', () =>
      layer1FilesOf(
        repoRoot,
        eligibility.fingerprintFiles,
        options.mutation,
        options.mode,
        changed,
      ),
    ));
  log(
    `plan: Layer 1 runs ${layer1.length} of ${eligibility.fingerprintFiles.length} test files` +
      skippedNote(eligibility.fingerprintFiles.length - layer1.length, changed !== null),
  );
  const { work } = await timed('layer 1', async () =>
    slices === null
      ? runCoverage({
          repoRoot,
          outDir: layout.coverageDir,
          mode: options.mode,
          maxWorkers: options.concurrency,
          files: layer1,
        })
      : { work: mergeCoverage(ctx, slices, options.mode) },
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
    findCandidates(
      candidateTestsOf(work, checksContext),
      (id) => changed === null || changed.has(parseTestId(id).file),
    ),
  );
  writeJson(layout.candidates, { schemaVersion: WORK_FILE_SCHEMA_VERSION, ...candidates });

  const scopes = await timed('scopes', () => {
    // The verdicts layer 2 classified (the same test files).
    const closures = new Map(
      layer2.verdicts.map((verdict) => [
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
  // One env for every pair: row-deletion.ts caches each file's text, scan and hash per env.
  const rowEnv: RowDeletionEnv = {
    tables: layer2.facetContext.tables,
    read: (file) => sources.read(file),
  };
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
          rowEnv,
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
      observations: { explicit: [], universes: [] },
      degraded: [],
      mutationEligible: new Set(eligibility.files),
    }),
  );
  const strongCapable = new Set(
    [...planTime.pairs, ...planTime.kept]
      .filter((verdict) => verdict.disqualifiers.every((entry) => entry.kind === 'hook-stratum'))
      .map((verdict) => pairKey(verdict.a, verdict.b)),
  );
  const model = scenarioCostModel({
    concurrency: options.concurrency,
    speedFactor: options.speedFactor,
  });
  // The mutation target before the trace: a pair whose trace decides it counts as a possible
  // duplicate, so value flow can only narrow this target (F7).
  const target = mutationTarget(
    options.mutation,
    scopes,
    candidates.pairs,
    fingerprintVerdictsOf(work, layer2.tests, candidates.pairs, () => null),
    (test) => executed.get(test) ?? null,
    mutationEligibleTest(eligibility.files),
  );
  log(
    `plan: mutation ${options.mutation}: ${target.scopes.length} of ${scopes.length} groups, ` +
      `${target.pairs.length} of ${candidates.pairs.length} pairs`,
  );
  const isolationCandidates: string[] = [];
  const { shardPlan, estimates, shardsNeeded, shardsCapped } = planShards({
    scopes: target.scopes,
    pairs: target.pairs,
    potentialRepeat: (pair) => {
      const keys = [checksContext.get(pair.a), checksContext.get(pair.b)];
      const [fa, fb] = [facets.get(pair.a), facets.get(pair.b)];
      const candidate =
        strongCapable.has(pairKey(pair.a, pair.b)) &&
        typeof keys[0] === 'string' &&
        keys[0] === keys[1] &&
        fa !== undefined &&
        fb !== undefined &&
        fa.fingerprint === fb.fingerprint &&
        residualDifference(fa, fb).length === 0;
      if (candidate) isolationCandidates.push(pairKey(pair.a, pair.b));
      return candidate;
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
    model,
  });

  const plan: PlanFile = {
    schemaVersion: WORK_SCHEMA_VERSION,
    mode: options.mode,
    seed: options.seed,
    mutation: options.mutation,
    eligibility,
    changedFiles: changed === null ? null : [...changed],
    manifestDigest: manifest.digest,
    costModel: model,
    shardPlan,
    shardsRequested: options.shards,
    shardsNeeded,
    shardsCapped,
    estimates,
    isolationCandidates: sortedUnique(isolationCandidates),
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
      `row deletion; ${shardPlan.overBudget.length} groups over budget; ` +
      `${shardPlan.groups.filter((group) => group.mutate.length === 0).length} groups execute no ` +
      `production file (not run)`,
  );
  log(
    `plan: estimate at concurrency ${model.concurrency}, speed factor ${model.speedFactor}: ` +
      `${shardsNeeded}${shardsCapped ? ' (capped)' : ''} shards needed; provisionally packed ` +
      `into ${shardPlan.shards.length} (value-flow re-plans)`,
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
 * (two baselines, the scope driver's prepare, Stryker's start and dry run: about 1.5 min per run on
 * the calibration host, KTD17) but risks more work at the deadline and on a fallback.
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
 * Batches the groups of a shard, in plan order of their first member, while {@link batchEstimate}
 * stays within the budget ({@link BATCH_BUDGET_MS}). A group with an empty mutate scope runs alone
 * (the scope driver refuses it), and so does a group whose own estimate exceeds the budget.
 */
export function batchGroups(
  groups: readonly { id: string; mainMs: number; mutate: number }[],
  model: Readonly<ScenarioCostModel>,
  budgetMs: number = BATCH_BUDGET_MS,
): MainBatch[] {
  const batches: { groups: string[]; members: number[]; mainMs: number }[] = [];
  let open: { groups: string[]; members: number[]; mainMs: number } | null = null;
  for (const group of groups) {
    if (group.mutate === 0) {
      batches.push({ groups: [group.id], members: [group.mainMs], mainMs: group.mainMs });
      continue;
    }
    const joined = open === null ? null : batchEstimate(model, [...open.members, group.mainMs]);
    if (open !== null && joined !== null && joined <= budgetMs) {
      open.groups.push(group.id);
      open.members.push(group.mainMs);
      open.mainMs = joined;
      continue;
    }
    open = { groups: [group.id], members: [group.mainMs], mainMs: group.mainMs };
    batches.push(open);
  }
  return batches.map((batch) => ({
    id:
      batch.groups.length === 1
        ? batch.groups[0]
        : `b${sha1(batch.groups.join('\n')).slice(0, 16)}`,
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
 * `batches/<batch>.json`: a main-run batch's outcome without its run universe and observations:
 * the members' split results hold them, and `stryker.resultsFile` names the driver's results.
 */
export interface BatchRecord extends Omit<GroupObservations, 'runUniverse' | 'observations'> {
  /** Member group ids, in plan order. */
  groups: string[];
}

export const batchRecordOf = (
  { runUniverse: _universe, observations: _observations, ...outcome }: GroupObservations,
  groups: readonly string[],
): BatchRecord => ({ ...outcome, groups: [...groups] });

/**
 * Splits a batch's result into one result per member: the member's own tests' observations of
 * its own mutate files (KTD7), relabelled with its group id, so its universe, kill sets and path
 * are those of its own scope; its run universe likewise (the batch's tests that are the member's,
 * the mutants of its files), so the implied observations are its own too. Status, baselines and
 * the Stryker summary are the batch's.
 */
export function splitBatchResult(
  result: GroupObservations,
  members: readonly GroupScope[],
): BatchedGroupObservations[] {
  const ids = members.map((member) => member.id);
  const universe = result.runUniverse;
  return members.map((member) => {
    const tests = new Set(member.tests);
    const files = new Set(member.mutate);
    const runUniverse: RunUniverse | null =
      universe === null
        ? null
        : {
            ...universe,
            group: member.id,
            tests: universe.tests.filter((test) => tests.has(test)),
            mutants: universe.mutants.filter((mutant) => files.has(mutant.file)),
          };
    return {
      ...result,
      group: member.id,
      tests: [...member.tests],
      scope: scopeOnly(member),
      runUniverse,
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
    runUniverse: null,
    observations: [],
    wallClockMs: 0,
  };
  writeGroupObservations(observationsFile(workDir, group.id), result);
}

export interface ShardStageOptions {
  index: number;
  of: number;
  sample: number | null;
  groups: string[] | null;
  /** Null takes the plan's budget. */
  deadlineMs: number | null;
  /** Stryker concurrency of the main and isolation runs; null takes the plan's. */
  concurrency: number | null;
}

/**
 * The shard's isolation order: first the pairs of groups whose isolation was planned (their time
 * is reserved), then those of groups whose isolation was deferred, each in decision order.
 */
export function isolationOrder<T extends { group: string }>(
  decisions: readonly T[],
  isolationPlanned: (group: string) => boolean,
): { decision: T; planned: boolean }[] {
  const tagged = decisions.map((decision) => ({
    decision,
    planned: isolationPlanned(decision.group),
  }));
  return [...tagged.filter((entry) => entry.planned), ...tagged.filter((entry) => !entry.planned)];
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
  const valueFlowFile = readOptional(layout.valueFlow, isValueFlowFile);
  const effective = effectiveShardPlan(plan, valueFlowFile);
  const shardPlan = effective.shardPlan;
  const shardCount = shardPlan.shards.length;
  if (options.of !== shardCount) {
    throw new UsageError(
      `--of ${options.of}: the ${effective.source} shard plan has ${shardCount} shard(s)`,
    );
  }
  const manifest = readScenarioRunManifest(layout.manifest);
  if (manifest.digest !== plan.manifestDigest) {
    throw new Error(`${layout.manifest} is not the run manifest of ${layout.plan}`);
  }
  const work = readWorkFile(layout.coverage);
  const layer2 = readWork(layout.layer2, 'layer 2', isLayer2File);
  const model = plan.costModel;
  const deadlineMs = options.deadlineMs ?? shardPlan.budgetMs;
  const shard = options.index;
  const assignment = shardPlan.shards.find((entry) => entry.index === shard);
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
  const planned = new Map(shardPlan.groups.map((group) => [group.id, group]));
  const concurrency = options.concurrency ?? model.concurrency;
  const stryker = { concurrency };
  // Value flow ran before the shards: a pair it already sends to Review or Inconclusive is never
  // isolated, and the re-plan's estimates owe no isolation for it. Without a usable result, the
  // provisional plan and its estimates.
  const valueFlow = valueFlowView(valueFlowFile, manifest.digest);
  const estimates = new Map(effective.estimates.map((entry) => [entry.group, entry]));

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
    concurrency,
    valueFlow: valueFlow.use,
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
    isolation: { candidates: 0, selected: 0, runs: [], skipped: [], deferred: [] },
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
    `shard ${shard}: ${toRun.length} of ${assignment.groups.length} groups; deadline ` +
      `${minutes(deadlineMs)}; concurrency ${concurrency}; value flow ${valueFlow.use}; ` +
      `${effective.source} shard plan`,
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
      stryker,
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
    model,
  );
  for (const batch of batches) {
    const members = batch.groups.map(groupOf);
    // Row deletion and planned isolation are owed; deferred isolation is opportunistic.
    const deferred = sum(
      batch.groups.map(
        (id) =>
          estimateOf(id).rowDeletionMs +
          (estimateOf(id).isolationPlanned ? estimateOf(id).isolationMs : 0),
      ),
    );
    const reserve =
      !batchReserved && batch.groups.some((id) => estimateOf(id).rowDeletionRuns > 0)
        ? Math.ceil(model.speedFactor * model.rowDeletionBatchMs)
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
      stryker,
    });
    // The batch's observations live on in its members' results: keep its outcome only.
    writeJson(
      path.join(layout.root, 'batches', `${batch.id}.json`),
      batchRecordOf(result, batch.groups),
    );
    rmSync(observationsFile(layout.root, batch.id), { force: true });
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
        writeGroupObservations(observationsFile(layout.root, split.group), split);
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

  // One row-deletion batch (U9, D10).
  const complete = new Set(results.filter((r) => r.status === 'complete').map((r) => r.group));
  const rowPlans = shardRowPlans(plan.rowDeletion, plan.pairs, planned, complete);
  const withDeletions = rowPlans.filter((entry) => entry.deletions.length > 0);
  const rowRuns = sum(withDeletions.map((entry) => 1 + entry.deletions.length));
  const rowEstimate =
    withDeletions.length === 0
      ? 0
      : Math.ceil(
          model.speedFactor * (model.rowDeletionBatchMs + rowRuns * model.rowDeletionRunMs),
        );
  const rowFits = fitsBeforeDeadline(rowEstimate, elapsed(), deadlineMs);
  const rowStarted = ctx.now();
  const rowResults = await runRowDeletion({
    repoRoot,
    workDir: layout.root,
    manifest,
    plans: rowFits ? rowPlans : rowPlans.filter((entry) => entry.deletions.length === 0),
    maxWorkers: concurrency,
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

  // Isolation only for pairs that can still be strong (D9): the verdict engine gets the real value
  // flow when it ran before the shards, and every stage still to come at its best otherwise.
  const shardPairs = plan.pairs.filter((pair) => complete.has(pair.group));
  const mainObservations = mergeObservations(
    results.flatMap((result) => result.observations),
    universesOf(results),
  );
  const schedules = resolvePairSchedules({
    plan: shardPlan,
    manifestDigest: manifest.digest,
    pairs: shardPairs,
    outcomes: results,
  });
  const rowByKey = new Map(rowResults.map((result) => [pairKey(result.a, result.b), result]));
  const provisional = computeVerdicts(
    assembleVerdictInput({
      work,
      layer2: layer2.tests,
      scopes: shardPlan.groups,
      pairs: shardPairs,
      schedules,
      stages: {
        isolation: () => BEST_ISOLATION,
        rowDeletion: (key) => rowByKey.get(key) ?? null,
        staticValueFlow: (key) =>
          valueFlow.use === 'used' ? (valueFlow.staticOf.get(key) ?? null) : BEST_STATIC,
        trace: (key) =>
          valueFlow.use === 'used' ? (valueFlow.traceOf.get(key) ?? null) : BEST_TRACE,
      },
      observations: mainObservations,
      degraded: [],
      tests: new Set(shardPairs.flatMap((pair) => [pair.a, pair.b])),
      mutationEligible: new Set(plan.eligibility.files),
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
  for (const { decision, planned } of isolationOrder(
    decisions,
    (group) => estimateOf(group).isolationPlanned,
  )) {
    const pending = isolationPlan.runs.filter(
      (spec) =>
        spec.group === decision.group &&
        spec.pairs.includes(decision.key) &&
        !done.has(runKey(spec)),
    );
    const costOf = (universe: number): number => isolationRunEstimate(model, universe);
    const estimateMs = sum(pending.map((spec) => costOf(spec.universe.length)));
    const at = elapsed();
    if (!fitsBeforeDeadline(estimateMs, at, deadlineMs)) {
      const entry = { a: decision.a, b: decision.b, estimateMs, elapsedMs: Math.round(at) };
      (planned ? report.isolation.skipped : report.isolation.deferred).push(entry);
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
        stryker,
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
      `${report.groups.notStarted.length} not started; ${decisions.length} repeat-stage pairs, ` +
      `${report.isolation.runs.length} isolation runs; ${report.isolation.deferred.length} ` +
      `deferred pairs left isolation not-run, ${report.isolation.skipped.length} skipped`,
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

export interface ValueFlowStageOptions {
  /** Bound of the trace run's Vitest workers; null takes the plan's concurrency. */
  concurrency: number | null;
}

/** The value-flow stage; see the module comment. */
export async function runValueFlowStage(
  ctx: StageContext,
  options: ValueFlowStageOptions,
): Promise<ValueFlowFile> {
  const { repoRoot, layout, log } = ctx;
  const plan = readWork(layout.plan, 'plan', isPlanFile);
  const concurrency = options.concurrency ?? plan.costModel.concurrency;
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
  // The static check only informs mutation verdicts of every group (scope `all`); a duplicate has
  // equal values, so the fingerprint never needs it.
  if (differing.length > 0 && plan.mutation === 'all') {
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
    maxWorkers: concurrency,
  });
  wallClockMs.trace = Math.round(ctx.now() - traceStarted);
  log(
    `value-flow: trace ${trace.status}${trace.detail === null ? '' : ` (${trace.detail})`} in ` +
      `${minutes(wallClockMs.trace)}`,
  );
  for (const issue of trace.issues)
    log(`value-flow: trace run invalid, every pair inconclusive: ${issue}`);
  const result: ValueFlowFile = {
    schemaVersion: WORK_SCHEMA_VERSION,
    manifestDigest: manifest.digest,
    pairs: { facetEqual: equal.length, valueDiffering: differing.length },
    pdg,
    staticValueFlow: staticRun,
    trace,
    replan: null,
    wallClockMs,
  };
  // The final shard plan: only the isolation candidates value flow leaves count (a degraded or
  // trace-less result re-plans nothing, so shards and merge follow the provisional plan).
  const view = valueFlowView(result, manifest.digest);
  if (plan.mutation !== 'all') {
    // The target after the trace: a usable trace decides more pairs, so the target narrows.
    const traceOf = new Map(view.traceOf);
    const facts = replanFactsOf(repoRoot, work);
    const target = mutationTarget(
      plan.mutation,
      plan.shardPlan.groups,
      plan.pairs,
      fingerprintVerdictsOf(work, layer2.tests, plan.pairs, (key) => traceOf.get(key) ?? null),
      facts.executedFiles,
      mutationEligibleTest(plan.eligibility.files),
    );
    result.replan = replanShards(plan, view, facts, target);
  } else if (view.use === 'used') {
    result.replan = replanShards(plan, view, replanFactsOf(repoRoot, work));
  }
  const final = effectiveShardPlan(plan, result);
  log(
    `value-flow: ${final.source} shard plan: ${final.shardPlan.shards.length} shards ` +
      `(${final.shardsNeeded}${final.shardsCapped ? ', capped' : ''} needed; provisional ` +
      `${plan.shardPlan.shards.length}), ${final.shardPlan.overBudget.length} groups over budget ` +
      `(provisional ${plan.shardPlan.overBudget.length}); isolation candidates ` +
      `${result.replan?.isolationCandidates.length ?? plan.isolationCandidates.length} of ` +
      `${plan.isolationCandidates.length}`,
  );
  writeJson(layout.valueFlow, result);
  return result;
}

/** The final shard count (the CI matrix size): one number, nothing else on stdout. */
export function finalShardCount(layout: WorkLayout): number {
  const plan = readWork(layout.plan, 'plan', isPlanFile);
  return effectiveShardPlan(plan, readOptional(layout.valueFlow, isValueFlowFile)).shardPlan.shards
    .length;
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
    ...(result.trace.issues.length > 0
      ? [`trace run invalid: ${result.trace.issues.join('; ')}`]
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
  const valueFlowFile = readOptional(layout.valueFlow, isValueFlowFile);
  const { shardPlan, source } = effectiveShardPlan(plan, valueFlowFile);
  // A baseline that does not read (missing, not JSON) or is not a report of this schema must not
  // cost the run its report: it gets the incompatible-baseline banner and no delta (baseline.ts).
  let baseline: unknown = null;
  if (options.baseline !== null) {
    try {
      baseline = readJsonFile(options.baseline);
    } catch (error) {
      baseline = new UnreadableBaseline(errorMessage(error));
    }
  }

  // Shards (R11, KTD14): what each one finished; a missing one leaves the run partial.
  const incomplete: ShardStatus['incomplete'] = [];
  let completeShards = 0;
  const rowResults: RowDeletionResult[] = [];
  for (const { index } of shardPlan.shards) {
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
  const groupResults = shardPlan.groups.flatMap((group): GroupObservations[] => {
    const file = observationsFile(layout.root, group.id);
    if (!existsSync(file)) return [];
    try {
      return [readGroupObservations(file)];
    } catch (error) {
      // Unreadable (another schema, a malformed row): its pairs stay not scheduled, run partial.
      incomplete.push({ shard: `group ${group.id}`, reason: errorMessage(error) });
      return [];
    }
  });
  // An isolation run that does not read (truncated, another schema) is left out: its pairs fall
  // to isolation not-run (weak cap) and the run is partial.
  const isolationRoot = path.join(layout.root, 'isolation');
  const isolationRuns = readIsolationRuns(layout.root, (file, error) => {
    const name = toPosixRelative(path.relative(isolationRoot, file));
    incomplete.push({ shard: `isolation ${name}`, reason: errorMessage(error) });
  }).filter((run) => run.manifestDigest === digest);
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
    // A trace that did not run, or whose run is invalid, leaves every facet-equal pair
    // Inconclusive: the run is partial.
    const issues = valueFlowIssues(valueFlow);
    if (issues.some((issue) => issue.startsWith('trace '))) {
      incomplete.push({ shard: 'value-flow', reason: issues.join('; ') });
    }
  }

  // Observations, schedules, isolation (U7, U8); compact model (observations.ts).
  const verified = groupResults.filter((result) => result.manifestDigest === digest);
  const merged = mergeObservations(
    [
      ...verified.flatMap((result) => result.observations),
      ...isolationRuns.flatMap((run) => run.observations),
    ],
    [...universesOf(verified), ...universesOf(isolationRuns)],
  );
  // Group results are the `main` runs and isolation runs `together` or `alone` ones, and the run
  // kind is part of every merge key: the main part of the merge is the group results' own merge.
  // The repeat stage and the comparison share its index (isolation.ts).
  const mainMerged: MergedObservations = {
    explicit: merged.explicit.filter((entry) => entry.kind === 'main'),
    universes: merged.universes.filter((universe) => universe.kind === 'main'),
  };
  const schedules = resolvePairSchedules({
    plan: shardPlan,
    manifestDigest: digest,
    pairs: plan.pairs,
    outcomes: [...groupResults, ...notRunOutcomes(shardPlan.groups, digest)],
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
  const mutationEligible = new Set(plan.eligibility.files);
  const evidence = assembleVerdictInput({
    work,
    layer2: layer2.tests,
    scopes: shardPlan.groups,
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
    mutationEligible,
  });
  const fingerprint = computeFingerprints(evidence);
  const verdicts = computeVerdicts(mutationEvidence(plan.mutation, evidence, shardPlan.groups));

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
      productionFiles: sortedUnique(shardPlan.groups.flatMap((group) => group.mutate)),
      fixtureFiles: [],
      sourceRevision: ctx.sourceRevision(),
    }),
    eligibility: plan.eligibility,
    // The M of "N of M eligible tests evaluated": the mutation-eligible tests.
    eligibleTests: work.tests
      .filter((test) => mutationEligible.has(test.file))
      .map((test) => test.id),
    shards: { planned: shardPlan.shards.length, complete: completeShards, incomplete },
    layer1Files: work.files.length,
    unrecordedFiles: work.files.filter((file) => !file.recorded).length,
    changedFiles: plan.changedFiles,
    notRun: {
      skipped: work.tests.filter((test) => test.state === 'skipped').length,
      unfinished: work.tests.filter((test) => test.state === 'pending').length,
    },
    layer0: existsSync(layout.layer0) ? readJsonFile(layout.layer0) : null,
    evidence,
    fingerprint,
    mutation: plan.mutation,
    verdicts,
    anchors: new Map(layer2.tests.map((test) => [test.id, test.anchor])),
    fingerprints: fingerprintMutants(observedMutants(merged), read),
    baseline,
  });
  if (report.changes.state === 'incompatible') {
    const why = report.changes.reason ?? 'incompatible';
    log(
      `merge: warning: --baseline ${options.baseline ?? ''} is not used (${why}); the report ` +
        'shows the incompatible-baseline banner',
    );
  }
  // The work directory exists: the plan was read from it.
  writeJson(layout.reportJson, report, true);
  writeFileSync(layout.reportMarkdown, renderMarkdown(report));
  writeFileSync(layout.issueBody, renderIssueBody(report));
  log(
    `merge: ${report.completeness.complete ? 'complete' : 'partial'} report: fingerprint ` +
      `${JSON.stringify(report.fingerprint.byVerdict)}; mutation ${plan.mutation}: ` +
      `${report.summary.evaluated}; verdicts ${JSON.stringify(report.summary.byVerdict)}`,
  );
  for (const entry of incomplete) log(`merge: incomplete ${entry.shard}: ${entry.reason}`);
  log(`merge: ${source} shard plan (${shardPlan.shards.length} shards)`);
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
  /** The scenario fingerprint verdict and rule (verdict/fingerprint.ts). */
  fingerprint: { verdict: string; rule: string };
}

/** The pairs of the fixture's expected.json; a malformed file, or one without a pair, throws. */
export function parseExpectedControls(data: unknown): ExpectedControlsPair[] {
  const pairs = isRecord(data) ? data.pairs : undefined;
  if (!Array.isArray(pairs)) throw new Error('expected.json: pairs must be an array');
  if (pairs.length === 0) {
    throw new Error('expected.json: pairs is empty, nothing would be checked');
  }
  return pairs.map((pair: unknown): ExpectedControlsPair => {
    const fingerprint = isRecord(pair) && isRecord(pair.fingerprint) ? pair.fingerprint : null;
    const ok =
      isRecord(pair) &&
      typeof pair.id === 'string' &&
      Array.isArray(pair.tests) &&
      pair.tests.length === 2 &&
      pair.tests.every((test: unknown) => typeof test === 'string') &&
      typeof pair.verdict === 'string' &&
      typeof pair.rule === 'string' &&
      fingerprint !== null &&
      typeof fingerprint.verdict === 'string' &&
      typeof fingerprint.rule === 'string';
    if (!ok) throw new Error(`expected.json: malformed pair ${JSON.stringify(pair)}`);
    return {
      id: String(pair.id),
      tests: [String(pair.tests[0]), String(pair.tests[1])],
      verdict: String(pair.verdict),
      rule: String(pair.rule),
      fingerprint: { verdict: String(fingerprint.verdict), rule: String(fingerprint.rule) },
    };
  });
}

export interface ControlsComparison {
  /** One line per expected pair, then one per problem of the oracle itself. */
  lines: string[];
  /**
   * Ids of the expected pairs whose verdict or rule differs or that have no verdict, then the
   * oracle's own failures: no expected pair, a repeat verdict of a pair expected.json does not
   * list, a case file without an expected pair.
   */
  differences: string[];
}

const REPEAT_VERDICTS: ReadonlySet<string> = new Set(['repeat-strong', 'repeat-weak']);

/**
 * Compares the mutation verdict and rule and the fingerprint verdict and rule of every expected
 * pair (findings and kept pairs), and keeps the oracle from passing vacuously: an empty expected
 * list fails, so does any repeat verdict (strong or weak) or fingerprint duplicate of a pair
 * expected.json does not list (the fixture expects no cross-pair candidate), and so does a
 * `*.case.ts` file of the fixture (`caseFiles`, relative to its root) that no expected pair
 * exercises.
 */
export function compareControls(
  expected: readonly ExpectedControlsPair[],
  verdicts: readonly Pick<PairVerdict, 'a' | 'b' | 'verdict' | 'rule'>[],
  fingerprints: readonly Pick<FingerprintPair, 'a' | 'b' | 'verdict' | 'rule'>[],
  prefix: string,
  caseFiles: readonly string[],
): ControlsComparison {
  const byKey = new Map(verdicts.map((verdict) => [pairKey(verdict.a, verdict.b), verdict]));
  const fingerprintOf = new Map(fingerprints.map((pair) => [pairKey(pair.a, pair.b), pair]));
  const lines: string[] = [];
  const differences: string[] = [];
  if (expected.length === 0) {
    differences.push('no expected pair');
    lines.push('DIFFERS  expected.json lists no pair');
  }
  for (const pair of expected) {
    const got = byKey.get(pairKey(prefix + pair.tests[0], prefix + pair.tests[1]));
    const want = `${pair.verdict}/${pair.rule}`;
    const actual = got === undefined ? 'no verdict' : `${got.verdict}/${got.rule}`;
    const holds = actual === want;
    if (!holds) differences.push(pair.id);
    lines.push(
      `${holds ? 'ok      ' : 'DIFFERS '} ${pair.id}: ${actual}${holds ? '' : ` (expected ${want})`}`,
    );
    const gotFingerprint = fingerprintOf.get(
      pairKey(prefix + pair.tests[0], prefix + pair.tests[1]),
    );
    const wantFingerprint = `${pair.fingerprint.verdict}/${pair.fingerprint.rule}`;
    const actualFingerprint =
      gotFingerprint === undefined
        ? 'no fingerprint'
        : `${gotFingerprint.verdict}/${gotFingerprint.rule}`;
    const fingerprintHolds = actualFingerprint === wantFingerprint;
    if (!fingerprintHolds) differences.push(`${pair.id} fingerprint`);
    lines.push(
      `${fingerprintHolds ? 'ok      ' : 'DIFFERS '} ${pair.id} fingerprint: ${actualFingerprint}` +
        (fingerprintHolds ? '' : ` (expected ${wantFingerprint})`),
    );
  }
  const listed = new Set(
    expected.map((pair) => pairKey(prefix + pair.tests[0], prefix + pair.tests[1])),
  );
  const local = (id: string): string => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
  const unlisted = verdicts.filter(
    (verdict) => REPEAT_VERDICTS.has(verdict.verdict) && !listed.has(pairKey(verdict.a, verdict.b)),
  );
  const unlistedDuplicates = fingerprints.filter(
    (pair) => pair.verdict === 'duplicate' && !listed.has(pairKey(pair.a, pair.b)),
  );
  for (const verdict of [...unlisted, ...unlistedDuplicates]) {
    const pair = `${local(verdict.a)} + ${local(verdict.b)}`;
    differences.push(`unlisted ${verdict.verdict}: ${pair}`);
    lines.push(`DIFFERS  unlisted pair ${pair}: ${verdict.verdict}/${verdict.rule}`);
  }
  const exercised = new Set(
    expected.flatMap((pair) => pair.tests.map((id) => parseTestId(id).file)),
  );
  for (const file of [...caseFiles].sort(byText).filter((entry) => !exercised.has(entry))) {
    differences.push(`case file without a pair: ${file}`);
    lines.push(`DIFFERS  ${file} has no expected pair`);
  }
  return { lines, differences };
}

/** The `*.case.ts` files of a controls fixture, relative to its root, sorted. */
export function controlsCaseFiles(fixtureDir: string): string[] {
  return readdirSync(fixtureDir, { recursive: true, encoding: 'utf8' })
    .map(toPosixRelative)
    .filter((file) => file.endsWith('.case.ts'))
    .sort(byText);
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

/**
 * Whether a stage needs dist/ before it starts: every stage that runs the fingerprint's tests
 * (coverage, plan without `--coverage`, value-flow, all, controls). Integration tests load the
 * built CLI and its worker scripts (E6), and the PDG index of scope `all` spawns analyze workers
 * from it.
 */
const needsDist = (options: CliOptions): boolean =>
  options.stage === 'plan'
    ? options.coverage === null
    : options.stage !== 'shard' && options.stage !== 'shards' && options.stage !== 'merge';

/** Throws a usage error naming the build step when `dist/` is missing (D11). */
function ensureDist(packageDir: string): void {
  if (!existsSync(path.join(packageDir, DIST_ENTRY))) {
    throw new UsageError(
      `${path.join(packageDir, DIST_ENTRY)} is missing: the fingerprint's integration tests and ` +
        `the PDG index need the built CLI; run \`${BUILD_COMMAND}\` from gitnexus/ first`,
    );
  }
}

async function runStage(options: CliOptions, ctx: StageContext): Promise<number> {
  const plan = (mode: RunMode, shards: number | null): Promise<PlanFile> =>
    runPlanStage(ctx, {
      mode,
      seed: options.seed,
      // The controls compare mutation verdicts: they always gather every group's evidence.
      mutation: options.stage === 'controls' ? 'all' : options.mutation,
      shards,
      budgetMs: options.deadlineMs ?? SHARD_DEADLINE_MS,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      speedFactor: options.speedFactor ?? DEFAULT_SPEED_FACTOR,
      coverage: options.coverage,
      changedSince: options.changedSince,
    });
  const shard = (index: number, of: number, selection: boolean): Promise<ShardStageReport> =>
    runShardStage(ctx, {
      index,
      of,
      sample: selection ? options.sample : null,
      groups: selection ? options.groups : null,
      deadlineMs: options.deadlineMs,
      concurrency: options.concurrency,
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
    case 'coverage': {
      const complete = await timed('coverage', () =>
        runCoverageStage(ctx, {
          index: options.index ?? 0,
          of: options.of ?? 1,
          mode: options.mode,
          mutation: options.mutation,
          concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
        }),
      );
      return complete ? 0 : 1;
    }
    case 'plan':
      await timed('plan', () => plan(options.mode, options.shards));
      return 0;
    case 'shard': {
      const report = await timed('shard', () => shard(options.index ?? 0, options.of ?? 1, true));
      return shardIssues(report).length === 0 ? 0 : 1;
    }
    case 'value-flow': {
      const result = await timed('value-flow', () =>
        runValueFlowStage(ctx, { concurrency: options.concurrency }),
      );
      return valueFlowIssues(result).length === 0 ? 0 : 1;
    }
    case 'shards':
      ctx.log(String(finalShardCount(ctx.layout)));
      return 0;
    case 'merge':
      return (await timed('merge', merge)).complete ? 0 : 1;
    case 'all':
    case 'controls': {
      // Value flow before the shard, as in CI: the shard isolates only what value flow leaves.
      await timed('plan', () => plan(options.mode, 1));
      await timed('value-flow', () => runValueFlowStage(ctx, { concurrency: options.concurrency }));
      if (finalShardCount(ctx.layout) > 0) await timed('shard', () => shard(0, 1, false));
      else ctx.log('scenario-map: no group to mutate: shard stage skipped');
      const merged = await timed('merge', merge);
      if (options.stage === 'all') return merged.complete ? 0 : 1;
      const fixtureRoot =
        options.mode.kind === 'controls' ? options.mode.fixtureRoot : DEFAULT_FIXTURE_ROOT;
      const fixtureDir = path.join(ctx.repoRoot, fixtureRoot);
      const expected = parseExpectedControls(readJsonFile(path.join(fixtureDir, 'expected.json')));
      const comparison = compareControls(
        expected,
        [...merged.verdicts.pairs, ...merged.verdicts.kept],
        [...merged.report.fingerprint.pairs, ...merged.report.fingerprint.kept],
        `${toPackagePath(fixtureRoot)}/`,
        controlsCaseFiles(fixtureDir),
      );
      for (const line of comparison.lines) ctx.log(`controls: ${line}`);
      ctx.log(
        comparison.differences.length === 0
          ? `controls: all ${expected.length} pairs match expected.json, no unlisted repeat, ` +
              'every case file exercised'
          : `controls: ${comparison.differences.length} differences from expected.json: ` +
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
    if (overlaps(deps.repoRoot, options.workDir)) {
      throw new UsageError(
        `--work ${options.workDir} must lie outside the checkout ${deps.repoRoot}`,
      );
    }
    if (needsDist(options)) ensureDist(deps.packageDir);
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
