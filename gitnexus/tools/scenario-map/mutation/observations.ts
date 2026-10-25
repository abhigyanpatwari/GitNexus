/**
 * Raw Layer 3 observations of the scenario map (U7, R6, R7, R11, KTD8, design §5.4): what one
 * group run says about one test and one mutant, the unit that shards merge.
 *
 * Compact model. A run's observations are its run universe ({@link RunUniverse}) plus its explicit
 * observations; every other observation of the run is implied by the universe and never stored, so
 * a run holds O(covered entries + per-test rows) observations, not O(tests × mutants).
 *
 * Extraction ({@link extractObservations}) reads a scope-driver `results.json` (schema 2,
 * tools/mutation/driver/normalise-results.ts). The run's tests are its selected tests: its
 * `scope.testIds`, or every test that was not skipped when the run selected none; a test the run
 * collected but skipped is no test of the run. Its universe is every mutant Stryker evaluated
 * (every status but `Ignored` and `Pending`). The {@link RunUniverse} records the run reference,
 * the tests, per mutant its id, file, static flag, Stryker status, own reasons and whether the run
 * has a hook marker for it, and the run-level reasons. For each mutant and test of the run:
 *   - one explicit observation per per-test row of every sidecar attempt (`source: row`), with the
 *     row's outcome class and the attempt's index (oldest first);
 *   - no row, and the mutant static, the test in its `coveredBy`, or no `coveredBy` at all:
 *     explicit; a Stryker timeout without a sidecar is a `timeout` that cannot be attributed to a
 *     test (`source: stryker-timeout`, invalid), anything else unknown, outcome null
 *     (`source: no-row`, invalid `missing-result`). A missing result is never a non-kill (§5.4);
 *   - no row, not covered, but a suite hook attributed the mutant to the test: explicit, a
 *     `survived` (`source: not-covered`) whose hook marker is true;
 *   - otherwise implied ({@link impliedObservation}): Stryker never ran the test against the
 *     non-static mutant, a `survived` (`source: not-covered`; NoCoverage is survived, KTD13), its
 *     hook marker false (null when the run has no marker for the mutant).
 * An observation is invalid, with its reasons, when the run carries a run-level integrity flag
 * (`run-flag:<kind>`), the mutant carries one (`mutant-flag:<kind>`), its span-map check failed
 * (`span-map`), its attempts disagree (`attempts-disagree`, KTD8), or the row's attempt has a run
 * class whose rows cannot be trusted (`run-timeout`, `run-infrastructure`, `run-inconclusive`,
 * `run-invalid`: classify-outcome.ts; such a run can still hold assertion rows). An implied
 * observation carries the run's and the mutant's reasons.
 *
 * Identity (R11). An observation is keyed by group, run kind, lineage, attempt, test and global
 * mutant id ({@link observationKey}). The lineage names one run among the group's runs of its
 * kind: `main` for the group run, the pair for a `together` run, the test for an `alone` run
 * (isolation, U8). A run is its lineage plus the shard that ran it. The test is its Phase 0 id, the
 * execution identity inside one run (KTD3; the baselines prove the identities stable). The global
 * mutant id carries the original file's content hash (tools/mutation/prepare/mutant-identity.ts).
 *
 * Merging ({@link mergeObservations}) folds the observations of one lineage per test and mutant,
 * explicit and implied alike (an implied one comes from each run of the lineage that selected the
 * test, holds the non-static mutant and has no explicit observation of the pair): agreeing classes
 * keep the class; different classes become one `inconclusive` observation (`class-disagreement`);
 * reasons are united. Observations of different groups or lineages are never folded: two groups
 * can mutate one file, and a mutant can survive one and die in another. The result keeps the
 * folded observations of every key with an explicit observation, plus the run universes; a key
 * with implied observations only is folded on read ({@link stateOf}, {@link observationOf}) from
 * an index ({@link indexObservations}). Verdicts, weak tests, gaps and subsumption are recomputed
 * from merged observations, never summed.
 *
 * Comparison ({@link comparePair}) looks at one lineage only. The pair's universe is the mutants of
 * that run with a valid observation for both tests; a mutant of the run that either test lacks or
 * has invalid is unknown, and with any unknown mutant, or none at all (a run that was never
 * observed), the kill sets are not compared. Only `killed-by-test:assertion` is a kill (R6).
 *
 * Work files ({@link encodeObservations}, {@link decodeObservations}): a run's explicit
 * observations are written as rows indexing its universe's tests and mutants, so a file holds each
 * test id and mutant id once.
 *
 * Library only; pure (an index caches the implied observations it folds). The group run
 * (run-group.ts) writes the observations of each group as soon as it finishes; the merge stage and
 * the verdict engine (U12) read them.
 */
