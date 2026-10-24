/**
 * Shard plan of Layer 3 (U7, KTD7, KTD14, KTD17, R11): each candidate group's whole-file mutate
 * scope, its cost estimate, a deterministic bin-packing of the groups into shards, the deadline
 * check a shard makes before it starts a group, and how the merge stage reads each pair's schedule.
 *
 * Mutate scope (KTD7, {@link groupScope}). The production files (types.ts
 * `productionFilePredicate`) that any test of the group executed (Layer 1 provenance, the
 * coverage work file's `executedFiles`) or statically imports (the Phase 0 classifier's
 * `FileVerdict.closure` of its test file), whole, with no line ranges. Per test, the excluded
 * files are the repo files under `gitnexus/` it executed, or its test file statically imports
 * (design §5.4: static closure), that are neither test files (`test/**`, `*.test|spec|case.*`) nor
 * mutated, such as `gitnexus/tools/` code; they cap the test at weak (`excluded-file`). Nothing is
 * dropped silently: tests without known provenance and test files whose classifier closure is
 * incomplete (a rejected file's walk stops at the rejected import, as for every controls fixture
 * file, which imports from `test/fixtures/`) are listed.
 *
 * Cost (KTD17, {@link estimateGroupCost}), in milliseconds: a fixed per-run overhead, plus the
 * mutated bytes times the group's tests, plus the isolation term: candidate pairs times covered
 * mutants times {@link ISOLATION_RUNS} runs at the measured fresh-process cost. The covered
 * mutants are not known before the run; the estimate takes every mutant of the mutate files
 * (mutated bytes times mutants per byte), an upper bound.
 *
 * Packing ({@link packShards}). A group is never split, so both tests of every pair run in one
 * run. A group whose estimate exceeds one shard's budget is not run (`group-over-budget`). The
 * others go, largest estimate first (ties by group id), to the least-loaded shard (ties by the
 * lower index); each shard runs its groups in group-id order. The result depends only on the
 * set of estimates, never on input order.
 *
 * Deadline ({@link fitsBeforeDeadline}). A shard starts a group only when the group's estimate
 * fits the time left before {@link SHARD_DEADLINE_MS}; a group it never starts writes no result.
 *
 * Schedule ({@link resolvePairSchedules}). A pair is evaluated only when its group ran to
 * completion with both its tests, against the plan's run manifest. Otherwise it is Inconclusive:
 * `group-over-budget`; `not-scheduled` (no shard reported the group, or the group run lacks one
 * of its tests, R11); `manifest-mismatch` (the result was verified against another run manifest,
 * or the shard's prepared copy differed from it, KTD14); or the reason of a failed group run.
 *
 * Library only; pure. The plan stage (U14) builds the plan; run-group.ts runs one shard of it.
 */
import { parseTestId } from '../../mutation/runner/test-ids.js';
import { productionFilePredicate } from '../types.js';

export const SHARD_PLAN_SCHEMA_VERSION = 1;

/** A shard starts no group whose estimate does not fit before this deadline (KTD17). */
export const SHARD_DEADLINE_MS = 300 * 60_000;

/** The isolation pass's runs per pair: together, and each test alone (KTD9). */
export const ISOLATION_RUNS = 3;

export interface CostModel {
  /** Fixed cost of one group run: two baselines, Stryker's start, prepare and dry run. */
  perRunMs: number;
  /** Mutant-run cost per mutated byte and group test. */
  perByteTestMs: number;
  /** Mutants per mutated byte: estimates the covered mutants of the isolation term. */
  mutantsPerByte: number;
  /** Measured cost of one mutant run in a fresh process (`--max-test-runner-reuse 1`). */
  freshProcessMs: number;
}

/**
 * First calibration, from one controls-fixture group run (U7, WSL2, concurrency 2): a group of
 * 2 tests and 11 mutants took about 98 s (two baselines 6 s, the scope driver's prepare and
 * Stryker's start about 70 s, the mutant runs about 0.25 s per mutant and covering test), and
 * the fixture holds about 0.04 mutants per source byte. `freshProcessMs` comes from the isolation
 * pass (U8) on four controls pairs (same machine, concurrency 2, `maxTestRunnerReuse` 1): 54 mutant
 * runs in 10 Stryker runs took 298 s from the dry run to the last sidecar, about 5.5 s per mutant;
 * each of those runs also cost about 130 s besides its mutant runs (two baselines, the scope
 * driver's prepare, Stryker's start and its test-runner processes), which the isolation term does
 * not count. The full local run (U14) re-measures all four on the eligible category.
 */
