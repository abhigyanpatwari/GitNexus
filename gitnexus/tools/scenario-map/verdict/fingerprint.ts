/**
 * Scenario fingerprint verdicts of the scenario map (docs/plans/2026-10-25-1700-feat-scenario-
 * fingerprint-plan.md): two tests are duplicates when they run the same execution path on the
 * same input data and check the same expectation. No mutation run is needed; the mutation verdict
 * engine (./verdict.ts) stays optional evidence.
 *
 * The three parts of a test's fingerprint, all from stage artifacts:
 *   path         its V8 block set (Layer 1, `CandidatePair.identicalBlocks`); a concurrent test's
 *                path is unattributable, and a test whose provenance is unknown or reaches native
 *                code or a worker has a path V8 does not fully show;
 *   input        its input facet (Layer 2: the call shape with local names abstracted) and the
 *                discarded values (every literal, row value and resolved constant), compared with
 *                the residual-difference guard (D1, ./verdict.ts `facetRelation`), and the trace
 *                run's comparison of the values reaching opaque built-ins at runtime (U11);
 *   expectation  its checks-and-context key (U5: matchers, selectors, mocks and environment); the
 *                expected values are part of the discarded values.
 *
 * Per pair, the first rule that holds ({@link FINGERPRINT_RULES}):
 *   out-of-scope        a test outside the eligible category;
 *   inconclusive        a test ran concurrently (`path-unattributable`);
 *   distinct            the block sets differ (`path-differs`);
 *   different-checks    same path and the same, resolved input with a clean trace, other checks;
 *   distinct            other checks otherwise (`checks-differ`), or another call shape;
 *   table-row           same shape, other values (`input-values-differ`), or equal static values
 *                       that differ at runtime (`runtime-values-differ`, a trace veto);
 *   possible-duplicate  nothing known differs, but a checks key or facet is missing, an input is
 *                       unresolved (a facet, inventory or selector input, a residual difference,
 *                       an unsupported assertion or join, a path V8 does not fully show), or the
 *                       trace is not clean;
 *   duplicate           same path, input and expectation, every input resolved, trace clean.
 * Different input data is never a duplicate (decision F5); anything the extraction cannot see
 * holds a pair at possible-duplicate (F6, fail-closed). A `// dupe-ok:` reason on either test moves
 * the pair to `kept`.
 *
 * Pure: plain data in, plain data out, sorted, so a rerun on the same input is byte-identical.
 */
import { byText, sortedUnique } from '../util.js';
import { facetRelation, type VerdictPairInput, type VerdictTestInput } from './verdict.js';

/** Folded into the report: a rule change resurfaces every pair it reclassifies. */
export const FINGERPRINT_ENGINE_VERSION = 1;

export type FingerprintVerdict =
  | 'duplicate'
  | 'possible-duplicate'
  | 'table-row'
  | 'different-checks'
  | 'distinct'
  | 'inconclusive'
  | 'out-of-scope';

/** Report order, the actionable verdicts first. */
export const FINGERPRINT_VERDICTS: readonly FingerprintVerdict[] = [
  'duplicate',
  'possible-duplicate',
  'different-checks',
  'table-row',
  'distinct',
  'inconclusive',
  'out-of-scope',
];

export type FingerprintRule =
  | 'not-eligible'
  | 'path-unattributable'
  | 'path-differs'
  | 'same-input-different-checks'
  | 'checks-differ'
  | 'input-shape-differs'
  | 'input-values-differ'
  | 'runtime-values-differ'
  | 'checks-unknown'
  | 'facet-unknown'
  | 'input-unresolved'
  | 'trace-unknown'
  | 'same-path-input-expectation';

export interface FingerprintEvidence {
  path: 'same' | 'differs';
  checks: 'same' | 'differs' | 'missing';
  facet: 'equal' | 'differs' | 'residual' | 'missing';
  /** Null unless the facet fingerprints are equal. */
  values: 'equal' | 'differ' | null;
  trace: 'clean' | 'veto' | 'inconclusive' | 'not-run';
  /** What a test's extraction could not resolve, `<test>: <item>`, sorted. */
  unresolved: string[];
}