import { createHash } from 'node:crypto';
import type {
  NormalisedMutant,
  PerTestRow,
  RunResults,
} from '../../mutation/driver/normalise-results.js';
import type { MutantStatus } from '../../mutation/prepare/mutant-identity.js';
import type { OutcomeClass } from '../../mutation/runner/classify-outcome.js';

/** The run kinds of Layer 3: the group run, and the isolation pass's together and alone runs. */
export type RunKind = 'main' | 'together' | 'alone';

/** The lineage of the group run of a group. */
export const MAIN_LINEAGE = 'main';

/** Which run an observation comes from. */
export interface RunRef {
  /** Candidate group id (path-coverage/candidates.ts). */
  group: string;
  kind: RunKind;
  /** The run among the group's runs of its kind; see the module comment. */
  lineage: string;
  /** 0-based shard that ran it. */
  shard: number;
}

/** A run lineage: the runs of one group, kind and lineage, whichever shard ran them. */
export type RunKey = Pick<RunRef, 'group' | 'kind' | 'lineage'>;

export type ObservationSource = 'row' | 'not-covered' | 'stryker-timeout' | 'no-row';

export interface Observation extends RunRef {
  /** Index of the sidecar attempt (oldest first) the row came from; null without a row. */
  attempt: number | null;
  /** Phase 0 test id. */
  test: string;
  /** Global mutant id. */
  mutant: string;
  /** Repo path of the mutated file. */
  file: string;
  /** The test is in the mutant's `coveredBy`. */
  covered: boolean;
  /** A suite hook attributed the mutant's dry-run hits to the test; null without a marker. */
  hookAttributed: boolean | null;
  static: boolean;
  /** The outcome class; null when unknown. */
  outcome: OutcomeClass | null;
  source: ObservationSource;
  /** False when the observation cannot be trusted; `reasons` says why, sorted. */
  valid: boolean;
  reasons: string[];
}

/** Several observations of one lineage, test and mutant, folded. */
export interface MergedObservation extends Omit<Observation, 'attempt' | 'shard' | 'source'> {
  /** Attempt indices that contributed, sorted. */
  attempts: number[];
  /** Shards that contributed, sorted. */
  shards: number[];
  sources: ObservationSource[];
}

/** A merged observation without its test: what a lookup reads (tests share an implied one). */
export type ObservationState = Omit<MergedObservation, 'test'>;

/** One mutant of a run universe. */
export interface UniverseMutant {
  /** Global mutant id. */
  id: string;
  /** Repo path of the mutated file. */
  file: string;
  static: boolean;
  /** Stryker's raw status. */
  status: MutantStatus;
  /** The mutant's own reasons (`mutant-flag:<kind>`, `span-map`, `attempts-disagree`), sorted. */
  reasons: string[];
  /** The run has a hook marker for the mutant (its `hookAttributedTests` is not null). */
  hookMarker: boolean;
}

/** What one run evaluated: the reference that implies its unstored observations. */
export interface RunUniverse extends RunRef {
  /** The run's selected tests (Phase 0 ids), sorted. */
  tests: string[];
  /** The mutants Stryker evaluated, sorted by id. */
  mutants: UniverseMutant[];
  /** False when the run carries a run-level reason. */
  valid: boolean;
  /** Run-level reasons (`run-flag:<kind>`), sorted. */
  reasons: string[];
}

/** One run's extraction: its universe and its explicit observations. */
export interface RunObservations {
  universe: RunUniverse;
  /** Explicit observations, sorted by mutant, then test. */
  observations: Observation[];
}

