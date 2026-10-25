/**
 * Full isolation pass of the scenario map (U8, R7, KTD8, KTD9, design §5.4 "Kill validity"):
 * strong evidence needs each test's per-mutant outcomes to agree when the pair runs together and
 * when each test runs alone, every mutant in a fresh process. It catches order dependence and
 * leaking state that hide a distinguishing mutant.
 *
 * Repeat stage ({@link selectRepeatStagePairs}, pure). A candidate pair reaches it when, in its
 * group's `main` run (observations.ts `comparePair`):
 *   - the kill sets are known, equal (`sameKills` true) and non-empty (design §2: an empty kill
 *     set is never part of a repeat), and no universe mutant has another class (R7: a timeout,
 *     runtime, hook or infrastructure outcome makes the pair Inconclusive anyway);
 *   - the canonical path is the same: over the common universe, each mutant is covered, static or
 *     uncovered alike for both tests;
 *   - the checks-and-context keys (U5 `checksContextKey`) are present and equal;
 *   - the input facets (U6) have equal fingerprints and no residual difference (D1: a residual
 *     difference makes the pair facet-unequal).
 * Every failed condition is listed (`misses`). The pair's isolation universe is the common
 * universe's mutants either test was exposed to: covered, static, or run against it (a row).
 *
 * Plan ({@link planIsolation}, pure; KTD9). One `together` run per selected pair (lineage: the
 * {@link pairKey}, tests: both) over the pair's universe, and one `alone` run per test (lineage:
 * the test id), shared by all its pairs, over the union of their universes. Mutate is the
 * universe as Stryker ranges ({@link mutateRangesOf}): each mutant's report span (1-based lines and
 * columns, end exclusive) becomes `<file>:<line>:<column - 1>-<line>:<column - 1>`, since Stryker
 * matches ranges against Babel locations (1-based lines, 0-based columns) and reports columns one
 * higher (verified against @stryker-mutator/core 10 `project-reader.js` and the instrumenter's
 * `locationIncluded`). A range holds every mutant nested in its node, so the run's observations are
 * then filtered by global id; ranges inside another range of the same file are dropped.
 *
 * Runs ({@link runIsolationRun}). Each run is a validated Stryker run (run-group.ts
 * `runMutationRun`: two baselines, the KTD8 config check, the scope driver, the dry run against the
 * baselines) with the run's tests as `testIds` and `maxTestRunnerReuse` forced to
 * {@link ISOLATION_TEST_RUNNER_REUSE}: every mutant gets a fresh test-runner process with its
 * modules reset (design §5.4). Its observations (kind `together` or `alone`, the run's lineage;
 * observations.ts compact model: a run universe plus the explicit observations) are kept for the
 * universe only; universe mutants the run did not evaluate are `missing`. Each result
 * ({@link IsolationRunResult}, schema 2: the explicit observations as rows of `runUniverse`; a
 * schema 1 file, one observation per test and mutant, is rejected) is written at once, with its
 * wall clock, baselines and Stryker summary (the KTD17 `freshProcessMs` calibration source). Work
 * layout:
 *   isolation/<group>/<run id>.json   run result   groups/<group>/<run id>/   scratch
 * where the run id is `<kind>-` plus 16 hex digits of sha1 over the lineage.
 *
 * Comparison ({@link evaluateIsolation}, pure). Only runs verified against the plan's run manifest
 * count (another digest is `run:manifest-mismatch`, KTD14). Per test of the pair, over its universe,
 * three observations: `main`, the `together` run, and the test's `alone` run (attempts folded by
 * observations.ts `mergeObservations`). Their coverage (`static`, `covered` or `not-covered`) and
 * their outcome class must agree; so must the unmutated baseline (the main run's group passed:
 * `passed`; a run's baselines give `passed` or the failing test's class). Results:
 *   agrees       every value of every test agrees;
 *   disagrees    two known values differ (`isolation-disagrees`): the entries name each mutant,
 *                or a null mutant for the baseline; it wins over unknown;
 *   unknown      a value is missing or invalid (`isolation-unknown`): a missing result is never a
 *                non-kill (design §5.4); the verdict engine makes both Inconclusive;
 *   not-run      the pair did not reach the repeat stage (`not-repeat-stage`), or one of its runs
 *                has no result (`not-scheduled`): the pair caps at weak (design §2).
 * Every result carries the KTD9 disqualifier `hook-stratum-unvalidated` (cap weak) when a mutant
 * of the pair's path or kills has an observation of either test, in any of its runs, whose hook
 * marker is not false (null, no marker, counts: fail closed). The cap holds until a gate 3 scope
 * with a non-empty hook stratum passes.
 *
 * Library only; the scenario-map CLI (U14) plans and runs the pass per shard, and the verdict
 * engine (U12) reads {@link IsolationResult}s. Every runner is injected (run-group.ts
 * `GroupRunDeps`), so unit tests never spawn Vitest or Stryker.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseTestId } from '../../mutation/runner/test-ids.js';
import { readJsonFile } from '../../mutation/shared/fs.js';
import { residualDifference, type InputFacet } from '../facet/input-facet.js';
import {
  MAIN_LINEAGE,
  comparePair,
  decodeObservations,
  encodeObservations,
  extractObservations,
  indexObservations,
  isRunUniverse,
  lineageOf,
  mergeObservations,
  stateOf,
  type LineageObservations,
  type MergedObservations,
  type Observation,
  type ObservationIndex,
  type ObservationRow,
  type ObservationState,
  type PairComparison,
  type RunKey,
  type RunUniverse,
} from './observations.js';
import type { GroupStatusReason, PairRef } from './plan-shards.js';
import {
  DEFAULT_STRYKER_SETTINGS,
  defaultGroupRunDeps,
  observationsFile,
  runMutationRun,
  type BaselineSummary,
  type GroupRunDeps,
  type ScenarioRunManifest,
  type StrykerSettings,
  type StrykerSummary,
} from './run-group.js';

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(byText);
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The lineage of a pair's `together` run: its two tests, sorted, as a JSON array. */
export const pairKey = (a: string, b: string): string => JSON.stringify([a, b].sort(byText));