export const DEFAULT_COST_MODEL: Readonly<CostModel> = Object.freeze({
  perRunMs: 100_000,
  perByteTestMs: 10,
  mutantsPerByte: 0.04,
  freshProcessMs: 5_500,
});

// ── Mutate scope (KTD7) ───────────────────────────────────────────────────

/** A test's Layer 1 provenance, as the coverage work file records it. */
export interface TestProvenance {
  known: boolean;
  /** Repo paths, `node_modules/…` and `outside:…` entries. */
  executedFiles: readonly string[];
}

/** A test file's static import closure (repo paths), from the Phase 0 classifier. */
export interface StaticClosure {
  closure: readonly string[];
  /** False when the classifier rejected the file: its walk stops at a rejected import. */
  complete: boolean;
}

export interface ExcludedFiles {
  test: string;
  mark: 'excluded-file';
  /** Repo paths, sorted. */
  files: string[];
}

export interface GroupScope {
  /** Candidate group id. */
  id: string;
  /** Phase 0 test ids, sorted. */
  tests: string[];
  /** Package paths of their files, sorted. */
  testFiles: string[];
  /** Candidate pairs of the group. */
  pairs: number;
  /** Repo paths of the whole production files to mutate, sorted. */
  mutate: string[];
  /** Tests with excluded files, sorted by test. */
  excluded: ExcludedFiles[];
  /** Test files (package paths) whose static closure is incomplete or missing. */
  closureIncomplete: string[];
  /** Tests whose Layer 1 provenance is unknown or missing. */
  provenanceUnknown: string[];
}

export interface GroupScopeInput {
  group: { id: string; tests: readonly string[]; pairs: number };
  /** Per Phase 0 test id. */
  provenance: ReadonlyMap<string, TestProvenance>;
  /** Per test file (package path). */
  closures: ReadonlyMap<string, StaticClosure>;
  /** Extra path-map roots (controls mode). */
  extraRoots?: readonly string[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(byText);

/** Test-side names, as types.ts: never production, never excluded. */
const TEST_NAME = /\.(test|spec|case)\.[mc]?[jt]sx?$/;
/** Files that hold code; a data file in a closure (`.json`) is never an excluded file. */
const SCRIPT = /\.[mc]?[jt]sx?$/;
const PACKAGE_PREFIX = 'gitnexus/';

/** A repo path under `gitnexus/test/`, or named like a test (KTD7 test files). */
export const isTestPath = (repoPath: string): boolean =>
  repoPath.startsWith(`${PACKAGE_PREFIX}test/`) || TEST_NAME.test(repoPath);

/** KTD7 excluded files: repo files under `gitnexus/` that are neither test files nor mutated. */
export function excludedFiles(files: readonly string[], mutate: ReadonlySet<string>): string[] {
  return sortedUnique(
    files.filter(
      (file) =>
        file.startsWith(PACKAGE_PREFIX) &&
        SCRIPT.test(file) &&
        !isTestPath(file) &&
        !mutate.has(file),
    ),
  );
}

/** Only repo paths can be production; `node_modules/…` and `outside:…` entries cannot. */
const isRepoPath = (file: string): boolean =>
  file.startsWith(PACKAGE_PREFIX) || file.startsWith('gitnexus-shared/');

/** The group's KTD7 mutate scope and per-test excluded files; see the module comment. */
export function groupScope(input: GroupScopeInput): GroupScope {
  const production = productionFilePredicate(input.extraRoots ?? []);
  const tests = sortedUnique(input.group.tests);
  const fileOf = new Map(tests.map((test) => [test, parseTestId(test).file]));
  const testFiles = sortedUnique(fileOf.values());
  const executed = (test: string): readonly string[] =>
    input.provenance.get(test)?.executedFiles ?? [];
  const closure = (test: string): readonly string[] =>
    input.closures.get(fileOf.get(test) ?? '')?.closure ?? [];
  const mutate = sortedUnique(
    tests
      .flatMap((test) => [...executed(test), ...closure(test)])
      .filter((file) => isRepoPath(file) && production(file)),
  );
  const mutated = new Set(mutate);
  const excluded = tests.flatMap((test): ExcludedFiles[] => {
    const files = excludedFiles([...executed(test), ...closure(test)], mutated);
    return files.length === 0 ? [] : [{ test, mark: 'excluded-file', files }];
  });
  return {
    id: input.group.id,
    tests,
    testFiles,
    pairs: input.group.pairs,
    mutate,
    excluded,
    closureIncomplete: testFiles.filter((file) => input.closures.get(file)?.complete !== true),
    provenanceUnknown: tests.filter((test) => input.provenance.get(test)?.known !== true),
  };
}

// ── Cost and packing (KTD17) ──────────────────────────────────────────────

export interface GroupCostInput {
  tests: number;
  pairs: number;
  /** Total bytes of the group's mutate files. */
  mutatedBytes: number;
}

/** The KTD17 estimate of one group, in whole milliseconds; see the module comment. */
export function estimateGroupCost(
  input: GroupCostInput,
  model: Readonly<CostModel> = DEFAULT_COST_MODEL,
): number {
  const coveredMutants = input.mutatedBytes * model.mutantsPerByte;
  return Math.ceil(
    model.perRunMs +
      input.mutatedBytes * input.tests * model.perByteTestMs +
      input.pairs * coveredMutants * ISOLATION_RUNS * model.freshProcessMs,
  );
}

export interface GroupEstimate {
  id: string;
  estimateMs: number;
}

export interface ShardAssignment {
  /** 0-based shard index (the CI matrix entry). */
  index: number;
  /** Group ids in run order (sorted). */
  groups: string[];
  /** Sum of the groups' estimates. */
  estimateMs: number;
}

export interface Packing {
  shards: ShardAssignment[];
  /** Groups never run, sorted: their pairs are `group-over-budget`. */
  overBudget: string[];
}

function checkEstimates(groups: readonly GroupEstimate[]): void {
  const seen = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.id)) throw new Error(`shard plan: group ${group.id} is listed twice`);
    seen.add(group.id);
    if (!Number.isFinite(group.estimateMs) || group.estimateMs < 0) {
      throw new Error(`shard plan: group ${group.id} has an invalid estimate`);
    }
  }
}

