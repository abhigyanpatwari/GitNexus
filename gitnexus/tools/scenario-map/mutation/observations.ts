/**
 * Raw Layer 3 observations of the scenario map (U7, R6, R7, R11, KTD8, design §5.4): what one
 * group run says about one test and one mutant, the unit that shards merge.
 *
 * Extraction ({@link extractObservations}) reads a scope-driver `results.json` (schema 2,
 * tools/mutation/driver/normalise-results.ts). The run's test set is its `scope.testIds`; its
 * universe is every mutant Stryker evaluated (every status but `Ignored` and `Pending`). For each
 * mutant and test of the run:
 *   - one observation per per-test row of every sidecar attempt (`source: row`), with the row's
 *     outcome class and the attempt's index (oldest first);
 *   - no row, the mutant neither static nor in the test's `coveredBy`: Stryker never ran the
 *     test against it, a valid `survived` (`source: not-covered`; NoCoverage is survived, KTD13);
 *   - no row, a Stryker timeout without a sidecar: `timeout` that cannot be attributed to a test
 *     (`source: stryker-timeout`, invalid);
 *   - no row otherwise (covered or static): unknown, outcome null (`source: no-row`, invalid
 *     `missing-result`). A missing result is never a non-kill (design §5.4).
 * An observation is invalid, with its reasons, when the run carries a run-level integrity flag
 * (`run-flag:<kind>`), the mutant carries one (`mutant-flag:<kind>`), its span-map check failed
 * (`span-map`), its attempts disagree (`attempts-disagree`, KTD8), or the row's attempt has a run
 * class whose rows cannot be trusted (`run-timeout`, `run-infrastructure`, `run-inconclusive`,
 * `run-invalid`: classify-outcome.ts; such a run can still hold assertion rows).
 *
 * Identity (R11). An observation is keyed by group, run kind, lineage, attempt, test and global
 * mutant id ({@link observationKey}). The lineage names one run among the group's runs of its
 * kind: `main` for the group run, the pair for a `together` run, the test for an `alone` run
 * (isolation, U8). The test is its Phase 0 id, the execution identity inside one run (KTD3; the
 * baselines prove the identities stable). The global mutant id carries the original file's content
 * hash (tools/mutation/prepare/mutant-identity.ts).
 *
 * Merging ({@link mergeObservations}) folds the attempts of one lineage per test and mutant:
 * agreeing classes keep the class; different classes become one `inconclusive` observation
 * (`class-disagreement`); reasons are united. Observations of different groups or lineages are
 * never folded: two groups can mutate one file, and a mutant can survive one and die in another.
 * Verdicts, weak tests, gaps and subsumption are recomputed from merged observations, never summed.
 *
 * Comparison ({@link comparePair}) looks at one lineage only. The pair's universe is the mutants of
 * that run with a valid observation for both tests; a mutant of the run that either test lacks or
 * has invalid is unknown, and with any unknown mutant, or none at all (a run that was never
 * observed), the kill sets are not compared. Only
 * `killed-by-test:assertion` is a kill (R6).
 *
 * Library only; pure. The group run (run-group.ts) writes the observations of each group as soon
 * as it finishes; the merge stage and the verdict engine (U12) read them.
 */
import { createHash } from 'node:crypto';
import type { NormalisedMutant, RunResults } from '../../mutation/driver/normalise-results.js';
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

/** The tests of a run: its requested ids, or every test that was not skipped. */
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