/** The `main` lineage of each group, indexed. */
const mainIndex = (merged: MergedObservations): ObservationIndex =>
  indexObservations(merged, (run) => run.kind === 'main' && run.lineage === MAIN_LINEAGE);

/** The main run of a group. */
const mainRun = (group: string): RunKey => ({ group, kind: 'main', lineage: MAIN_LINEAGE });

/** A test's observation of a mutant in a lineage; undefined without the lineage or one. */
const stateIn = (
  view: LineageObservations | undefined,
  test: string,
  mutant: string,
): ObservationState | undefined => (view === undefined ? undefined : stateOf(view, test, mutant));

/** Coverage of a mutant for a test in one run. */
const coverageOf = (entry: ObservationState): 'static' | 'covered' | 'not-covered' =>
  entry.static ? 'static' : entry.covered ? 'covered' : 'not-covered';

/** Whether a test was exposed to the mutant: covered, static, or run against it. */
const exposed = (entry: ObservationState | undefined): boolean =>
  entry !== undefined && (entry.covered || entry.static || entry.sources.includes('row'));

// ── Repeat stage ──────────────────────────────────────────────────────────

/** What the repeat-stage selection reads; see the module comment. */
export interface RepeatStageFacts {
  /** Merged observations; only each pair's group `main` lineage is read. */
  merged: MergedObservations;
  /** U5 checks-and-context key per Phase 0 test id; null or absent when the test has none. */
  checksContext: ReadonlyMap<string, string | null>;
  /** U6 input facet per Phase 0 test id; absent when it was not computed. */
  facets: ReadonlyMap<string, InputFacet>;
}

export type RepeatStageMiss =
  /** The main run's kill sets are not comparable (`sameKills` null: unknown mutants, no run). */
  | 'kills-unknown'
  | 'kills-differ'
  /** Both kill sets are empty (design §2). */
  | 'kills-empty'
  /** A universe mutant has a class other than an assertion kill or survived (R7). */
  | 'other-classes'
  | 'path-differs'
  | 'checks-context-missing'
  | 'checks-context-differs'
  | 'facet-missing'
  | 'facet-differs'
  /** Equal fingerprints with a residual difference (KTD6 guard, D1). */
  | 'facet-residual';

/**
 * A main-run comparison without its universe and unknown lists, their sizes kept: what a decision
 * retains, so a decision per candidate pair stays O(kills), not O(pairs × mutants).
 */
export type ComparisonSummary = Omit<PairComparison, 'universe' | 'unknown'> & {
  universeSize: number;
  unknownSize: number;
};

const summaryOf = ({ universe, unknown, ...rest }: PairComparison): ComparisonSummary => ({
  ...rest,
  universeSize: universe.length,
  unknownSize: unknown.length,
});

