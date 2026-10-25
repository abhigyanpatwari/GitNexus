/**
 * Verdict engine of the scenario map (U12, R10, R11, R15, KTD5, KTD8, KTD9, KTD12, design §2,
 * §5.4, §5.6): one verdict per candidate pair with the rule that decided it and every weak
 * disqualifier, the per-test Weak, Inconclusive and Subsumed properties, and the per-file gaps,
 * all recomputed from the merged Layer 3 observations and the Layer 1/2 and value-flow evidence.
 * Pure: plain data in ({@link VerdictInput}, assembled by the CLI from the stage artifacts), plain
 * data out ({@link VerdictReport}), sorted, so a rerun on the same input is byte-identical and the
 * input order does not matter (a pair is oriented with the smaller test id first).
 *
 * Trusted observations (R11, KTD14). Only the groups with at least one `evaluated` pair schedule
 * (plan-shards.ts `resolvePairSchedules`) count; other groups' observations are ignored. A test is
 * evaluated when one of its pairs is. Observations are observations.ts `mergeObservations` output
 * over every complete group run and isolation run verified against this run's manifest; each test
 * has one `main` run (its candidate group). They follow the compact model: explicit observations
 * plus run universes; an observation a universe implies (a selected test Stryker never ran against
 * a non-static mutant: a not-covered survival) is read through the index, never materialised. It
 * is never covered, exposed, a kill or another class, so the per-test status, kills and the hook
 * check's exposed path come from explicit observations; validity, rerun classes, path and gaps
 * read the implied ones too.
 *
 * Per test ({@link TestResult}), over its trusted observations of every run. A test is exposed to
 * a mutant when it covers it, the mutant is static, or it has a per-test row (isolation.ts).
 *   out-of-scope   not eligible (R1), or evaluated without covering any mutant (design §2);
 *   inconclusive   not evaluated, or no assertion kill while an exposed observation is invalid or
 *                  of another class (runtime, hook, timeout …: KTD8, never Weak);
 *   weak           covers mutants, every exposed observation a valid survival: "kills no
 *                  evaluated mutants" ({@link WORDING});
 *   killing        at least one valid assertion kill (only `killed-by-test:assertion` is a kill).
 * Subsumed (design §5.4): A's non-empty kill set lies strictly inside B's over A's universe (every
 * mutant of A's main run), A valid on all of it, and B evaluated (a valid observation) on every
 * mutant of it within B's own group run. B kills all of A's kills but that run lacks a mutant of
 * A's universe, or A has an invalid result: unknown (so is a test with several main runs). Only
 * eligible B count. A Subsumed test is reported as "no unique protection among evaluated mutants".
 *
 * Per pair ({@link PairVerdict}). The facts: the group's `main` comparison (observations.ts
 * `comparePair`); the path (each universe mutant static, covered or not alike for both tests);
 * the checks-and-context keys (U5); the facets (U6): equal fingerprints with a residual difference
 * (`residualDifference`) are not facet-equal (D1, `residual`), and the discarded values are
 * compared with `sameDiscardedValues`. Then {@link RULES}, design §2 precedence, first decisive
 * rule wins:
 *   Inconclusive  the schedule reason (not evaluated); a concurrent test or an unattributable path;
 *                 a mutant of the run without a valid result for both (`kills-unknown`); another
 *                 class on a universe mutant; isolation disagrees or unknown (U8); two valid
 *                 observations of one test and mutant in different runs with different classes
 *                 (`rerun-disagrees`); a member test per-test inconclusive; on the repeat path, a
 *                 trace that is inconclusive or did not run (U11). Every cause that holds is listed;
 *   Out of scope  a test not eligible, or covering no evaluated mutant;
 *   Weak          a test Weak, or an empty kill set: never part of a repeat;
 *   value flow    (KTD12: a gate before any repeat category) on the repeat path (same path,
 *                 checks, context, facet, non-empty kill set, row deletion not asymmetric): a trace
 *                 veto, or, when the discarded values differ, a static veto (also a run degraded by
 *                 `no-pdg-layer`) is `value-flow-veto`; an unknown, missing or checker-degraded
 *                 static check is `value-flow-unknown`. Both are Review, never a repeat;
 *   Repeat        on the repeat path: strong with no weak disqualifier, else weak;
 *   Row           same path, checks, context and facet, and the kill sets differ or row deletion
 *                 is asymmetric;
 *   Review        same path, checks, context and kills, but the facet differs, has a residual
 *                 difference, or is missing;
 *   Distinct      anything else, naming what differs.
 * Weak disqualifiers ({@link WEAK_DISQUALIFIERS}), listed for every pair, deciding only between the
 * two repeat categories: provenance not strong-eligible (unknown, a native entry point, a worker
 * spawn; design §2); an unresolved facet input (the facet's, the inventory's, a checks selector's,
 * a missing facet, a residual difference); inconclusive row deletion (or none for differing
 * discarded values); an unsupported construct (a join that is not one-to-one, R2; an unsupported
 * assertion form); isolation not run (KTD9); a test not oracle-validated; non-identical V8 blocks
 * (KTD5); an excluded file (KTD7); a hook stratum (KTD9: U8's disqualifier, or any observation of
 * either test on a mutant of the pair's path or kills whose hook marker is not false).
 *
 * Gaps (R11, design §5.4), per production file over every trusted observation: a mutant is killed
 * when any valid assertion kill exists; otherwise inconclusive when any observation is invalid or
 * of another class (a missing result is never a survival); otherwise "survived the selected tests"
 * when some test is exposed to it (static mutants count as covered); otherwise "uncovered by
 * selected tests".
 *
 * Human keep (R15): a pair with a `// dupe-ok:` reason on either test goes to `kept` with its full
 * evidence and is absent from `pairs`. The tool never edits a test.
 *
 * Library only; the scenario-map CLI (U14) assembles the input and the report (U13) renders the
 * output and folds {@link VERDICT_ENGINE_VERSION} into the evidence hash.
 */