/** Merged observations of any number of runs; see the module comment. */
export interface MergedObservations {
  /**
   * One per lineage, test and mutant with an explicit observation (implied ones of other runs
   * folded in), sorted by group, kind, lineage, mutant and test.
   */
  explicit: MergedObservation[];
  /** Every run universe, sorted by group, kind, lineage and shard. */
  universes: RunUniverse[];
}

/** Whether Stryker evaluated a mutant: `Ignored` and `Pending` are outside every universe. */
export const isEvaluated = (mutant: Pick<NormalisedMutant, 'status'>): boolean =>
  mutant.status !== 'Ignored' && mutant.status !== 'Pending';

/** Run classes whose per-test rows cannot be trusted (classify-outcome.ts). */
const UNTRUSTED_RUN: ReadonlySet<OutcomeClass> = new Set([
  'timeout',
  'infrastructure',
  'inconclusive',
  'invalid',
]);

const ASSERTION_KILL: OutcomeClass = 'killed-by-test:assertion';

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(byText);

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};

// ── Extraction ────────────────────────────────────────────────────────────

/** The selected tests of a run: its requested ids, or every test that was not skipped. */
const testsOf = (results: RunResults): string[] =>
  sortedUnique(
    results.scope.testIds ?? results.tests.filter((test) => !test.skipped).map((test) => test.id),
  );

/** Reasons that hold for every observation of a run. */
function runReasons(results: RunResults): string[] {
  return sortedUnique(
    results.flags.filter((flag) => flag.localId === null).map((flag) => `run-flag:${flag.kind}`),
  );
}

function universeMutant(
  mutant: NormalisedMutant,
  spanFailures: ReadonlySet<string>,
): UniverseMutant {
  return {
    id: mutant.globalId,
    file: mutant.file,
    static: mutant.static === true,
    status: mutant.status,
    reasons: sortedUnique([
      ...mutant.flags.map((kind) => `mutant-flag:${kind}`),
      ...(spanFailures.has(mutant.globalId) ? ['span-map'] : []),
      ...(mutant.attemptsDisagree ? ['attempts-disagree'] : []),
    ]),
    hookMarker: mutant.hookAttributedTests !== null,
  };
}

const refOf = (run: RunRef): RunRef => ({
  group: run.group,
  kind: run.kind,
  lineage: run.lineage,
  shard: run.shard,
});

/** The explicit observations of one mutant; see the module comment. */
function mutantObservations(
  mutant: NormalisedMutant,
  entry: UniverseMutant,
  universe: RunUniverse,
): Observation[] {
  const reasons = [...universe.reasons, ...entry.reasons];
  const covered = new Set(mutant.coveredBy ?? []);
  const hooked = mutant.hookAttributedTests === null ? null : new Set(mutant.hookAttributedTests);
  const rows = new Map<string, PerTestRow[]>();
  for (const row of mutant.perTest) push(rows, row.testId, row);
  const exposedAll = entry.static || mutant.coveredBy === null;
  const ref = refOf(universe);
  const make = (
    test: string,
    attempt: number | null,
    outcome: OutcomeClass | null,
    source: ObservationSource,
    extra: readonly string[],
  ): Observation => {
    const all = sortedUnique([...reasons, ...extra]);
    return {
      ...ref,
      attempt,
      test,
      mutant: mutant.globalId,
      file: mutant.file,
      covered: covered.has(test),
      hookAttributed: hooked === null ? null : hooked.has(test),
      static: entry.static,
      outcome,
      source,
      valid: all.length === 0,
      reasons: all,
    };
  };
  const explicit = exposedAll
    ? universe.tests
    : universe.tests.filter(
        (test) => rows.has(test) || covered.has(test) || hooked?.has(test) === true,
      );
  return explicit.flatMap((test): Observation[] => {
    const own = rows.get(test);
    if (own !== undefined) {
      return own.map((row) => {
        const run = mutant.attempts[row.attempt]?.outcome;
        const distrust =
          run === undefined ? ['attempt-missing'] : UNTRUSTED_RUN.has(run) ? [`run-${run}`] : [];
        return make(test, row.attempt, row.outcome, 'row', distrust);
      });
    }
    if (!exposedAll && !covered.has(test)) return [make(test, null, 'survived', 'not-covered', [])];
    if (mutant.outcomeSource === 'stryker-timeout') {
      return [make(test, null, 'timeout', 'stryker-timeout', ['stryker-timeout'])];
    }
    return [make(test, null, null, 'no-row', ['missing-result'])];
  });
}