export interface RepeatStageDecision extends PairRef {
  /** {@link pairKey}. */
  key: string;
  selected: boolean;
  /** Failed conditions, sorted; empty when selected. */
  misses: RepeatStageMiss[];
  /** The main run's comparison, summarised. */
  comparison: ComparisonSummary;
  /** Common-universe mutants either test was exposed to, sorted: the isolation universe. */
  universe: string[];
}

function facetMisses(a: InputFacet | undefined, b: InputFacet | undefined): RepeatStageMiss[] {
  if (a === undefined || b === undefined) return ['facet-missing'];
  if (a.fingerprint !== b.fingerprint) return ['facet-differs'];
  return residualDifference(a, b).length > 0 ? ['facet-residual'] : [];
}

function checksMiss(a: string | null | undefined, b: string | null | undefined): RepeatStageMiss[] {
  if (a === null || a === undefined || b === null || b === undefined) {
    return ['checks-context-missing'];
  }
  return a === b ? [] : ['checks-context-differs'];
}

function killMisses(
  comparison: Pick<PairComparison, 'sameKills' | 'killsA' | 'otherClasses'>,
): RepeatStageMiss[] {
  const misses: RepeatStageMiss[] = [];
  if (comparison.sameKills === null) misses.push('kills-unknown');
  if (comparison.sameKills === false) misses.push('kills-differ');
  if (comparison.sameKills === true && comparison.killsA.length === 0) misses.push('kills-empty');
  if (comparison.otherClasses.length > 0) misses.push('other-classes');
  return misses;
}

function decide(
  pair: PairRef,
  index: ObservationIndex,
  facts: RepeatStageFacts,
): RepeatStageDecision {
  const run = mainRun(pair.group);
  const comparison = comparePair(index, run, pair.a, pair.b);
  const view = lineageOf(index, run);
  const pathDiffers = comparison.universe.some((mutant) => {
    const [x, y] = [stateIn(view, pair.a, mutant), stateIn(view, pair.b, mutant)];
    return x === undefined || y === undefined || coverageOf(x) !== coverageOf(y);
  });
  const misses = [
    ...killMisses(comparison),
    ...(pathDiffers ? (['path-differs'] as const) : []),
    ...checksMiss(facts.checksContext.get(pair.a), facts.checksContext.get(pair.b)),
    ...facetMisses(facts.facets.get(pair.a), facts.facets.get(pair.b)),
  ].sort(byText);
  return {
    ...pair,
    key: pairKey(pair.a, pair.b),
    selected: misses.length === 0,
    misses,
    comparison: summaryOf(comparison),
    universe: comparison.universe.filter(
      (mutant) => exposed(stateIn(view, pair.a, mutant)) || exposed(stateIn(view, pair.b, mutant)),
    ),
  };
}

/** Each pair's repeat-stage decision, in input order; pure. See the module comment. */
export function selectRepeatStagePairs(
  pairs: readonly PairRef[],
  facts: RepeatStageFacts,
): RepeatStageDecision[] {
  const index = mainIndex(facts.merged);
  return pairs.map((pair) => decide(pair, index, facts));
}

// ── Plan ──────────────────────────────────────────────────────────────────

export type IsolationRunKind = 'together' | 'alone';

export interface IsolationRunSpec {
  /** `<kind>-<16 hex digits of sha1 over the lineage>`: path-safe. */
  id: string;
  group: string;
  kind: IsolationRunKind;
  /** The {@link pairKey} of a together run; the test id of an alone run. */
  lineage: string;
  /** Phase 0 test ids, sorted. */
  tests: string[];
  /** Package paths of their files, sorted. */
  testFiles: string[];
  /** Global mutant ids, sorted. */
  universe: string[];
  /** Driver mutate entries ({@link mutateRangesOf}). */
  mutate: string[];
  /** Keys of the pairs that read the run, sorted. */
  pairs: string[];
}

export const ISOLATION_PLAN_SCHEMA_VERSION = 1;

export interface IsolationPlan {
  schemaVersion: typeof ISOLATION_PLAN_SCHEMA_VERSION;
  /** Sorted by group, kind and lineage. */
  runs: IsolationRunSpec[];
}

export interface MutantSpan {
  /** Repo path of the original file. */
  file: string;
  /** Report positions: 1-based lines and columns, end exclusive. */
  start: { line: number; column: number };
  end: { line: number; column: number };
}

/** tools/mutation/prepare/mutant-identity.ts `formatGlobalId`. */
const GLOBAL_ID = /^(.+)@[0-9a-f]{16}:(\d+):(\d+)-(\d+):(\d+):[^:]+:[0-9a-f]{16}$/;