import type { OutcomeClass } from '../../mutation/runner/classify-outcome.js';
import type { UnsupportedForm } from '../facet/checks.js';
import { residualDifference, sameDiscardedValues, type InputFacet } from '../facet/input-facet.js';
import type { IsolationResult, IsolationStatus } from '../mutation/isolation.js';
import {
  MAIN_LINEAGE,
  comparePair,
  impliedStatesOf,
  indexObservations,
  lineageOf,
  mutantsOf,
  stateOf,
  type LineageObservations,
  type MergedObservation,
  type MergedObservations,
  type ObservationIndex,
  type ObservationState,
  type PairComparison,
  type RunKey,
} from '../mutation/observations.js';
import type { PairRef, PairSchedule, ScheduleReason } from '../mutation/plan-shards.js';
import type { RowDeletionOutcome, RowDeletionResult } from '../mutation/row-deletion.js';
import type { Provenance } from '../path-coverage/run-coverage.js';
import type { DegradedFlag, PairValueFlow } from '../value-flow/pdg-walk.js';
import type { PairTrace, TraceStatus } from '../value-flow/trace.js';

/** Folded into the evidence hash (KTD12): a rule change resurfaces every pair it reclassifies. */
export const VERDICT_ENGINE_VERSION = 1;

/** Design §2 verdict categories; see {@link VERDICT_PRECEDENCE}. */
export type Verdict =
  | 'inconclusive'
  | 'out-of-scope'
  | 'weak'
  | 'repeat-strong'
  | 'repeat-weak'
  | 'row'
  | 'review'
  | 'distinct';

/** Design §2 precedence, highest first. */
export const VERDICT_PRECEDENCE: readonly Verdict[] = [
  'inconclusive',
  'out-of-scope',
  'weak',
  'repeat-strong',
  'repeat-weak',
  'row',
  'review',
  'distinct',
];

/** The weak disqualifiers (design §2, KTD5, KTD7, KTD9), in report order. */
export const WEAK_DISQUALIFIERS = [
  'provenance-not-strong-eligible',
  'unresolved-facet-input',
  'row-deletion-inconclusive',
  'unsupported-construct',
  'isolation-not-run',
  'not-oracle-validated',
  'non-identical-blocks',
  'excluded-file',
  'hook-stratum',
] as const;
export type WeakDisqualifier = (typeof WEAK_DISQUALIFIERS)[number];

export type InconclusiveRule =
  | ScheduleReason
  | 'path-unattributable'
  | 'kills-unknown'
  | 'non-assertion-outcome'
  | 'isolation-disagrees'
  | 'isolation-unknown'
  | 'rerun-disagrees'
  | 'member-inconclusive'
  | 'trace-inconclusive';

/** The rule that decided a pair; see the module comment. */
export type RuleId =
  | InconclusiveRule
  | 'not-eligible'
  | 'covers-no-evaluated-mutant'
  | 'kills-nothing'
  | 'value-flow-veto'
  | 'value-flow-unknown'
  | 'all-strong-conditions'
  | 'weak-disqualifier'
  | 'kills-differ'
  | 'row-deletion-asymmetric'
  | 'residual-difference'
  | 'facet-differs-same-kills'
  | 'facet-missing-same-kills'
  | 'path-differs'
  | 'checks-context-missing'
  | 'checks-context-differs'
  | 'facet-differs-kills-differ'
  /** Design §2 "Distinct: anything else"; unreachable while the other rules cover every case. */
  | 'anything-else';

/** The scoped wording of design §5.4. */
export const WORDING = Object.freeze({
  weak: 'kills no evaluated mutants',
  subsumed: 'no unique protection among evaluated mutants',
  survived: 'survived the selected tests',
  uncovered: 'uncovered by selected tests',
});

// ── Input ──────────────────────────────────────────────────────────────────

/** What the engine reads of one test; every field comes from a stage artifact. */
export interface VerdictTestInput {
  /** Phase 0 test id. */
  id: string;
  /** R1: in the eligible category (envelope and classifier; every controls fixture test). */
  eligible: boolean;
  /** Phase 0: gate 3 cannot validate the id (U3 `InventoryInstance.notOracleValidated`). */
  notOracleValidated: boolean;
  /** U3 `// dupe-ok:` reason (R15); null when absent. */
  dupeOk: string | null;
  /** U3 join problems (R2, `InventoryInstance.unsupported`): non-empty is unsupported. */
  joinProblems: readonly string[];
  /** U3 unresolved static inputs (`InventoryInstance.unresolved`). */
  inventoryUnresolved: readonly string[];
  /** U4 Layer 1 provenance; null when the test has no coverage record. */
  provenance: Pick<Provenance, 'known' | 'nativeEntries' | 'workerSpawns'> | null;
  /** U4: the test ran concurrently (its path is unattributable). */
  concurrent: boolean;
  /** KTD7 excluded files of the test (plan-shards.ts `GroupScope.excluded`), repo paths. */
  excludedFiles: readonly string[];
  /** U5 checks-and-context key; null when the test has none. */
  checksContext: string | null;
  /** U5 unsupported assertion forms (`InstanceChecks.unsupported`). */
  unsupportedForms: readonly UnsupportedForm[];
  /** U5 selectors whose instance value is not static (`InstanceChecks.unresolved`). */
  unresolvedSelectors: readonly string[];
  /** U6 facet as computed, without the residual guard applied (the engine applies it per pair). */
  facet: InputFacet | null;
}

/** What the engine reads of one candidate pair; a stage that did not run is null. */
export interface VerdictPairInput extends PairRef {
  /** KTD5: the V8 block sets are equal (path-coverage/candidates.ts `CandidatePair`). */
  identicalBlocks: boolean;
  /** Design §5.2: either test ran concurrently (`CandidatePair.pathUnattributable`). */
  pathUnattributable: boolean;
  /** U7 `resolvePairSchedules`. */
  schedule: Pick<PairSchedule, 'status' | 'reason' | 'detail'>;
  /** U8 `evaluateIsolation`; null: not run. */
  isolation: Pick<IsolationResult, 'status' | 'reason' | 'disqualifiers'> | null;
  /** U9 `runRowDeletion`; null: not run. */
  rowDeletion: Pick<RowDeletionResult, 'outcome' | 'reasons'> | null;
  /** U10 `staticValueFlow` pair; null: not run. */
  staticValueFlow: Pick<PairValueFlow, 'status' | 'reasons'> | null;
  /** U11 `runTrace` pair; null: not run. */
  trace: Pick<PairTrace, 'status' | 'reasons'> | null;
}