/**
 * The universe and the explicit observations of one scope-driver run; see the module comment.
 * Observations are sorted by mutant, then test.
 */
export function extractObservations(results: RunResults, ref: RunRef): RunObservations {
  const reasons = runReasons(results);
  const spanFailures = new Set(results.spanMap.failures.map((failure) => failure.globalId));
  const evaluated = results.mutants
    .filter(isEvaluated)
    .sort((a, b) => byText(a.globalId, b.globalId));
  const universe: RunUniverse = {
    ...refOf(ref),
    tests: testsOf(results),
    mutants: evaluated.map((mutant) => universeMutant(mutant, spanFailures)),
    valid: reasons.length === 0,
    reasons,
  };
  return {
    universe,
    observations: evaluated.flatMap((mutant, index) =>
      mutantObservations(mutant, universe.mutants[index], universe),
    ),
  };
}

/**
 * The observation a run implies for a selected test and a non-static mutant of its universe that
 * have no explicit observation: Stryker never ran the test against the mutant, a valid `survived`
 * unless the run or the mutant carries a reason. Never stored; see the module comment.
 */
export function impliedObservation(
  universe: RunUniverse,
  mutant: UniverseMutant,
  test: string,
): Observation {
  const reasons = sortedUnique([...universe.reasons, ...mutant.reasons]);
  return {
    ...refOf(universe),
    attempt: null,
    test,
    mutant: mutant.id,
    file: mutant.file,
    covered: false,
    hookAttributed: mutant.hookMarker ? false : null,
    static: mutant.static,
    outcome: 'survived',
    source: 'not-covered',
    valid: reasons.length === 0,
    reasons,
  };
}

// ── Merging ───────────────────────────────────────────────────────────────

/** The run lineage of an observation: group, kind and lineage. */
const lineageKey = (entry: RunKey): string =>
  JSON.stringify([entry.group, entry.kind, entry.lineage]);

/** The R11 key: group, run kind, lineage, attempt, test and global mutant id. */
export const observationKey = (entry: Observation): string =>
  JSON.stringify([entry.group, entry.kind, entry.lineage, entry.attempt, entry.test, entry.mutant]);

/** Folds the observations of one lineage, test and mutant; see the module comment. */
function fold(entries: readonly Observation[]): MergedObservation {
  const [first] = entries;
  const outcomes = new Set(
    entries.flatMap((entry) => (entry.outcome === null ? [] : [entry.outcome])),
  );
  const coverage = new Set(entries.map((entry) => entry.covered));
  const markers = new Set(entries.map((entry) => entry.hookAttributed));
  const reasons = [
    ...entries.flatMap((entry) => entry.reasons),
    ...(outcomes.size > 1 ? ['class-disagreement'] : []),
    ...(coverage.size > 1 ? ['coverage-disagreement'] : []),
    ...(markers.size > 1 ? ['hook-marker-disagreement'] : []),
  ];
  const all = sortedUnique(reasons);
  const [single] = [...outcomes];
  return {
    group: first.group,
    kind: first.kind,
    lineage: first.lineage,
    test: first.test,
    mutant: first.mutant,
    file: first.file,
    covered: coverage.has(true),
    hookAttributed: markers.has(true) ? true : markers.has(false) ? false : null,
    static: entries.some((entry) => entry.static),
    outcome: outcomes.size > 1 ? 'inconclusive' : (single ?? null),
    attempts: [
      ...new Set(entries.flatMap((entry) => (entry.attempt === null ? [] : [entry.attempt]))),
    ].sort((a, b) => a - b),
    shards: [...new Set(entries.map((entry) => entry.shard))].sort((a, b) => a - b),
    sources: [...new Set(entries.map((entry) => entry.source))].sort(byText),
    valid: all.length === 0,
    reasons: all,
  };
}