/** The file and report span of a global mutant id; throws for another string. */
export function spanOfGlobalId(globalId: string): MutantSpan {
  const match = GLOBAL_ID.exec(globalId);
  if (match === null) throw new Error(`isolation: ${JSON.stringify(globalId)} is no global id`);
  const [, file, startLine, startColumn, endLine, endColumn] = match;
  return {
    file,
    start: { line: Number(startLine), column: Number(startColumn) },
    end: { line: Number(endLine), column: Number(endColumn) },
  };
}

const before = (a: MutantSpan['start'], b: MutantSpan['start']): boolean =>
  a.line < b.line || (a.line === b.line && a.column <= b.column);

/** Whether `inner` lies inside `outer` (same file). */
const contains = (outer: MutantSpan, inner: MutantSpan): boolean =>
  outer.file === inner.file && before(outer.start, inner.start) && before(inner.end, outer.end);

/**
 * The driver mutate entries covering a universe: one Stryker range per mutant span, Babel columns
 * (report column minus one), spans inside another dropped, sorted by file and position.
 */
export function mutateRangesOf(universe: readonly string[]): string[] {
  const spans = [
    ...new Map(
      universe.map((globalId) => {
        const span = spanOfGlobalId(globalId);
        return [JSON.stringify(span), span];
      }),
    ).values(),
  ];
  return spans
    .filter((span) => !spans.some((other) => other !== span && contains(other, span)))
    .sort(
      (a, b) =>
        byText(a.file, b.file) ||
        a.start.line - b.start.line ||
        a.start.column - b.start.column ||
        a.end.line - b.end.line ||
        a.end.column - b.end.column,
    )
    .map(
      (span) =>
        `${span.file}:${span.start.line}:${span.start.column - 1}-` +
        `${span.end.line}:${span.end.column - 1}`,
    );
}

/** The run id of a run kind and lineage. */
export const isolationRunId = (kind: IsolationRunKind, lineage: string): string =>
  `${kind}-${sha1(lineage).slice(0, 16)}`;

function runSpec(
  group: string,
  kind: IsolationRunKind,
  lineage: string,
  tests: readonly string[],
  universe: Iterable<string>,
  pairs: Iterable<string>,
): IsolationRunSpec {
  const sortedTests = sortedUnique(tests);
  const mutants = sortedUnique(universe);
  return {
    id: isolationRunId(kind, lineage),
    group,
    kind,
    lineage,
    tests: sortedTests,
    testFiles: sortedUnique(sortedTests.map((test) => parseTestId(test).file)),
    universe: mutants,
    mutate: mutateRangesOf(mutants),
    pairs: sortedUnique(pairs),
  };
}

/** The isolation runs of the selected pairs; pure. See the module comment. */
export function planIsolation(decisions: readonly RepeatStageDecision[]): IsolationPlan {
  const selected = decisions.filter((decision) => decision.selected);
  const alone = new Map<
    string,
    { group: string; test: string; universe: Set<string>; pairs: Set<string> }
  >();
  for (const decision of selected) {
    for (const test of [decision.a, decision.b]) {
      const key = JSON.stringify([decision.group, test]);
      const entry = alone.get(key) ?? {
        group: decision.group,
        test,
        universe: new Set<string>(),
        pairs: new Set<string>(),
      };
      for (const mutant of decision.universe) entry.universe.add(mutant);
      entry.pairs.add(decision.key);
      alone.set(key, entry);
    }
  }
  const runs = [
    ...selected.map((decision) =>
      runSpec(
        decision.group,
        'together',
        decision.key,
        [decision.a, decision.b],
        decision.universe,
        [decision.key],
      ),
    ),
    ...[...alone.values()].map((entry) =>
      runSpec(entry.group, 'alone', entry.test, [entry.test], entry.universe, entry.pairs),
    ),
  ];
  const unique = [
    ...new Map(runs.map((run) => [JSON.stringify([run.group, run.id]), run])).values(),
  ];
  return {
    schemaVersion: ISOLATION_PLAN_SCHEMA_VERSION,
    runs: unique.sort(
      (a, b) => byText(a.group, b.group) || byText(a.kind, b.kind) || byText(a.lineage, b.lineage),
    ),
  };
}

// ── Runs ──────────────────────────────────────────────────────────────────

/** Stryker's `maxTestRunnerReuse` in every isolation run: a fresh process per mutant (KTD9). */
export const ISOLATION_TEST_RUNNER_REUSE = 1;

/** 2: the compact model, a run universe plus explicit observations as rows (observations.ts). */
export const ISOLATION_RUN_SCHEMA_VERSION = 2;