export interface VerdictInput {
  /** Every test of a pair, and any other evaluated test whose properties are reported. */
  tests: readonly VerdictTestInput[];
  pairs: readonly VerdictPairInput[];
  /** Merged observations of every group run and isolation run (U7, U8), compact model. */
  observations: MergedObservations;
  /** U10 run-level degraded flags (`StaticValueFlowRun.degraded`). */
  valueFlowDegraded: readonly DegradedFlag[];
}

// ── Output ─────────────────────────────────────────────────────────────────

export type TestStatus = 'out-of-scope' | 'inconclusive' | 'weak' | 'killing';
export type SubsumptionStatus = 'subsumed' | 'unknown' | 'not-subsumed' | 'not-applicable';

export interface Subsumption {
  status: SubsumptionStatus;
  /** The subsuming tests (subsumed), or those that might subsume (unknown); sorted. */
  by: string[];
  /** Universe id of the test's main run (observations.ts `comparePair` of the test with itself). */
  universeId: string | null;
  /** Mutants in that universe. */
  universe: number;
}

export interface TestResult {
  id: string;
  status: TestStatus;
  /** Why the status is not `killing`, sorted. */
  reasons: string[];
  /** Mutants the test covers (`coveredBy`), distinct. */
  covered: number;
  /** Mutants the test kills by assertion, distinct. */
  kills: number;
  subsumption: Subsumption;
  /** The design §5.4 statements that hold ({@link WORDING}). */
  statements: string[];
}

export type FacetRelation = 'equal' | 'differs' | 'residual' | 'missing';

/** The stage results behind a pair's verdict; a stage without a result is `not-run`. */
export interface PairEvidence {
  schedule: PairSchedule['status'];
  /** The main comparison's universe id; null when the pair was not evaluated. */
  universeId: string | null;
  universe: number;
  unknown: number;
  killsA: number;
  killsB: number;
  otherClasses: number;
  path: 'same' | 'differs' | null;
  checksContext: 'same' | 'differs' | 'missing';
  facet: FacetRelation;
  /** Null unless the fingerprints are equal. */
  discardedValues: 'equal' | 'differ' | null;
  killSets: 'equal' | 'differ' | 'unknown';
  rowDeletion: RowDeletionOutcome | 'not-run';
  trace: TraceStatus | 'not-run';
  staticValueFlow: PairValueFlow['status'] | 'not-run';
  isolation: IsolationStatus | 'not-run';
}

export interface Disqualifier {
  kind: WeakDisqualifier;
  /** The tests it applies to, sorted; empty for a pair-level one. */
  tests: string[];
  /** What triggered it, sorted and distinct. */
  details: string[];
}

export interface KeepMark {
  test: string;
  reason: string;
}

export interface PairVerdict extends PairRef {
  verdict: Verdict;
  rule: RuleId;
  /** What the deciding rule saw, sorted and distinct. */
  details: string[];
  /** Every Inconclusive cause that holds, in rule order; the first decides. */
  inconclusive: InconclusiveRule[];
  disqualifiers: Disqualifier[];
  /** `// dupe-ok:` reasons (R15); non-empty exactly for the kept pairs. */
  keep: KeepMark[];
  evidence: PairEvidence;
}

export interface FileGaps {
  /** Repo path of the production file. */
  file: string;
  /** Distinct mutants observed. */
  mutants: number;
  killed: number;
  /** "survived the selected tests", sorted. */
  survived: string[];
  /** "uncovered by selected tests", sorted. */
  uncovered: string[];
  /** Never killed, with an invalid or non-assertion observation: no gap claim, sorted. */
  inconclusive: string[];
}