/** A run universe with its lookups (an index's run). */
export interface IndexedRun {
  universe: RunUniverse;
  tests: ReadonlySet<string>;
  mutants: ReadonlyMap<string, UniverseMutant>;
  /** The run implies observations of its tests: it has a non-static mutant. */
  implies: boolean;
  /** Implied states by mutant, folded on first read. */
  implied: Map<string, ObservationState>;
}

const indexedRun = (universe: RunUniverse): IndexedRun => ({
  universe,
  tests: new Set(universe.tests),
  mutants: new Map(universe.mutants.map((mutant) => [mutant.id, mutant])),
  implies: universe.mutants.some((mutant) => !mutant.static),
  implied: new Map(),
});

/** The universe mutant a run implies an observation of for the test; undefined when none. */
function impliedBy(run: IndexedRun, test: string, mutant: string): UniverseMutant | undefined {
  if (!run.tests.has(test)) return undefined;
  const entry = run.mutants.get(mutant);
  return entry === undefined || entry.static ? undefined : entry;
}

const universeOrder = (a: RunUniverse, b: RunUniverse): number =>
  byText(lineageKey(a), lineageKey(b)) || a.shard - b.shard;

/**
 * Merges observations and run universes from any number of shards and runs: the folded
 * observation of each lineage, test and mutant with an explicit observation, and the universes
 * that imply the rest; see the module comment.
 */
export function mergeObservations(
  observations: readonly Observation[],
  universes: readonly RunUniverse[],
): MergedObservations {
  const runs = new Map<string, IndexedRun[]>();
  for (const universe of universes) push(runs, lineageKey(universe), indexedRun(universe));
  const byKey = new Map<string, Observation[]>();
  for (const entry of observations) {
    push(byKey, JSON.stringify([lineageKey(entry), entry.mutant, entry.test]), entry);
  }
  const explicit = [...byKey.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([, entries]) => {
      const [first] = entries;
      const shards = new Set(entries.map((entry) => entry.shard));
      const implied = (runs.get(lineageKey(first)) ?? []).flatMap((run) => {
        if (shards.has(run.universe.shard)) return [];
        const mutant = impliedBy(run, first.test, first.mutant);
        return mutant === undefined ? [] : [impliedObservation(run.universe, mutant, first.test)];
      });
      return fold([...entries, ...implied]);
    });
  return { explicit, universes: [...universes].sort(universeOrder) };
}

// ── Index ─────────────────────────────────────────────────────────────────

/** The merged observations of one lineage, indexed; read through {@link stateOf}. */
export interface LineageObservations extends RunKey {
  /** The lineage's runs, one per shard that ran it. */
  runs: readonly IndexedRun[];
  /** Every mutant with an observation in the lineage (explicit or implied), sorted. */
  mutants: readonly string[];
  /** Explicit merged observations, by test, then mutant. */
  explicit: ReadonlyMap<string, ReadonlyMap<string, MergedObservation>>;
}

export interface ObservationIndex {
  /** By lineage (JSON of group, kind and lineage), in that order. */
  lineages: ReadonlyMap<string, LineageObservations>;
  /** Per test, the lineages where it has an observation, in lineage order. */
  byTest: ReadonlyMap<string, readonly LineageObservations[]>;
}

const observationOrder = (x: MergedObservation, y: MergedObservation): number =>
  byText(
    JSON.stringify([x.group, x.kind, x.lineage, x.mutant, x.test]),
    JSON.stringify([y.group, y.kind, y.lineage, y.mutant, y.test]),
  );

/**
 * Indexes merged observations by lineage and test, keeping the lineages `keep` accepts. The input
 * order does not matter.
 */