/** Bin-packs the groups into `shards` shards; see the module comment. */
export function packShards(
  groups: readonly GroupEstimate[],
  shards: number,
  budgetMs: number = SHARD_DEADLINE_MS,
): Packing {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`shard plan: the shard count must be a positive integer, got ${shards}`);
  }
  checkEstimates(groups);
  const overBudget = groups.filter((group) => group.estimateMs > budgetMs);
  const runnable = groups
    .filter((group) => group.estimateMs <= budgetMs)
    .sort((a, b) => b.estimateMs - a.estimateMs || byText(a.id, b.id));
  const loads = Array.from(
    { length: shards },
    (_, index): ShardAssignment => ({ index, groups: [], estimateMs: 0 }),
  );
  for (const group of runnable) {
    const target = loads.reduce((best, shard) =>
      shard.estimateMs < best.estimateMs ? shard : best,
    );
    target.groups.push(group.id);
    target.estimateMs += group.estimateMs;
  }
  return {
    shards: loads.map((shard) => ({ ...shard, groups: shard.groups.sort(byText) })),
    overBudget: sortedUnique(overBudget.map((group) => group.id)),
  };
}

/**
 * The fewest shards, up to `maxShards`, whose packing keeps every shard within the budget
 * (over-budget groups never run and do not count); `maxShards` when none does.
 */
export function shardsNeeded(
  groups: readonly GroupEstimate[],
  budgetMs: number,
  maxShards: number,
): number {
  for (let shards = 1; shards < maxShards; shards++) {
    const packing = packShards(groups, shards, budgetMs);
    if (packing.shards.every((shard) => shard.estimateMs <= budgetMs)) return shards;
  }
  return maxShards;
}

/** Whether a shard that has run for `elapsedMs` may start a group estimated at `estimateMs`. */
export const fitsBeforeDeadline = (
  estimateMs: number,
  elapsedMs: number,
  deadlineMs: number = SHARD_DEADLINE_MS,
): boolean => elapsedMs + estimateMs <= deadlineMs;

// ── Plan ──────────────────────────────────────────────────────────────────

export interface PlannedGroup extends GroupScope {
  mutatedBytes: number;
  estimateMs: number;
}

export interface ShardPlan extends Packing {
  schemaVersion: typeof SHARD_PLAN_SCHEMA_VERSION;
  budgetMs: number;
  costModel: CostModel;
  /** Every group, sorted by id. */
  groups: PlannedGroup[];
}

export interface ShardPlanInput {
  scopes: readonly GroupScope[];
  /** Byte size of a repo file. */
  sizeOf: (repoPath: string) => number;
  /** Number of shards (see {@link shardsNeeded}). */
  shards: number;
  /** One shard's budget; defaults to {@link SHARD_DEADLINE_MS}. */
  budgetMs?: number;
  costModel?: Readonly<CostModel>;
}