export interface VerdictReport {
  engineVersion: number;
  /** Findings, sorted by a, b, group. */
  pairs: PairVerdict[];
  /** Pairs with a `dupe-ok` keep, same order. */
  kept: PairVerdict[];
  /** Sorted by id. */
  tests: TestResult[];
  /** Sorted by file. */
  gaps: FileGaps[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const ASSERTION_KILL: OutcomeClass = 'killed-by-test:assertion';

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(byText);

/** The test ran against the mutant: covered, static, or a per-test row (as isolation.ts). */
const exposed = (entry: ObservationState): boolean =>
  entry.covered || entry.static || entry.sources.includes('row');
const isKill = (entry: ObservationState | undefined): boolean =>
  entry !== undefined && entry.valid && entry.outcome === ASSERTION_KILL;
/** Valid, and neither a kill nor a survival. */
const isOtherClass = (entry: ObservationState): boolean =>
  entry.valid &&
  entry.outcome !== null &&
  entry.outcome !== ASSERTION_KILL &&
  entry.outcome !== 'survived';
const isUnknown = (entry: ObservationState): boolean => !entry.valid || entry.outcome === null;
const coverageOf = (entry: ObservationState | undefined): string =>
  entry === undefined
    ? 'missing'
    : entry.static
      ? 'static'
      : entry.covered
        ? 'covered'
        : 'not-covered';

type ByMutant = Map<string, MergedObservation[]>;

/** Trusted observations, indexed. */
interface Index {
  /** Every trusted lineage. */
  observations: ObservationIndex;
  /** Per test, per mutant: its explicit observations (every lineage). */
  explicitByTest: Map<string, ByMutant>;
  /** Per mutant: every explicit observation. */
  explicitByMutant: ByMutant;
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
};

const isMain = (run: RunKey): boolean => run.kind === 'main' && run.lineage === MAIN_LINEAGE;
const mainRun = (group: string): RunKey => ({ group, kind: 'main', lineage: MAIN_LINEAGE });

/** The trusted groups' observations, indexed; the input order does not matter. */
function buildIndex(merged: MergedObservations, trusted: ReadonlySet<string>): Index {
  const observations = indexObservations(merged, (run) => trusted.has(run.group));
  const explicitByTest = new Map<string, ByMutant>();
  const explicitByMutant: ByMutant = new Map();
  for (const view of observations.lineages.values()) {
    for (const [test, byMutant] of view.explicit) {
      const ofTest = explicitByTest.get(test) ?? new Map<string, MergedObservation[]>();
      explicitByTest.set(test, ofTest);
      for (const entry of byMutant.values()) {
        push(ofTest, entry.mutant, entry);
        push(explicitByMutant, entry.mutant, entry);
      }
    }
  }
  return { observations, explicitByTest, explicitByMutant };
}

/** Every trusted observation of a test and mutant (each lineage of the test), explicit or not. */
const observedIn = (index: Index, test: string, mutant: string): ObservationState[] =>
  (index.observations.byTest.get(test) ?? []).flatMap((view) => {
    const state = stateOf(view, test, mutant);
    return state === undefined ? [] : [state];
  });

// ── Per test ───────────────────────────────────────────────────────────────

interface TestFacts {
  input: VerdictTestInput;
  status: TestStatus;
  reasons: string[];
  covered: number;
  kills: number;
}

function classifyTest(
  input: VerdictTestInput,
  observed: ByMutant | undefined,
  evaluated: boolean,
): TestFacts {
  const entries = [...(observed?.values() ?? [])].flat();
  const touched = entries.filter(exposed);
  const covered = sortedUnique(entries.filter((entry) => entry.covered).map((e) => e.mutant));
  const kills = sortedUnique(touched.filter(isKill).map((entry) => entry.mutant));
  const facts = (status: TestStatus, reasons: string[]): TestFacts => ({
    input,
    status,
    reasons,
    covered: covered.length,
    kills: kills.length,
  });
  if (!input.eligible) return facts('out-of-scope', ['not-eligible']);
  if (!evaluated) return facts('inconclusive', ['not-evaluated']);
  if (kills.length > 0) return facts('killing', []);
  const other = sortedUnique(touched.filter(isOtherClass).map((entry) => String(entry.outcome)));
  const unknown = touched.filter(isUnknown);
  if (other.length > 0 || unknown.length > 0) {
    const reasons = sortedUnique(unknown.flatMap((entry) => entry.reasons));
    return facts('inconclusive', [
      ...(other.length > 0 ? [`non-assertion-outcome: ${other.join(', ')}`] : []),
      ...(unknown.length > 0 ? [`unknown-result: ${reasons.join(', ') || 'unknown'}`] : []),
    ]);
  }
  if (covered.length === 0) return facts('out-of-scope', ['covers-no-evaluated-mutant']);
  return facts('weak', []);
}

/** The main lineages a test has an observation in. */
const mainRunsOf = (index: Index, test: string): LineageObservations[] =>
  (index.observations.byTest.get(test) ?? []).filter(isMain);

/** A test's only main run; null without one or with several. */
function mainRunOf(index: Index, test: string): LineageObservations | null {
  const runs = mainRunsOf(index, test);
  return runs.length === 1 ? runs[0] : null;
}

function subsumptionOf(
  facts: TestFacts,
  index: Index,
  killers: ReadonlyMap<string, ReadonlySet<string>>,
  eligible: ReadonlySet<string>,
): Subsumption {
  const test = facts.input.id;
  const own = facts.status === 'killing' ? mainRunOf(index, test) : null;
  if (own === null) {
    const several = facts.status === 'killing' && mainRunsOf(index, test).length > 1;
    return {
      status: several ? 'unknown' : 'not-applicable',
      by: [],
      universeId: null,
      universe: 0,
    };
  }
  const self = comparePair(index.observations, mainRun(own.group), test, test);
  const universe = mutantsOf(own, test);
  const ownOf = (mutant: string): ObservationState | undefined => stateOf(own, test, mutant);
  const kills = universe.filter((mutant) => isKill(ownOf(mutant)));
  const result = (status: SubsumptionStatus, by: readonly string[]): Subsumption => ({
    status,
    by: sortedUnique(by),
    universeId: self.universeId,
    universe: universe.length,
  });
  if (kills.length === 0) return result('not-applicable', []);
  const complete = universe.every((mutant) => ownOf(mutant)?.valid === true);
  const candidates = sortedUnique(killers.get(kills[0]) ?? []).filter(
    (other) =>
      other !== test &&
      eligible.has(other) &&
      kills.every((mutant) => killers.get(mutant)?.has(other) === true),
  );
  const subsumers: string[] = [];
  const possible: string[] = [];
  for (const other of candidates) {
    const theirs = mainRunOf(index, other);
    const theirsOf = (mutant: string): ObservationState | undefined =>
      theirs === null ? undefined : stateOf(theirs, other, mutant);
    const evaluated =
      theirs !== null && universe.every((mutant) => theirsOf(mutant)?.valid === true);
    if (!evaluated || !complete) possible.push(other);
    else if (universe.some((mutant) => isKill(theirsOf(mutant)) && !isKill(ownOf(mutant)))) {
      subsumers.push(other);
    }
  }
  if (subsumers.length > 0) return result('subsumed', subsumers);
  return result(possible.length > 0 ? 'unknown' : 'not-subsumed', possible);
}

/** Per mutant: the tests with a valid assertion kill in their main run (never implied). */
function killersIndex(index: Index): Map<string, Set<string>> {
  const killers = new Map<string, Set<string>>();
  for (const view of index.observations.lineages.values()) {
    if (!isMain(view)) continue;
    for (const byMutant of view.explicit.values()) {
      for (const entry of byMutant.values()) {
        if (!isKill(entry)) continue;
        const tests = killers.get(entry.mutant) ?? new Set<string>();
        killers.set(entry.mutant, tests.add(entry.test));
      }
    }
  }
  return killers;
}

// ── Per pair: facts ────────────────────────────────────────────────────────

interface StageResult<S extends string> {
  status: S;
  details: string[];
}

interface PairFacts {
  pair: VerdictPairInput;
  a: TestFacts;
  b: TestFacts;
  comparison: PairComparison | null;
  path: 'same' | 'differs' | null;
  pathDiffers: string[];
  checksContext: 'same' | 'differs' | 'missing';
  facet: FacetRelation;
  residual: string[];
  discarded: 'equal' | 'differ' | null;
  rowDeletion: StageResult<RowDeletionOutcome>;
  /** Same path, checks, context, facet, non-empty kill sets, row deletion not asymmetric. */
  repeatStage: boolean;
  trace: StageResult<TraceStatus>;
  staticRequired: boolean;
  staticFlow: StageResult<'clean' | 'veto' | 'unknown' | 'not-required'>;
  rerun: string[];
  unknownDetails: string[];
  otherDetails: string[];
  disqualifiers: Disqualifier[];
}

function facetRelation(
  a: InputFacet | null,
  b: InputFacet | null,
): { facet: FacetRelation; residual: string[]; discarded: 'equal' | 'differ' | null } {
  if (a === null || b === null) return { facet: 'missing', residual: [], discarded: null };
  if (a.fingerprint !== b.fingerprint) return { facet: 'differs', residual: [], discarded: null };
  const residual = sortedUnique(residualDifference(a, b).map((entry) => entry.path));
  return {
    facet: residual.length > 0 ? 'residual' : 'equal',
    residual,
    discarded: sameDiscardedValues(a, b) ? 'equal' : 'differ',
  };
}

function rowDeletionOf(
  input: VerdictPairInput['rowDeletion'],
  discarded: 'equal' | 'differ' | null,
): StageResult<RowDeletionOutcome> {
  if (input !== null) return { status: input.outcome, details: sortedUnique(input.reasons) };
  // Row deletion applies to differing discarded values (U9); without a result, they block strong.
  return discarded === 'differ'
    ? { status: 'inconclusive', details: ['not-run'] }
    : { status: 'not-applicable', details: [] };
}

function staticFlowOf(
  input: VerdictPairInput['staticValueFlow'],
  degraded: readonly DegradedFlag[],
): StageResult<'clean' | 'veto' | 'unknown' | 'not-required'> {
  if (degraded.includes('no-pdg-layer')) return { status: 'veto', details: ['no-pdg-layer'] };
  const checker = degraded.filter((flag) => flag !== 'no-pdg-layer');
  if (checker.length > 0) return { status: 'unknown', details: sortedUnique(checker) };
  if (input === null) return { status: 'unknown', details: ['not-run'] };
  if (input.status === 'not-required') {
    return { status: 'unknown', details: ['not-required for differing discarded values'] };
  }
  return { status: input.status, details: sortedUnique(input.reasons) };
}

/**
 * Per test of the pair and mutant of its run: valid classes that differ between runs. An implied
 * observation is a survival, so only a mutant with an explicit valid class other than survived
 * can differ.
 */
function rerunDisagreements(
  tests: readonly string[],
  mutants: readonly string[],
  index: Index,
): string[] {
  return tests.flatMap((test) => {
    const explicit = index.explicitByTest.get(test);
    return mutants.flatMap((mutant) => {
      const own = explicit?.get(mutant) ?? [];
      if (!own.some((entry) => !isUnknown(entry) && entry.outcome !== 'survived')) return [];
      const classes = sortedUnique(
        observedIn(index, test, mutant).flatMap((entry) =>
          isUnknown(entry) ? [] : [String(entry.outcome)],
        ),
      );
      return classes.length > 1 ? [`${test}: ${classes.join(' / ')} on ${mutant}`] : [];
    });
  });
}

/** The hook-attributed mutants of the pair's path or kills (KTD9; see the module comment). */
function hookedMutants(
  pair: VerdictPairInput,
  comparison: PairComparison | null,
  index: Index,
): string[] {
  const fromIsolation = (pair.isolation?.disqualifiers ?? []).flatMap((entry) => entry.mutants);
  if (comparison === null) return sortedUnique(fromIsolation);
  const tests = [pair.a, pair.b];
  // Exposure needs an explicit observation: an implied one is never covered, static or a row.
  const touched = [
    ...comparison.killsA,
    ...comparison.killsB,
    ...comparison.universe.filter((mutant) =>
      tests.some((test) => (index.explicitByTest.get(test)?.get(mutant) ?? []).some(exposed)),
    ),
  ];
  const hooked = sortedUnique(touched).filter((mutant) =>
    tests.some((test) =>
      observedIn(index, test, mutant).some((entry) => entry.hookAttributed !== false),
    ),
  );
  return sortedUnique([...fromIsolation, ...hooked]);
}

function disqualifiersOf(
  facts: Omit<PairFacts, 'disqualifiers'>,
  hooked: readonly string[],
): Disqualifier[] {
  const found = new Map<WeakDisqualifier, { tests: Set<string>; details: Set<string> }>();
  const add = (kind: WeakDisqualifier, tests: readonly string[], details: readonly string[]) => {
    const entry = found.get(kind) ?? { tests: new Set<string>(), details: new Set<string>() };
    found.set(kind, entry);
    for (const test of tests) entry.tests.add(test);
    for (const detail of details) entry.details.add(detail);
  };
  for (const { input } of [facts.a, facts.b]) {
    const test = [input.id];
    const provenance = input.provenance;
    const notEligible =
      provenance === null
        ? ['no provenance record']
        : [
            ...(provenance.known ? [] : ['unknown provenance']),
            ...provenance.nativeEntries.map((entry) => `native entry ${entry}`),
            ...provenance.workerSpawns.map((spawn) => `worker spawn ${spawn.api} ${spawn.target}`),
          ];
    if (notEligible.length > 0) add('provenance-not-strong-eligible', test, notEligible);
    const unresolved = [
      ...(input.facet === null ? ['no facet'] : input.facet.unresolved),
      ...input.inventoryUnresolved,
      ...input.unresolvedSelectors.map((name) => `selector ${name}`),
    ];
    if (unresolved.length > 0) add('unresolved-facet-input', test, unresolved);
    const unsupported = [
      ...input.joinProblems.map((problem) => `join ${problem}`),
      ...input.unsupportedForms.map((form) => `line ${form.line}: ${form.form} (${form.reason})`),
    ];
    if (unsupported.length > 0) add('unsupported-construct', test, unsupported);
    if (input.notOracleValidated) add('not-oracle-validated', test, ['id not validated by gate 3']);
    if (input.excludedFiles.length > 0) add('excluded-file', test, input.excludedFiles);
  }
  if (facts.residual.length > 0) {
    add(
      'unresolved-facet-input',
      [facts.a.input.id, facts.b.input.id],
      [`residual difference: ${facts.residual.join(', ')}`],
    );
  }
  if (facts.rowDeletion.status === 'inconclusive') {
    add('row-deletion-inconclusive', [], facts.rowDeletion.details);
  }
  const isolation = facts.pair.isolation;
  if (isolation === null) add('isolation-not-run', [], ['no isolation result']);
  else if (isolation.status === 'not-run') {
    add('isolation-not-run', [], [isolation.reason ?? 'not-run']);
  }
  if (!facts.pair.identicalBlocks) add('non-identical-blocks', [], ['V8 block sets differ']);
  if (hooked.length > 0) add('hook-stratum', [], hooked);
  return WEAK_DISQUALIFIERS.flatMap((kind) => {
    const entry = found.get(kind);
    return entry === undefined
      ? []
      : [{ kind, tests: sortedUnique(entry.tests), details: sortedUnique(entry.details) }];
  });
}

interface PairContext {
  index: Index;
  tests: Map<string, TestFacts>;
  degraded: readonly DegradedFlag[];
}

function pairFacts(pair: VerdictPairInput, ctx: PairContext): PairFacts {
  const [a, b] = [ctx.tests.get(pair.a), ctx.tests.get(pair.b)];
  const run = mainRun(pair.group);
  const main = lineageOf(ctx.index.observations, run);
  const comparison =
    pair.schedule.status === 'evaluated'
      ? comparePair(ctx.index.observations, run, pair.a, pair.b)
      : null;
  const mainOf = (test: string, mutant: string): ObservationState | undefined =>
    main === undefined ? undefined : stateOf(main, test, mutant);
  const pathDiffers =
    comparison?.universe.filter(
      (mutant) => coverageOf(mainOf(pair.a, mutant)) !== coverageOf(mainOf(pair.b, mutant)),
    ) ?? [];
  const keys = [a.input.checksContext, b.input.checksContext];
  const checksContext =
    keys[0] === null || keys[1] === null ? 'missing' : keys[0] === keys[1] ? 'same' : 'differs';
  const { facet, residual, discarded } = facetRelation(a.input.facet, b.input.facet);
  const rowDeletion = rowDeletionOf(pair.rowDeletion, discarded);
  const repeatStage =
    comparison !== null &&
    a.input.eligible &&
    b.input.eligible &&
    pathDiffers.length === 0 &&
    checksContext === 'same' &&
    facet === 'equal' &&
    comparison.sameKills === true &&
    comparison.killsA.length > 0 &&
    rowDeletion.status !== 'asymmetric';
  const trace: StageResult<TraceStatus> =
    pair.trace === null
      ? { status: 'inconclusive', details: ['trace-not-run'] }
      : { status: pair.trace.status, details: sortedUnique(pair.trace.reasons) };
  const staticRequired = facet === 'equal' && discarded === 'differ';
  const unknownDetails =
    comparison === null || comparison.unknown.length === 0
      ? []
      : [
          `${comparison.unknown.length} mutants without a valid result for both tests`,
          ...sortedUnique(
            comparison.unknown.flatMap((mutant) =>
              [pair.a, pair.b].flatMap((test) => {
                const entry = mainOf(test, mutant);
                return entry === undefined ? ['missing'] : entry.reasons;
              }),
            ),
          ),
        ];
  const otherDetails = (comparison?.otherClasses ?? []).flatMap((mutant) =>
    [pair.a, pair.b].flatMap((test) => {
      const entry = mainOf(test, mutant);
      return entry !== undefined && isOtherClass(entry)
        ? [`${test}: ${entry.outcome} on ${mutant}`]
        : [];
    }),
  );
  const base: Omit<PairFacts, 'disqualifiers'> = {
    pair,
    a,
    b,
    comparison,
    path: comparison === null ? null : pathDiffers.length === 0 ? 'same' : 'differs',
    pathDiffers,
    checksContext,
    facet,
    residual,
    discarded,
    rowDeletion,
    repeatStage,
    trace,
    staticRequired,
    staticFlow: staticRequired
      ? staticFlowOf(pair.staticValueFlow, ctx.degraded)
      : { status: 'not-required', details: [] },
    rerun:
      comparison === null
        ? []
        : rerunDisagreements(
            [pair.a, pair.b],
            [...comparison.universe, ...comparison.unknown],
            ctx.index,
          ),
    unknownDetails,
    otherDetails,
  };
  return {
    ...base,
    disqualifiers: disqualifiersOf(base, hookedMutants(pair, comparison, ctx.index)),
  };
}

// ── Per pair: rules ────────────────────────────────────────────────────────

interface Decision {
  rule: RuleId;
  details: string[];
}

/** One precedence rule: the decision when it applies, else null. */
interface Rule {
  verdict: Verdict;
  decide: (facts: PairFacts) => Decision | null;
}

const when = (holds: boolean, rule: RuleId, details: readonly string[] = []): Decision | null =>
  holds ? { rule, details: sortedUnique(details) } : null;

const testsWhere = (facts: PairFacts, predicate: (side: TestFacts) => boolean): string[] =>
  [facts.a, facts.b].filter(predicate).map((side) => side.input.id);

/** Same path and same checks and context (design §2, the shared stem of Row and Review). */
const sameScenario = (facts: PairFacts): boolean =>
  facts.path === 'same' && facts.checksContext === 'same';

/** Design §2 precedence, KTD12 value-flow gate before the repeat categories. */
const RULES: readonly Rule[] = [
  // Inconclusive.
  {
    verdict: 'inconclusive',
    decide: (f) =>
      when(f.comparison === null, f.pair.schedule.reason ?? 'not-scheduled', [
        ...(f.pair.schedule.detail === null ? [] : [f.pair.schedule.detail]),
      ]),
  },
  {
    verdict: 'inconclusive',
    decide: (f) => {
      const concurrent = testsWhere(f, (side) => side.input.concurrent);
      return when(f.pair.pathUnattributable || concurrent.length > 0, 'path-unattributable', [
        ...concurrent.map((test) => `${test} ran concurrently`),
        ...(f.pair.pathUnattributable ? ['path unattributable'] : []),
      ]);
    },
  },
  {
    verdict: 'inconclusive',
    decide: (f) => when(f.unknownDetails.length > 0, 'kills-unknown', f.unknownDetails),
  },
  {
    verdict: 'inconclusive',
    decide: (f) => when(f.otherDetails.length > 0, 'non-assertion-outcome', f.otherDetails),
  },
  {
    verdict: 'inconclusive',
    decide: (f) =>
      when(f.pair.isolation?.status === 'disagrees', 'isolation-disagrees', [
        f.pair.isolation?.reason ?? 'disagrees',
      ]),
  },
  {
    verdict: 'inconclusive',
    decide: (f) =>
      when(f.pair.isolation?.status === 'unknown', 'isolation-unknown', [
        f.pair.isolation?.reason ?? 'unknown',
      ]),
  },
  { verdict: 'inconclusive', decide: (f) => when(f.rerun.length > 0, 'rerun-disagrees', f.rerun) },
  {
    verdict: 'inconclusive',
    decide: (f) => {
      const members = [f.a, f.b].filter((side) => side.status === 'inconclusive');
      return when(
        members.length > 0,
        'member-inconclusive',
        members.map((side) => `${side.input.id}: ${side.reasons.join('; ')}`),
      );
    },
  },
  {
    verdict: 'inconclusive',
    decide: (f) =>
      when(
        f.repeatStage && f.trace.status === 'inconclusive',
        'trace-inconclusive',
        f.trace.details,
      ),
  },
  // Out of scope.
  {
    verdict: 'out-of-scope',
    decide: (f) => {
      const tests = testsWhere(f, (side) => !side.input.eligible);
      return when(tests.length > 0, 'not-eligible', tests);
    },
  },
  {
    verdict: 'out-of-scope',
    decide: (f) => {
      const tests = testsWhere(f, (side) => side.status === 'out-of-scope');
      return when(tests.length > 0, 'covers-no-evaluated-mutant', tests);
    },
  },
  // Weak: an empty kill set is never part of a repeat.
  {
    verdict: 'weak',
    decide: (f) => {
      const empty = [
        ...testsWhere(f, (side) => side.status === 'weak'),
        ...(f.comparison?.killsA.length === 0 ? [f.pair.a] : []),
        ...(f.comparison?.killsB.length === 0 ? [f.pair.b] : []),
      ];
      return when(empty.length > 0, 'kills-nothing', empty);
    },
  },
  // Value-flow gate (KTD12): Review, never a repeat.
  {
    verdict: 'review',
    decide: (f) => {
      const trace = f.trace.status === 'veto';
      const staticVeto = f.staticRequired && f.staticFlow.status === 'veto';
      return when(f.repeatStage && (trace || staticVeto), 'value-flow-veto', [
        ...(trace ? [`trace: ${f.trace.details.join(', ')}`] : []),
        ...(staticVeto ? [`static: ${f.staticFlow.details.join(', ')}`] : []),
      ]);
    },
  },
  {
    verdict: 'review',
    decide: (f) =>
      when(
        f.repeatStage && f.staticRequired && f.staticFlow.status === 'unknown',
        'value-flow-unknown',
        [`static: ${f.staticFlow.details.join(', ')}`],
      ),
  },
  // Repeat.
  {
    verdict: 'repeat-strong',
    decide: (f) => when(f.repeatStage && f.disqualifiers.length === 0, 'all-strong-conditions'),
  },
  {
    verdict: 'repeat-weak',
    decide: (f) =>
      when(
        f.repeatStage,
        'weak-disqualifier',
        f.disqualifiers.map((entry) => entry.kind),
      ),
  },
  // Row.
  {
    verdict: 'row',
    decide: (f) => {
      const differ = sameScenario(f) && f.facet === 'equal' && f.comparison?.sameKills === false;
      const symmetric = f.comparison === null ? [] : symmetricDifference(f.comparison);
      return when(differ, 'kills-differ', [`${symmetric.length} mutants killed by one test only`]);
    },
  },
  {
    verdict: 'row',
    decide: (f) =>
      when(
        sameScenario(f) &&
          f.facet === 'equal' &&
          f.comparison?.sameKills === true &&
          f.rowDeletion.status === 'asymmetric',
        'row-deletion-asymmetric',
        f.rowDeletion.details,
      ),
  },
  // Review.
  {
    verdict: 'review',
    decide: (f) =>
      when(
        sameScenario(f) && f.facet === 'residual' && f.comparison?.sameKills === true,
        'residual-difference',
        f.residual,
      ),
  },
  {
    verdict: 'review',
    decide: (f) =>
      when(
        sameScenario(f) && f.facet === 'differs' && f.comparison?.sameKills === true,
        'facet-differs-same-kills',
      ),
  },
  {
    verdict: 'review',
    decide: (f) =>
      when(
        sameScenario(f) && f.facet === 'missing' && f.comparison?.sameKills === true,
        'facet-missing-same-kills',
        testsWhere(f, (side) => side.input.facet === null),
      ),
  },
  // Distinct.
  {
    verdict: 'distinct',
    decide: (f) =>
      when(f.path === 'differs', 'path-differs', [
        `${f.pathDiffers.length} mutants covered differently`,
      ]),
  },
  {
    verdict: 'distinct',
    decide: (f) =>
      when(
        f.checksContext === 'missing',
        'checks-context-missing',
        testsWhere(f, (side) => side.input.checksContext === null),
      ),
  },
  {
    verdict: 'distinct',
    decide: (f) => when(f.checksContext === 'differs', 'checks-context-differs'),
  },
  {
    verdict: 'distinct',
    decide: (f) =>
      when(f.facet !== 'equal' && f.comparison?.sameKills === false, 'facet-differs-kills-differ', [
        `facet ${f.facet}`,
      ]),
  },
  { verdict: 'distinct', decide: () => when(true, 'anything-else') },
];

function symmetricDifference(comparison: PairComparison): string[] {
  const [a, b] = [new Set(comparison.killsA), new Set(comparison.killsB)];
  return sortedUnique([
    ...comparison.killsA.filter((mutant) => !b.has(mutant)),
    ...comparison.killsB.filter((mutant) => !a.has(mutant)),
  ]);
}

function evidenceOf(facts: PairFacts): PairEvidence {
  const { comparison, pair } = facts;
  return {
    schedule: pair.schedule.status,
    universeId: comparison?.universeId ?? null,
    universe: comparison?.universe.length ?? 0,
    unknown: comparison?.unknown.length ?? 0,
    killsA: comparison?.killsA.length ?? 0,
    killsB: comparison?.killsB.length ?? 0,
    otherClasses: comparison?.otherClasses.length ?? 0,
    path: facts.path,
    checksContext: facts.checksContext,
    facet: facts.facet,
    discardedValues: facts.discarded,
    killSets:
      comparison?.sameKills === true
        ? 'equal'
        : comparison?.sameKills === false
          ? 'differ'
          : 'unknown',
    rowDeletion: pair.rowDeletion?.outcome ?? 'not-run',
    trace: pair.trace?.status ?? 'not-run',
    staticValueFlow: pair.staticValueFlow?.status ?? 'not-run',
    isolation: pair.isolation?.status ?? 'not-run',
  };
}

function judge(facts: PairFacts): PairVerdict {
  const decisions = RULES.map((rule) => ({ verdict: rule.verdict, decision: rule.decide(facts) }));
  const decided = decisions.find((entry) => entry.decision !== null);
  const { pair } = facts;
  return {
    a: pair.a,
    b: pair.b,
    group: pair.group,
    verdict: decided.verdict,
    rule: decided.decision.rule,
    details: decided.decision.details,
    inconclusive: decisions.flatMap((entry) =>
      entry.verdict === 'inconclusive' && entry.decision !== null
        ? [entry.decision.rule as InconclusiveRule]
        : [],
    ),
    disqualifiers: facts.disqualifiers,
    keep: [facts.a, facts.b].flatMap(({ input }) =>
      input.dupeOk === null ? [] : [{ test: input.id, reason: input.dupeOk }],
    ),
    evidence: evidenceOf(facts),
  };
}

// ── Gaps ───────────────────────────────────────────────────────────────────

function gapsOf(index: Index): FileGaps[] {
  const files = new Map<string, FileGaps>();
  const lineagesOf = new Map<string, LineageObservations[]>();
  for (const view of index.observations.lineages.values()) {
    for (const mutant of view.mutants) push(lineagesOf, mutant, view);
  }
  for (const mutant of [...lineagesOf.keys()].sort(byText)) {
    const entries = index.explicitByMutant.get(mutant) ?? [];
    const implied = (lineagesOf.get(mutant) ?? []).flatMap((view) => impliedStatesOf(view, mutant));
    const file = entries[0]?.file ?? implied[0].file;
    const gaps = files.get(file) ?? {
      file,
      mutants: 0,
      killed: 0,
      survived: [],
      uncovered: [],
      inconclusive: [],
    };
    files.set(file, gaps);
    gaps.mutants += 1;
    if (entries.some(isKill)) gaps.killed += 1;
    else if (
      entries.some((entry) => isUnknown(entry) || isOtherClass(entry)) ||
      implied.some(isUnknown)
    ) {
      gaps.inconclusive.push(mutant);
    } else if (entries.some(exposed)) gaps.survived.push(mutant);
    else gaps.uncovered.push(mutant);
  }
  return [...files.values()].sort((x, y) => byText(x.file, y.file));
}

// ── Entry point ────────────────────────────────────────────────────────────

/** Orients a pair with the smaller test id first. */
const oriented = (pair: VerdictPairInput): VerdictPairInput =>
  pair.a <= pair.b ? pair : { ...pair, a: pair.b, b: pair.a };

const pairOrder = (x: VerdictPairInput, y: VerdictPairInput): number =>
  byText(JSON.stringify([x.a, x.b, x.group]), JSON.stringify([y.a, y.b, y.group]));

/** The verdict report of one run; pure. See the module comment. */
export function computeVerdicts(input: VerdictInput): VerdictReport {
  const inputs = new Map(input.tests.map((test) => [test.id, test]));
  const pairs = input.pairs.map(oriented).sort(pairOrder);
  const missing = sortedUnique(
    pairs.flatMap((pair) => [pair.a, pair.b]).filter((test) => !inputs.has(test)),
  );
  if (missing.length > 0) {
    throw new Error(`computeVerdicts: no test input for ${missing.join(', ')}`);
  }
  const evaluatedPairs = pairs.filter((pair) => pair.schedule.status === 'evaluated');
  const trusted = new Set(evaluatedPairs.map((pair) => pair.group));
  const evaluated = new Set(evaluatedPairs.flatMap((pair) => [pair.a, pair.b]));
  const index = buildIndex(input.observations, trusted);
  const ids = [...inputs.keys()].sort(byText);
  // Only explicit observations decide a test's status: an implied one is never exposed.
  const tests = new Map(
    ids.map((id) => [
      id,
      classifyTest(inputs.get(id), index.explicitByTest.get(id), evaluated.has(id)),
    ]),
  );
  const killers = killersIndex(index);
  const eligible = new Set(ids.filter((id) => inputs.get(id).eligible));
  const testResults = ids.map((id): TestResult => {
    const facts = tests.get(id);
    const subsumption = subsumptionOf(facts, index, killers, eligible);
    return {
      id,
      status: facts.status,
      reasons: facts.reasons,
      covered: facts.covered,
      kills: facts.kills,
      subsumption,
      statements: [
        ...(facts.status === 'weak' ? [WORDING.weak] : []),
        ...(subsumption.status === 'subsumed' ? [WORDING.subsumed] : []),
      ],
    };
  });
  const ctx: PairContext = { index, tests, degraded: input.valueFlowDegraded };
  const verdicts = pairs.map((pair) => judge(pairFacts(pair, ctx)));
  return {
    engineVersion: VERDICT_ENGINE_VERSION,
    pairs: verdicts.filter((verdict) => verdict.keep.length === 0),
    kept: verdicts.filter((verdict) => verdict.keep.length > 0),
    tests: testResults,
    gaps: gapsOf(index),
  };
}