export function indexObservations(
  merged: MergedObservations,
  keep: (run: RunKey) => boolean = () => true,
): ObservationIndex {
  const runs = new Map<string, IndexedRun[]>();
  for (const universe of [...merged.universes].sort(universeOrder)) {
    if (keep(universe)) push(runs, lineageKey(universe), indexedRun(universe));
  }
  const explicit = new Map<string, MergedObservation[]>();
  for (const entry of [...merged.explicit].sort(observationOrder)) {
    if (keep(entry)) push(explicit, lineageKey(entry), entry);
  }
  const keys = sortedUnique([...runs.keys(), ...explicit.keys()]);
  const lineages = new Map<string, LineageObservations>();
  const byTest = new Map<string, LineageObservations[]>();
  for (const key of keys) {
    const own = runs.get(key) ?? [];
    const entries = explicit.get(key) ?? [];
    const [group, kind, lineage] = JSON.parse(key) as [string, RunKind, string];
    const byMutant = new Map<string, Map<string, MergedObservation>>();
    for (const entry of entries) {
      const tested = byMutant.get(entry.test) ?? new Map<string, MergedObservation>();
      byMutant.set(entry.test, tested.set(entry.mutant, entry));
    }
    const view: LineageObservations = {
      group,
      kind,
      lineage,
      runs: own,
      mutants: sortedUnique([
        ...own.flatMap((run) =>
          run.universe.tests.length === 0
            ? []
            : run.universe.mutants.flatMap((mutant) => (mutant.static ? [] : [mutant.id])),
        ),
        ...entries.map((entry) => entry.mutant),
      ]),
      explicit: byMutant,
    };
    lineages.set(key, view);
    const tests = sortedUnique([
      ...byMutant.keys(),
      ...own.flatMap((run) => (run.implies ? run.universe.tests : [])),
    ]);
    for (const test of tests) push(byTest, test, view);
  }
  return { lineages, byTest };
}

/** The indexed lineage of a run; undefined when it has no observation. */
export const lineageOf = (index: ObservationIndex, run: RunKey): LineageObservations | undefined =>
  index.lineages.get(lineageKey(run));

/** The folded implied state of one run and mutant, cached in the run. */
function impliedState(run: IndexedRun, mutant: UniverseMutant): ObservationState {
  const cached = run.implied.get(mutant.id);
  if (cached !== undefined) return cached;
  const reasons = sortedUnique([...run.universe.reasons, ...mutant.reasons]);
  const state: ObservationState = {
    group: run.universe.group,
    kind: run.universe.kind,
    lineage: run.universe.lineage,
    mutant: mutant.id,
    file: mutant.file,
    covered: false,
    hookAttributed: mutant.hookMarker ? false : null,
    static: mutant.static,
    outcome: 'survived',
    attempts: [],
    shards: [run.universe.shard],
    sources: ['not-covered'],
    valid: reasons.length === 0,
    reasons,
  };
  run.implied.set(mutant.id, state);
  return state;
}

/**
 * The merged observation of a test and mutant in a lineage, without its test: the explicit one,
 * else the fold of what its runs imply; undefined when the test has none. Allocates nothing for a
 * lineage of one run (the hot path of {@link comparePair}).
 */
export function stateOf(
  view: LineageObservations,
  test: string,
  mutant: string,
): ObservationState | undefined {
  const found = view.explicit.get(test)?.get(mutant);
  if (found !== undefined) return found;
  let first: { run: IndexedRun; entry: UniverseMutant } | undefined;
  let count = 0;
  for (const run of view.runs) {
    const entry = impliedBy(run, test, mutant);
    if (entry === undefined) continue;
    count += 1;
    first ??= { run, entry };
  }
  if (first === undefined) return undefined;
  if (count === 1) return impliedState(first.run, first.entry);
  return fold(
    view.runs.flatMap((run) => {
      const entry = impliedBy(run, test, mutant);
      return entry === undefined ? [] : [impliedObservation(run.universe, entry, test)];
    }),
  );
}

/** {@link stateOf} with the test: the merged observation of a test and mutant in a lineage. */
export function observationOf(
  view: LineageObservations,
  test: string,
  mutant: string,
): MergedObservation | undefined {
  const found = view.explicit.get(test)?.get(mutant);
  if (found !== undefined) return found;
  const state = stateOf(view, test, mutant);
  return state === undefined ? undefined : { ...state, test };
}

/** The mutants a test has an observation of in a lineage, sorted. */
export const mutantsOf = (view: LineageObservations, test: string): string[] =>
  view.mutants.filter((mutant) => stateOf(view, test, mutant) !== undefined);