/** One isolation run's result; see the module comment. */
export interface IsolationRunResult extends Omit<IsolationRunSpec, 'pairs'> {
  schemaVersion: typeof ISOLATION_RUN_SCHEMA_VERSION;
  shard: number;
  manifestDigest: string;
  status: 'complete' | 'inconclusive';
  reason: GroupStatusReason | null;
  detail: string | null;
  settings: StrykerSettings;
  baselines: BaselineSummary[];
  stryker: StrykerSummary | null;
  /** The run universe restricted to the planned universe; null unless complete. */
  runUniverse: RunUniverse | null;
  /** The run's explicit observations of universe mutants; empty unless complete. */
  observations: Observation[];
  /** Universe mutants a complete run did not evaluate, sorted. */
  missing: string[];
  /** Mutants the run evaluated outside the universe (nested in a range), dropped. */
  outsideUniverse: number;
  wallClockMs: number;
}

export interface IsolationRunOptions {
  /** Absolute repo checkout. */
  repoRoot: string;
  /** Absolute work directory, outside the checkout. */
  workDir: string;
  shard: number;
  /** The run manifest the shard verified its prepared copy against. */
  manifest: ScenarioRunManifest;
  /** Absolute prepared `gitnexus/` package of the shard's verified copy. */
  packageDir: string;
  /** `maxTestRunnerReuse` is always {@link ISOLATION_TEST_RUNNER_REUSE}. */
  stryker?: Partial<Omit<StrykerSettings, 'maxTestRunnerReuse'>>;
}

const SAFE_RUN_ID = /^(together|alone)-[0-9a-f]{16}$/;

/** `<work>/isolation/<group>/<run id>.json`; throws for an unsafe group or run id. */
export function isolationRunFile(workDir: string, group: string, id: string): string {
  // Validates the group id as the group run does.
  observationsFile(workDir, group);
  if (!SAFE_RUN_ID.test(id)) throw new Error(`isolation: unsafe run id ${JSON.stringify(id)}`);
  return path.join(workDir, 'isolation', group, `${id}.json`);
}