/** Estimates every group and packs them; pure given `sizeOf`. */
export function buildShardPlan(input: ShardPlanInput): ShardPlan {
  const budgetMs = input.budgetMs ?? SHARD_DEADLINE_MS;
  const costModel = { ...(input.costModel ?? DEFAULT_COST_MODEL) };
  const groups = [...input.scopes]
    .sort((a, b) => byText(a.id, b.id))
    .map((scope): PlannedGroup => {
      const mutatedBytes = scope.mutate.reduce((sum, file) => sum + input.sizeOf(file), 0);
      const estimateMs = estimateGroupCost(
        { tests: scope.tests.length, pairs: scope.pairs, mutatedBytes },
        costModel,
      );
      return { ...scope, mutatedBytes, estimateMs };
    });
  return {
    schemaVersion: SHARD_PLAN_SCHEMA_VERSION,
    budgetMs,
    costModel,
    groups,
    ...packShards(groups, input.shards, budgetMs),
  };
}

// ── Schedule (R11) ────────────────────────────────────────────────────────

/** Why a group run gave no usable observations; its pairs are Inconclusive with the reason. */
export type GroupStatusReason =
  /** The shard's prepared copy, or a group test, does not match the run manifest (KTD14). */
  | 'manifest-mismatch'
  /** A plain Vitest baseline did not pass every test of the group (KTD8). */
  | 'baseline-failed'
  /** The two baselines ran different test identities (KTD8). */
  | 'baseline-unstable'
  /** Stryker's dry run did not pass with the baselines' identities (KTD8). */
  | 'dry-run-unstable'
  /** The generated Stryker config lacks perTest, disableBail or static mutants (KTD8). */
  | 'config-invalid'
  /** The scope driver failed: prepare rejected a file or Stryker exited non-zero. */
  | 'stryker-failed';

/** What the schedule reads of one group result (run-group.ts `GroupObservations`). */
export interface GroupOutcome {
  group: string;
  shard: number;
  /** Digest of the run manifest the shard verified its prepared copy against. */
  manifestDigest: string;
  status: 'complete' | 'inconclusive';
  reason: GroupStatusReason | null;
  detail: string | null;
  /** Phase 0 ids of the tests the group run covered. */
  tests: string[];
}

export type ScheduleReason = GroupStatusReason | 'group-over-budget' | 'not-scheduled';

export interface PairRef {
  a: string;
  b: string;
  group: string;
}

export interface PairSchedule extends PairRef {
  status: 'evaluated' | 'inconclusive';
  /** Null when evaluated. */
  reason: ScheduleReason | null;
  /** The shard whose result decided; null when none did. */
  shard: number | null;
  detail: string | null;
}

export interface ScheduleInput {
  plan: Pick<Packing, 'overBudget'>;
  /** Digest of the plan's run manifest. */
  manifestDigest: string;
  pairs: readonly PairRef[];
  /** Every group result found, from every shard. */
  outcomes: readonly GroupOutcome[];
}

/** Each pair's schedule, in input order; see the module comment. */
export function resolvePairSchedules(input: ScheduleInput): PairSchedule[] {
  const overBudget = new Set(input.plan.overBudget);
  const byGroup = new Map<string, GroupOutcome[]>();
  for (const outcome of [...input.outcomes].sort((x, y) => x.shard - y.shard)) {
    byGroup.set(outcome.group, [...(byGroup.get(outcome.group) ?? []), outcome]);
  }
  return input.pairs.map((pair): PairSchedule => {
    const inconclusive = (
      reason: ScheduleReason,
      shard: number | null,
      detail: string | null,
    ): PairSchedule => ({ ...pair, status: 'inconclusive', reason, shard, detail });
    if (overBudget.has(pair.group)) return inconclusive('group-over-budget', null, null);
    const outcomes = byGroup.get(pair.group) ?? [];
    if (outcomes.length === 0) return inconclusive('not-scheduled', null, null);
    const foreign = outcomes.find((outcome) => outcome.manifestDigest !== input.manifestDigest);
    if (foreign !== undefined) {
      return inconclusive(
        'manifest-mismatch',
        foreign.shard,
        `verified against run manifest ${foreign.manifestDigest}`,
      );
    }
    const failed = outcomes.find((outcome) => outcome.status === 'inconclusive');
    if (failed !== undefined) {
      return inconclusive(failed.reason ?? 'not-scheduled', failed.shard, failed.detail);
    }
    const [first] = outcomes;
    if (!first.tests.includes(pair.a) || !first.tests.includes(pair.b)) {
      return inconclusive('not-scheduled', first.shard, 'the group run lacks a test of the pair');
    }
    return { ...pair, status: 'evaluated', reason: null, shard: first.shard, detail: null };
  });
}