function mutantObservations(
  mutant: NormalisedMutant,
  tests: readonly string[],
  ref: RunRef,
  shared: readonly string[],
  spanFailures: ReadonlySet<string>,
): Observation[] {
  const reasons = [
    ...shared,
    ...mutant.flags.map((kind) => `mutant-flag:${kind}`),
    ...(spanFailures.has(mutant.globalId) ? ['span-map'] : []),
    ...(mutant.attemptsDisagree ? ['attempts-disagree'] : []),
  ];
  const covered = new Set(mutant.coveredBy ?? []);
  const hooked = mutant.hookAttributedTests === null ? null : new Set(mutant.hookAttributedTests);
  const isStatic = mutant.static === true;
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
      static: isStatic,
      outcome,
      source,
      valid: all.length === 0,
      reasons: all,
    };
  };
  return tests.flatMap((test): Observation[] => {
    const rows = mutant.perTest.filter((row) => row.testId === test);
    if (rows.length > 0) {
      return rows.map((row) => {
        const run = mutant.attempts[row.attempt]?.outcome;
        const distrust =
          run === undefined ? ['attempt-missing'] : UNTRUSTED_RUN.has(run) ? [`run-${run}`] : [];
        return make(test, row.attempt, row.outcome, 'row', distrust);
      });
    }
    const exposed = isStatic || covered.has(test) || mutant.coveredBy === null;
    if (!exposed) return [make(test, null, 'survived', 'not-covered', [])];
    if (mutant.outcomeSource === 'stryker-timeout') {
      return [make(test, null, 'timeout', 'stryker-timeout', ['stryker-timeout'])];
    }
    return [make(test, null, null, 'no-row', ['missing-result'])];
  });
}

/** Every observation of one scope-driver run; see the module comment. Sorted by mutant, test. */
export function extractObservations(results: RunResults, ref: RunRef): Observation[] {
  const tests = testsOf(results);
  const shared = runReasons(results);
  const spanFailures = new Set(results.spanMap.failures.map((failure) => failure.globalId));
  return results.mutants
    .filter(isEvaluated)
    .sort((a, b) => byText(a.globalId, b.globalId))
    .flatMap((mutant) => mutantObservations(mutant, tests, ref, shared, spanFailures));
}

/** The run lineage of an observation: group, kind and lineage. */
const lineageKey = (entry: Pick<RunRef, 'group' | 'kind' | 'lineage'>): string =>
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

/**
 * Merges observations from any number of shards and runs: one per lineage, test and mutant,
 * sorted by group, kind, lineage, mutant and test.
 */
export function mergeObservations(observations: readonly Observation[]): MergedObservation[] {
  const byKey = new Map<string, Observation[]>();
  for (const entry of observations) {
    const key = JSON.stringify([lineageKey(entry), entry.mutant, entry.test]);
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  return [...byKey.entries()].sort(([a], [b]) => byText(a, b)).map(([, entries]) => fold(entries));
}

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

/**
 * Compares two tests over their common universe in one run lineage; pure. It filters `merged` on
 * every call, so callers comparing many pairs pass one group's merged observations.
 */
export function comparePair(
  merged: readonly MergedObservation[],
  run: Pick<RunRef, 'group' | 'kind' | 'lineage'>,
  a: string,
  b: string,
): PairComparison {
  const lineage = lineageKey(run);
  const inRun = merged.filter((entry) => lineageKey(entry) === lineage);
  const of = (test: string): Map<string, MergedObservation> =>
    new Map(inRun.filter((entry) => entry.test === test).map((entry) => [entry.mutant, entry]));
  const [obsA, obsB] = [of(a), of(b)];
  const universe: string[] = [];
  const unknown: string[] = [];
  for (const mutant of sortedUnique(inRun.map((entry) => entry.mutant))) {
    const [x, y] = [obsA.get(mutant), obsB.get(mutant)];
    if (x?.valid === true && y?.valid === true) universe.push(mutant);
    else unknown.push(mutant);
  }
  const kills = (observed: Map<string, MergedObservation>): string[] =>
    universe.filter((mutant) => observed.get(mutant)?.outcome === ASSERTION_KILL);
  const ordinary = (entry: MergedObservation | undefined): boolean =>
    entry?.outcome === ASSERTION_KILL || entry?.outcome === 'survived';
  const [killsA, killsB] = [kills(obsA), kills(obsB)];
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
    otherClasses: universe.filter(
      (mutant) => !ordinary(obsA.get(mutant)) || !ordinary(obsB.get(mutant)),
    ),
    sameKills:
      unknown.length > 0 || universe.length === 0
        ? null
        : killsA.length === killsB.length && killsA.every((mutant, i) => killsB[i] === mutant),
  };
}