/** Runs one isolation run and writes its result at once; see the module comment. */
export async function runIsolationRun(
  spec: IsolationRunSpec,
  options: IsolationRunOptions,
  deps: GroupRunDeps = defaultGroupRunDeps,
): Promise<IsolationRunResult> {
  const started = deps.now();
  const file = isolationRunFile(options.workDir, spec.group, spec.id);
  // A result left by an earlier run would read as this run's.
  rmSync(file, { force: true });
  const runDir = path.join(options.workDir, 'groups', spec.group, spec.id);
  mkdirSync(runDir, { recursive: true });
  const settings: StrykerSettings = {
    ...DEFAULT_STRYKER_SETTINGS,
    ...options.stryker,
    maxTestRunnerReuse: ISOLATION_TEST_RUNNER_REUSE,
  };
  const run = await runMutationRun(
    {
      repoRoot: options.repoRoot,
      manifest: options.manifest,
      packageDir: options.packageDir,
      runDir,
      tests: spec.tests,
      testFiles: spec.testFiles,
      mutate: spec.mutate,
      settings,
    },
    deps,
  );
  const extracted =
    run.results === null
      ? null
      : extractObservations(run.results, {
          group: spec.group,
          kind: spec.kind,
          lineage: spec.lineage,
          shard: options.shard,
        });
  const universe = new Set(spec.universe);
  const evaluated = new Set(extracted?.universe.mutants.map((mutant) => mutant.id) ?? []);
  const result: IsolationRunResult = {
    schemaVersion: ISOLATION_RUN_SCHEMA_VERSION,
    id: spec.id,
    group: spec.group,
    kind: spec.kind,
    lineage: spec.lineage,
    tests: spec.tests,
    testFiles: spec.testFiles,
    universe: spec.universe,
    mutate: spec.mutate,
    shard: options.shard,
    manifestDigest: options.manifest.digest,
    status: run.failure === null ? 'complete' : 'inconclusive',
    reason: run.failure?.reason ?? null,
    detail: run.failure?.detail ?? null,
    settings,
    baselines: run.baselines,
    stryker: run.stryker,
    runUniverse:
      extracted === null
        ? null
        : {
            ...extracted.universe,
            mutants: extracted.universe.mutants.filter((mutant) => universe.has(mutant.id)),
          },
    observations: (extracted?.observations ?? []).filter((entry) => universe.has(entry.mutant)),
    missing: run.results === null ? [] : spec.universe.filter((mutant) => !evaluated.has(mutant)),
    outsideUniverse: [...evaluated].filter((mutant) => !universe.has(mutant)).length,
    wallClockMs: Math.round(deps.now() - started),
  };
  const written: IsolationRunFile = {
    ...result,
    observations: encodeObservations(result.runUniverse, result.observations),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(written)}\n`);
  return result;
}

/** Runs every run of a plan in order; each result is written as soon as it finishes. */
export async function runIsolationPlan(
  plan: IsolationPlan,
  options: IsolationRunOptions,
  deps: GroupRunDeps = defaultGroupRunDeps,
): Promise<IsolationRunResult[]> {
  const results: IsolationRunResult[] = [];
  for (const spec of plan.runs) results.push(await runIsolationRun(spec, options, deps));
  return results;
}

/** An isolation run result as written: its explicit observations as rows of its run universe. */
export type IsolationRunFile = Omit<IsolationRunResult, 'observations'> & {
  observations: ObservationRow[];
};

const isIsolationRunFile = (value: unknown): value is IsolationRunFile =>
  isRecord(value) &&
  value.schemaVersion === ISOLATION_RUN_SCHEMA_VERSION &&
  typeof value.group === 'string' &&
  (value.kind === 'together' || value.kind === 'alone') &&
  typeof value.lineage === 'string' &&
  (value.runUniverse === null || isRunUniverse(value.runUniverse)) &&
  Array.isArray(value.observations) &&
  Array.isArray(value.baselines) &&
  Array.isArray(value.missing);

/** Reads one isolation run result; another schema (schema 1 included) or a bad row throws. */
export function readIsolationRun(file: string): IsolationRunResult {
  const data = readJsonFile(file);
  if (isRecord(data) && data.schemaVersion !== ISOLATION_RUN_SCHEMA_VERSION) {
    throw new Error(
      `isolation: ${file} has schema ${JSON.stringify(data.schemaVersion)}, not ` +
        `${ISOLATION_RUN_SCHEMA_VERSION}: it was written before the compact observation model ` +
        '(one observation per test and mutant); re-run its shard',
    );
  }
  if (!isIsolationRunFile(data)) {
    throw new Error(`isolation: ${file} is not an isolation run result`);
  }
  return { ...data, observations: decodeObservations(data.runUniverse, data.observations) };
}

/** Every isolation run result under `<work>/isolation/`, sorted by group and run id. */
export function readIsolationRuns(workDir: string): IsolationRunResult[] {
  const root = path.join(workDir, 'isolation');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort(byText)
    .flatMap((group) =>
      readdirSync(path.join(root, group))
        .filter((name) => name.endsWith('.json'))
        .sort(byText)
        .map((name) => readIsolationRun(path.join(root, group, name))),
    );
}

// ── Comparison ────────────────────────────────────────────────────────────

export type IsolationStatus = 'agrees' | 'disagrees' | 'unknown' | 'not-run';

export type IsolationReason =
  | 'isolation-disagrees'
  | 'isolation-unknown'
  | 'not-repeat-stage'
  | 'not-scheduled';

/** The runs a test is compared across. */
export type ComparedRun = 'main' | IsolationRunKind;

export interface IsolationDisagreement {
  test: string;
  /** Global mutant id; null for the unmutated baseline. */
  mutant: string | null;
  field: 'baseline' | 'coverage' | 'outcome';
  /** The value in each run; null when unknown there. */
  main: string | null;
  together: string | null;
  alone: string | null;
}

export interface IsolationUnknown {
  test: string;
  /** Global mutant id; null for the unmutated baseline. */
  mutant: string | null;
  /** Runs without a valid value, in main, together, alone order. */
  runs: ComparedRun[];
  /** Why, sorted: `missing`, `run:<reason>`, or the observation's reasons. */
  reasons: string[];
}

export interface IsolationDisqualifier {
  kind: 'hook-stratum-unvalidated';
  cap: 'weak';
  /** Hook-attributed mutants of the pair's path or kills, sorted. */
  mutants: string[];
}

export interface IsolationResult extends PairRef {
  key: string;
  status: IsolationStatus;
  /** Null when the runs agree. */
  reason: IsolationReason | null;
  /** The repeat-stage misses of a `not-repeat-stage` pair; empty otherwise. */
  misses: RepeatStageMiss[];
  /** The pair's isolation universe. */
  universe: string[];
  disagreements: IsolationDisagreement[];
  unknown: IsolationUnknown[];
  disqualifiers: IsolationDisqualifier[];
  /** Run ids that decided: the together run and both alone runs; empty when not scheduled. */
  runs: string[];
}

/** What the comparison reads; see the module comment. */
export interface IsolationEvidence {
  /** Merged observations holding each pair's group `main` lineage; other entries are ignored. */
  merged: MergedObservations;
  /** Every isolation run result found, from every shard. */
  runs: readonly IsolationRunResult[];
  /** Digest of the plan's run manifest: a run verified against another one is not used. */
  manifestDigest: string;
}

interface RunView {
  ids: string[];
  /** Run-level reasons: a failed run's `run:<reason>`. */
  reasons: string[];
  baselines: BaselineSummary[];
  /** The merged observations of its verified results; undefined when they have none. */
  observations: LineageObservations | undefined;
}

/**
 * Every result of one group, kind and lineage (several shards may have run it), folded. A result
 * verified against another run manifest contributes only its reason, `run:manifest-mismatch`.
 */
function runViews(
  runs: readonly IsolationRunResult[],
  manifestDigest: string,
): Map<string, RunView> {
  const grouped = new Map<string, IsolationRunResult[]>();
  for (const run of runs) {
    const key = JSON.stringify([run.group, run.kind, run.lineage]);
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  return new Map(
    [...grouped.entries()].map(([key, results]): [string, RunView] => {
      const own = results.filter((run) => run.manifestDigest === manifestDigest);
      const [first] = results;
      const merged = mergeObservations(
        own.flatMap((run) => run.observations),
        own.flatMap((run) => (run.runUniverse === null ? [] : [run.runUniverse])),
      );
      return [
        key,
        {
          ids: sortedUnique(results.map((run) => run.id)),
          reasons: sortedUnique([
            ...(own.length < results.length ? ['run:manifest-mismatch'] : []),
            ...own.flatMap((run) =>
              run.status === 'complete' ? [] : [`run:${run.reason ?? '?'}`],
            ),
          ]),
          baselines: own.flatMap((run) => run.baselines),
          observations: lineageOf(indexObservations(merged), first),
        },
      ];
    }),
  );
}

/**
 * The unmutated baseline of a test in a run: `passed`, the failing class, or null when unknown
 * (no baseline ran, a selection problem, or the test did not run).
 */
function baselineValue(baselines: readonly BaselineSummary[], test: string): string | null {
  for (const baseline of baselines) {
    const failing = baseline.failing.find((entry) => entry.test === test);
    if (failing !== undefined && failing.outcome !== null) return failing.outcome;
  }
  const passed =
    baselines.length > 0 &&
    baselines.every(
      (baseline) =>
        baseline.problems.length === 0 && !baseline.failing.some((entry) => entry.test === test),
    );
  return passed ? 'passed' : null;
}

type Slot = { value: string | null; reasons: string[] };

/** Appends the disagreement or the unknown entry of one test and field across the three runs. */
function compareSlots(
  test: string,
  mutant: string | null,
  field: IsolationDisagreement['field'],
  slots: Record<ComparedRun, Slot>,
  into: { disagreements: IsolationDisagreement[]; unknown: IsolationUnknown[] },
): void {
  const order: ComparedRun[] = ['main', 'together', 'alone'];
  const known = new Set(
    order.flatMap((run) => (slots[run].value === null ? [] : [slots[run].value])),
  );
  if (known.size > 1) {
    into.disagreements.push({
      test,
      mutant,
      field,
      main: slots.main.value,
      together: slots.together.value,
      alone: slots.alone.value,
    });
  }
  const unknownRuns = order.filter((run) => slots[run].value === null);
  // One unknown entry per test and mutant: the outcome field repeats the coverage field's runs.
  if (unknownRuns.length > 0 && field !== 'outcome') {
    into.unknown.push({
      test,
      mutant,
      runs: unknownRuns,
      reasons: sortedUnique(unknownRuns.flatMap((run) => slots[run].reasons)),
    });
  }
}

/**
 * A run's coverage and outcome slots for one test and mutant: unknown without a valid observation,
 * with the observation's reasons, else the run's own (`run:<reason>`), else `missing`.
 */
function observedSlots(
  observations: LineageObservations | undefined,
  runReasons: readonly string[],
  test: string,
  mutant: string,
): [Slot, Slot] {
  const entry = stateIn(observations, test, mutant);
  if (entry === undefined || !entry.valid || entry.outcome === null) {
    const reasons =
      entry !== undefined && entry.reasons.length > 0
        ? entry.reasons
        : runReasons.length > 0
          ? [...runReasons]
          : ['missing'];
    return [
      { value: null, reasons },
      { value: null, reasons },
    ];
  }
  return [
    { value: coverageOf(entry), reasons: [] },
    { value: entry.outcome, reasons: [] },
  ];
}

/** The KTD9 hook disqualifier of a pair; see the module comment. */
function hookDisqualifiers(
  decision: RepeatStageDecision,
  sources: readonly (LineageObservations | undefined)[],
): IsolationDisqualifier[] {
  const touched = sortedUnique([
    ...decision.universe,
    ...decision.comparison.killsA,
    ...decision.comparison.killsB,
  ]);
  const hooked = touched.filter((mutant) =>
    sources.some((view) =>
      [decision.a, decision.b].some((test) => {
        const entry = stateIn(view, test, mutant);
        return entry !== undefined && entry.hookAttributed !== false;
      }),
    ),
  );
  return hooked.length === 0
    ? []
    : [{ kind: 'hook-stratum-unvalidated', cap: 'weak', mutants: hooked }];
}

/** Each pair's isolation result, in input order; pure. See the module comment. */
export function evaluateIsolation(
  decisions: readonly RepeatStageDecision[],
  evidence: IsolationEvidence,
): IsolationResult[] {
  const mains = mainIndex(evidence.merged);
  const views = runViews(evidence.runs, evidence.manifestDigest);
  const viewOf = (group: string, kind: IsolationRunKind, lineage: string): RunView | undefined =>
    views.get(JSON.stringify([group, kind, lineage]));
  return decisions.map((decision): IsolationResult => {
    const main = lineageOf(mains, mainRun(decision.group));
    const together = viewOf(decision.group, 'together', decision.key);
    const alone = new Map(
      [decision.a, decision.b].map((test) => [test, viewOf(decision.group, 'alone', test)]),
    );
    const base = {
      group: decision.group,
      a: decision.a,
      b: decision.b,
      key: decision.key,
      universe: decision.universe,
      disqualifiers: hookDisqualifiers(decision, [
        main,
        together?.observations,
        ...[...alone.values()].map((view) => view?.observations),
      ]),
    };
    const notRun = (reason: 'not-repeat-stage' | 'not-scheduled'): IsolationResult => ({
      ...base,
      status: 'not-run',
      reason,
      misses: decision.misses,
      disagreements: [],
      unknown: [],
      runs: [],
    });
    if (!decision.selected) return notRun('not-repeat-stage');
    const aloneViews = [...alone.values()];
    if (together === undefined || aloneViews.some((view) => view === undefined)) {
      return notRun('not-scheduled');
    }
    const found = {
      disagreements: [] as IsolationDisagreement[],
      unknown: [] as IsolationUnknown[],
    };
    for (const test of [decision.a, decision.b]) {
      const own = alone.get(test);
      const baseline = (view: RunView | undefined): Slot => {
        const value = view === undefined ? null : baselineValue(view.baselines, test);
        return {
          value,
          reasons: value === null ? [...(view?.reasons ?? []), 'baseline-unknown'] : [],
        };
      };
      compareSlots(
        test,
        null,
        'baseline',
        {
          main: { value: 'passed', reasons: [] },
          together: baseline(together),
          alone: baseline(own),
        },
        found,
      );
      for (const mutant of decision.universe) {
        const [mainCoverage, mainOutcome] = observedSlots(main, [], test, mutant);
        const [togetherCoverage, togetherOutcome] = observedSlots(
          together.observations,
          together.reasons,
          test,
          mutant,
        );
        const [aloneCoverage, aloneOutcome] = observedSlots(
          own?.observations,
          own?.reasons ?? [],
          test,
          mutant,
        );
        compareSlots(
          test,
          mutant,
          'coverage',
          { main: mainCoverage, together: togetherCoverage, alone: aloneCoverage },
          found,
        );
        compareSlots(
          test,
          mutant,
          'outcome',
          { main: mainOutcome, together: togetherOutcome, alone: aloneOutcome },
          found,
        );
      }
    }
    const status: IsolationStatus =
      found.disagreements.length > 0
        ? 'disagrees'
        : found.unknown.length > 0
          ? 'unknown'
          : 'agrees';
    return {
      ...base,
      status,
      reason:
        status === 'disagrees'
          ? 'isolation-disagrees'
          : status === 'unknown'
            ? 'isolation-unknown'
            : null,
      misses: [],
      disagreements: found.disagreements,
      unknown: found.unknown,
      runs: sortedUnique([...together.ids, ...aloneViews.flatMap((view) => view?.ids ?? [])]),
    };
  });
}