export interface FingerprintPair {
  a: string;
  b: string;
  group: string;
  verdict: FingerprintVerdict;
  rule: FingerprintRule;
  /** What the deciding rule saw, sorted and distinct. */
  details: string[];
  evidence: FingerprintEvidence;
  /** `// dupe-ok:` reasons; non-empty exactly for the kept pairs. */
  keep: { test: string; reason: string }[];
}

export interface FingerprintReport {
  engineVersion: number;
  /** Sorted by a, b, group. */
  pairs: FingerprintPair[];
  /** Pairs with a `dupe-ok` keep, same order. */
  kept: FingerprintPair[];
}

export type FingerprintTestInput = Pick<
  VerdictTestInput,
  | 'id'
  | 'eligible'
  | 'dupeOk'
  | 'joinProblems'
  | 'inventoryUnresolved'
  | 'provenance'
  | 'concurrent'
  | 'checksContext'
  | 'unsupportedForms'
  | 'unresolvedSelectors'
  | 'facet'
>;

export type FingerprintPairInput = Pick<
  VerdictPairInput,
  'a' | 'b' | 'group' | 'identicalBlocks' | 'pathUnattributable' | 'trace'
>;

/** What a test's extraction could not resolve; empty when everything is resolved. */
function unresolvedOf(test: FingerprintTestInput): string[] {
  const provenance = test.provenance;
  return [
    ...(test.facet?.unresolved ?? []).map((item) => `input ${item}`),
    ...test.inventoryUnresolved.map((item) => `inventory ${item}`),
    ...test.unresolvedSelectors.map((name) => `selector ${name}`),
    ...test.joinProblems.map((problem) => `join ${problem}`),
    ...test.unsupportedForms.map((form) => `assertion ${form.form} (${form.reason})`),
    ...(provenance === null
      ? ['path: no provenance record']
      : [
          ...(provenance.known ? [] : ['path: unknown provenance']),
          ...provenance.nativeEntries.map((entry) => `path: native entry ${entry}`),
          ...provenance.workerSpawns.map((spawn) => `path: worker ${spawn.api} ${spawn.target}`),
        ]),
  ].map((item) => `${test.id}: ${item}`);
}

interface Facts {
  pair: FingerprintPairInput;
  a: FingerprintTestInput;
  b: FingerprintTestInput;
  evidence: FingerprintEvidence;
  /** Same input as far as the extraction sees: equal facet and values, nothing unresolved. */
  sameInput: boolean;
}

interface Rule {
  verdict: FingerprintVerdict;
  decide: (facts: Facts) => { rule: FingerprintRule; details: string[] } | null;
}

const when = (
  holds: boolean,
  rule: FingerprintRule,
  details: readonly string[] = [],
): { rule: FingerprintRule; details: string[] } | null =>
  holds ? { rule, details: sortedUnique(details) } : null;

/** The fingerprint rules in precedence order; see the module comment. */
export const FINGERPRINT_RULES: readonly Rule[] = [
  {
    verdict: 'out-of-scope',
    decide: (f) =>
      when(
        !f.a.eligible || !f.b.eligible,
        'not-eligible',
        [f.a, f.b].filter((side) => !side.eligible).map((side) => side.id),
      ),
  },
  {
    verdict: 'inconclusive',
    decide: (f) =>
      when(f.pair.pathUnattributable || f.a.concurrent || f.b.concurrent, 'path-unattributable', [
        ...[f.a, f.b]
          .filter((side) => side.concurrent)
          .map((side) => `${side.id} ran concurrently`),
        ...(f.pair.pathUnattributable ? ['path unattributable'] : []),
      ]),
  },
  {
    verdict: 'distinct',
    decide: (f) => when(f.evidence.path === 'differs', 'path-differs', ['V8 block sets differ']),
  },
  {
    verdict: 'different-checks',
    decide: (f) =>
      when(
        f.evidence.checks === 'differs' && f.sameInput && f.evidence.trace === 'clean',
        'same-input-different-checks',
      ),
  },
  {
    verdict: 'distinct',
    decide: (f) => when(f.evidence.checks === 'differs', 'checks-differ'),
  },
  {
    verdict: 'distinct',
    decide: (f) => when(f.evidence.facet === 'differs', 'input-shape-differs'),
  },
  {
    verdict: 'table-row',
    decide: (f) => when(f.evidence.values === 'differ', 'input-values-differ'),
  },
  {
    verdict: 'table-row',
    decide: (f) =>
      when(
        f.evidence.trace === 'veto' && f.evidence.values === 'equal',
        'runtime-values-differ',
        f.pair.trace?.reasons ?? [],
      ),
  },
  {
    verdict: 'possible-duplicate',
    decide: (f) =>
      when(
        f.evidence.checks === 'missing',
        'checks-unknown',
        [f.a, f.b].filter((side) => side.checksContext === null).map((side) => side.id),
      ),
  },
  {
    verdict: 'possible-duplicate',
    decide: (f) =>
      when(
        f.evidence.facet === 'missing',
        'facet-unknown',
        [f.a, f.b].filter((side) => side.facet === null).map((side) => side.id),
      ),
  },
  {
    verdict: 'possible-duplicate',
    decide: (f) =>
      when(
        f.evidence.unresolved.length > 0 || f.evidence.facet === 'residual',
        'input-unresolved',
        [
          ...f.evidence.unresolved,
          ...(f.evidence.facet === 'residual' ? ['residual body difference'] : []),
        ],
      ),
  },
  {
    verdict: 'possible-duplicate',
    decide: (f) =>
      when(f.evidence.trace !== 'clean', 'trace-unknown', [
        `trace ${f.evidence.trace}`,
        ...(f.pair.trace?.reasons ?? []),
      ]),
  },
  { verdict: 'duplicate', decide: () => when(true, 'same-path-input-expectation') },
];