/**
 * The observations of a mutant in a lineage that are implied only (tests without an explicit
 * one): one state for a lineage of one run, which every such test shares; empty when none.
 */
export function impliedStatesOf(view: LineageObservations, mutant: string): ObservationState[] {
  const lacking = (test: string): boolean => view.explicit.get(test)?.get(mutant) === undefined;
  if (view.runs.length === 1) {
    const [run] = view.runs;
    const entry = run.mutants.get(mutant);
    if (entry === undefined || entry.static) return [];
    return run.universe.tests.some(lacking) ? [impliedState(run, entry)] : [];
  }
  const tests = sortedUnique(view.runs.flatMap((run) => run.universe.tests)).filter(lacking);
  return tests.flatMap((test) => {
    const state = stateOf(view, test, mutant);
    return state === undefined ? [] : [state];
  });
}

/** Every mutant with an observation in any run, sorted. */
export const observedMutants = (merged: MergedObservations): string[] =>
  sortedUnique([
    ...merged.universes.flatMap((universe) =>
      universe.tests.length === 0
        ? []
        : universe.mutants.flatMap((mutant) => (mutant.static ? [] : [mutant.id])),
    ),
    ...merged.explicit.map((entry) => entry.mutant),
  ]);

// ── Comparison ────────────────────────────────────────────────────────────

/** One pair of tests compared inside one run lineage (R11). */
export interface PairComparison {
  group: string;
  kind: RunKind;
  lineage: string;
  a: string;
  b: string;
  /** `u` + 16 hex digits of sha1 over the lineage and the sorted universe: names the comparison. */
  universeId: string;
  /** Mutants of the run with a valid observation for both tests, sorted. */
  universe: string[];
  /** Mutants of the run that either test lacks or has invalid, sorted. */
  unknown: string[];
  /** Universe mutants each test killed with an assertion, sorted. */
  killsA: string[];
  killsB: string[];
  /** Universe mutants where either test's class is neither an assertion kill nor survived. */
  otherClasses: string[];
  /**
   * Whether the kill sets are equal; null when any mutant is unknown or the run observed no
   * mutant at all (nothing to compare).
   */
  sameKills: boolean | null;
}

const ordinary = (entry: ObservationState): boolean =>
  entry.outcome === ASSERTION_KILL || entry.outcome === 'survived';

/** Compares two tests over their common universe in one run lineage; pure. */
export function comparePair(
  index: ObservationIndex,
  run: RunKey,
  a: string,
  b: string,
): PairComparison {
  const lineage = lineageKey(run);
  const view = index.lineages.get(lineage);
  const universe: string[] = [];
  const unknown: string[] = [];
  const killsA: string[] = [];
  const killsB: string[] = [];
  const otherClasses: string[] = [];
  for (const mutant of view === undefined ? [] : view.mutants) {
    const [x, y] = [stateOf(view, a, mutant), stateOf(view, b, mutant)];
    if (x?.valid !== true || y?.valid !== true) {
      unknown.push(mutant);
      continue;
    }
    universe.push(mutant);
    if (x.outcome === ASSERTION_KILL) killsA.push(mutant);
    if (y.outcome === ASSERTION_KILL) killsB.push(mutant);
    if (!ordinary(x) || !ordinary(y)) otherClasses.push(mutant);
  }
  return {
    group: run.group,
    kind: run.kind,
    lineage: run.lineage,
    a,
    b,
    universeId: `u${createHash('sha1')
      .update(JSON.stringify([lineage, universe]))
      .digest('hex')
      .slice(0, 16)}`,
    universe,
    unknown,
    killsA,
    killsB,
    otherClasses,
    sameKills:
      unknown.length > 0 || universe.length === 0
        ? null
        : killsA.length === killsB.length && killsA.every((mutant, i) => killsB[i] === mutant),
  };
}

// ── Work files ────────────────────────────────────────────────────────────

/**
 * One explicit observation in a work file: its test and mutant as indexes into the run universe's
 * `tests` and `mutants`; file and static flag come from the mutant, validity from the reasons.
 */
export type ObservationRow = [
  test: number,
  mutant: number,
  attempt: number | null,
  outcome: OutcomeClass | null,
  source: ObservationSource,
  covered: boolean,
  hookAttributed: boolean | null,
  reasons: string[],
];

const sameRun = (a: RunRef, b: RunRef): boolean =>
  a.group === b.group && a.kind === b.kind && a.lineage === b.lineage && a.shard === b.shard;

/** A run's explicit observations as rows of its universe; throws for one outside the universe. */
export function encodeObservations(
  universe: RunUniverse | null,
  observations: readonly Observation[],
): ObservationRow[] {
  if (observations.length === 0) return [];
  if (universe === null) throw new Error('observations: explicit observations need a universe');
  const tests = new Map(universe.tests.map((test, index) => [test, index]));
  const mutants = new Map(universe.mutants.map((mutant, index) => [mutant.id, index]));
  return observations.map((entry): ObservationRow => {
    const [test, mutant] = [tests.get(entry.test), mutants.get(entry.mutant)];
    const own = mutant === undefined ? undefined : universe.mutants[mutant];
    if (
      test === undefined ||
      own === undefined ||
      !sameRun(entry, universe) ||
      own.file !== entry.file ||
      own.static !== entry.static ||
      entry.valid !== (entry.reasons.length === 0)
    ) {
      throw new Error(
        `observations: ${observationKey(entry)} does not fit its run universe; not written`,
      );
    }
    return [
      test,
      mutant,
      entry.attempt,
      entry.outcome,
      entry.source,
      entry.covered,
      entry.hookAttributed,
      entry.reasons,
    ];
  });
}

const SOURCES: ReadonlySet<unknown> = new Set(['row', 'not-covered', 'stryker-timeout', 'no-row']);

const isRow = (row: unknown, tests: number, mutants: number): row is ObservationRow =>
  Array.isArray(row) &&
  row.length === 8 &&
  Number.isInteger(row[0]) &&
  row[0] >= 0 &&
  row[0] < tests &&
  Number.isInteger(row[1]) &&
  row[1] >= 0 &&
  row[1] < mutants &&
  (row[2] === null || Number.isInteger(row[2])) &&
  (row[3] === null || typeof row[3] === 'string') &&
  SOURCES.has(row[4]) &&
  typeof row[5] === 'boolean' &&
  (row[6] === null || typeof row[6] === 'boolean') &&
  Array.isArray(row[7]) &&
  row[7].every((reason: unknown) => typeof reason === 'string');

/** The explicit observations of a work file's rows; throws for a malformed row. */
export function decodeObservations(
  universe: RunUniverse | null,
  rows: readonly unknown[],
): Observation[] {
  if (rows.length === 0) return [];
  if (universe === null) throw new Error('observations: rows without a run universe');
  const ref = refOf(universe);
  return rows.map((row, index): Observation => {
    if (!isRow(row, universe.tests.length, universe.mutants.length)) {
      throw new Error(`observations: row ${index} is not an observation of its run universe`);
    }
    const [test, mutant, attempt, outcome, source, covered, hookAttributed, reasons] = row;
    const own = universe.mutants[mutant];
    return {
      ...ref,
      attempt,
      test: universe.tests[test],
      mutant: own.id,
      file: own.file,
      covered,
      hookAttributed,
      static: own.static,
      outcome,
      source,
      valid: reasons.length === 0,
      reasons,
    };
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Shallow shape check of a run universe read from a work file. */
export const isRunUniverse = (value: unknown): value is RunUniverse =>
  isRecord(value) &&
  typeof value.group === 'string' &&
  (value.kind === 'main' || value.kind === 'together' || value.kind === 'alone') &&
  typeof value.lineage === 'string' &&
  typeof value.shard === 'number' &&
  Array.isArray(value.tests) &&
  Array.isArray(value.mutants) &&
  value.mutants.every(
    (mutant: unknown) =>
      isRecord(mutant) &&
      typeof mutant.id === 'string' &&
      typeof mutant.file === 'string' &&
      typeof mutant.static === 'boolean' &&
      Array.isArray(mutant.reasons) &&
      typeof mutant.hookMarker === 'boolean',
  ) &&
  typeof value.valid === 'boolean' &&
  Array.isArray(value.reasons);