function factsOf(
  pair: FingerprintPairInput,
  a: FingerprintTestInput,
  b: FingerprintTestInput,
): Facts {
  const relation = facetRelation(a.facet, b.facet);
  const keys = [a.checksContext, b.checksContext];
  const unresolved = sortedUnique([...unresolvedOf(a), ...unresolvedOf(b)]);
  const evidence: FingerprintEvidence = {
    path: pair.identicalBlocks ? 'same' : 'differs',
    checks:
      keys[0] === null || keys[1] === null ? 'missing' : keys[0] === keys[1] ? 'same' : 'differs',
    facet: relation.facet,
    values: relation.discarded,
    trace: pair.trace?.status ?? 'not-run',
    unresolved,
  };
  return {
    pair,
    a,
    b,
    evidence,
    sameInput:
      relation.facet === 'equal' && relation.discarded === 'equal' && unresolved.length === 0,
  };
}

/** Orients a pair with the smaller test id first. */
const oriented = (pair: FingerprintPairInput): FingerprintPairInput =>
  pair.a <= pair.b ? pair : { ...pair, a: pair.b, b: pair.a };

/** The fingerprint verdicts of every candidate pair; pure. See the module comment. */
export function computeFingerprints(input: {
  tests: readonly FingerprintTestInput[];
  pairs: readonly FingerprintPairInput[];
}): FingerprintReport {
  const tests = new Map(input.tests.map((test) => [test.id, test]));
  const missing = sortedUnique(
    input.pairs.flatMap((pair) => [pair.a, pair.b]).filter((test) => !tests.has(test)),
  );
  if (missing.length > 0) {
    throw new Error(`computeFingerprints: no test input for ${missing.join(', ')}`);
  }
  const judged = input.pairs
    .map(oriented)
    .map((pair) => ({ pair, order: JSON.stringify([pair.a, pair.b, pair.group]) }))
    .sort((x, y) => byText(x.order, y.order))
    .map(({ pair }): FingerprintPair => {
      const [a, b] = [tests.get(pair.a), tests.get(pair.b)];
      const facts = factsOf(pair, a, b);
      const [decided] = FINGERPRINT_RULES.flatMap((rule) => {
        const decision = rule.decide(facts);
        return decision === null ? [] : [{ verdict: rule.verdict, ...decision }];
      });
      return {
        a: pair.a,
        b: pair.b,
        group: pair.group,
        verdict: decided.verdict,
        rule: decided.rule,
        details: decided.details,
        evidence: facts.evidence,
        keep: [a, b].flatMap((side) =>
          side.dupeOk === null ? [] : [{ test: side.id, reason: side.dupeOk }],
        ),
      };
    });
  return {
    engineVersion: FINGERPRINT_ENGINE_VERSION,
    pairs: judged.filter((pair) => pair.keep.length === 0),
    kept: judged.filter((pair) => pair.keep.length > 0),
  };
}
