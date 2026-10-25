/**
 * Locks the verdict engine (U12, R10, R11, R15, KTD5, KTD8, KTD9, KTD12, design §2, §5.4, §5.6)
 * on in-memory inputs. The base world is the D2 positive control, `add(2, 3)` against
 * `add(5, 5)`: identical path, checks, context and facet (the values are discarded and differ),
 * identical non-empty kill sets, clean value flow and trace, an agreeing isolation pass and no
 * weak disqualifier, so it is a strong repeat. Each case edits one input and checks the deciding
 * rule (one case per precedence rule and per weak disqualifier), and the per-test Weak,
 * Inconclusive and Subsumed properties, the per-file gaps, the dupe-ok keep list and determinism.
 */
import { describe, expect, it } from 'vitest';
import type { InputFacet } from '../../../tools/scenario-map/facet/input-facet.js';
import type {
  MergedObservation,
  RunUniverse,
} from '../../../tools/scenario-map/mutation/observations.js';
import type { DegradedFlag } from '../../../tools/scenario-map/value-flow/pdg-walk.js';
import {
  VERDICT_ENGINE_VERSION,
  WORDING,
  computeVerdicts,
  type PairVerdict,
  type RuleId,
  type Verdict,
  type VerdictInput,
  type VerdictPairInput,
  type VerdictTestInput,
  type WeakDisqualifier,
} from '../../../tools/scenario-map/verdict/verdict.js';

const A = 'test/unit/add.test.ts#add > adds 2 and 3';
const B = 'test/unit/add.test.ts#add > adds 5 and 5';
const C = 'test/unit/add.test.ts#add > adds 4 and 6';
const D = 'test/unit/add.test.ts#add > adds 1 and 9';
const FILE = 'gitnexus/src/add.ts';
const mutantId = (span: string, mutator: string): string =>
  `${FILE}@0123456789abcdef:${span}:${mutator}:aaaaaaaaaaaaaaaa`;
/** Killed by both tests. */
const M1 = mutantId('2:10-2:15', 'ArithmeticOperator');
/** Covered by both tests, survived by both. */
const M2 = mutantId('3:7-3:16', 'ConditionalExpression');
/** Covered by neither test. */
const M3 = mutantId('6:1-8:2', 'BlockStatement');
/** A static mutant: no coverage, every test runs against it. */
const M4 = mutantId('1:14-1:15', 'NumericLiteral');

// ── Builders ───────────────────────────────────────────────────────────────

const observation = (
  test: string,
  mutant: string,
  overrides: Partial<MergedObservation> = {},
): MergedObservation => ({
  group: 'g1',
  kind: 'main',
  lineage: 'main',
  test,
  mutant,
  file: FILE,
  covered: true,
  hookAttributed: false,
  static: false,
  outcome: 'killed-by-test:assertion',
  attempts: [0],
  shards: [0],
  sources: ['row'],
  valid: true,
  reasons: [],
  ...overrides,
});

const SURVIVED: Partial<MergedObservation> = { outcome: 'survived' };
const UNCOVERED: Partial<MergedObservation> = {
  covered: false,
  outcome: 'survived',
  attempts: [],
  sources: ['not-covered'],
};
const MISSING: Partial<MergedObservation> = {
  outcome: null,
  attempts: [],
  sources: ['no-row'],
  valid: false,
  reasons: ['missing-result'],
};

/** The main run of `group`: each test kills M1, survives M2 and does not cover M3. */
const mainRun = (tests: readonly string[], group = 'g1'): MergedObservation[] =>
  tests.flatMap((test) => [
    observation(test, M1, { group }),
    observation(test, M2, { group, ...SURVIVED }),
    observation(test, M3, { group, ...UNCOVERED }),
  ]);

type ObservationEdit = (entries: MergedObservation[]) => MergedObservation[];

/** Changes the observations of `test` on `mutant` (every lineage). */
const change =
  (test: string, mutant: string, overrides: Partial<MergedObservation>): ObservationEdit =>
  (entries) =>
    entries.map((entry) =>
      entry.test === test && entry.mutant === mutant ? { ...entry, ...overrides } : entry,
    );

const add =
  (...extra: MergedObservation[]): ObservationEdit =>
  (entries) => [...entries, ...extra];

const chain =
  (...edits: ObservationEdit[]): ObservationEdit =>
  (entries) =>
    edits.reduce((current, edit) => edit(current), entries);

const SKELETON = ['body.0\tcall add', 'body.0.args.0\t<slot>', 'body.0.args.1\t<slot>'];

const facet = (values: readonly string[], overrides: Partial<InputFacet> = {}): InputFacet => ({
  fingerprint: 'facet-add',
  parts: {
    language: '-',
    source: [],
    fixtures: [],
    data: [],
    calls: ['add'],
    order: ['<number>', '<number>'],
  },
  discarded: values.map((value, position) => ({
    position,
    kind: 'number',
    value,
    location: { file: 'gitnexus/test/unit/add.test.ts', line: 3, column: 10 + position * 3 },
    origin: 'literal',
  })),
  unresolved: [],
  skeleton: SKELETON,
  ...overrides,
});

const testInput = (id: string, overrides: Partial<VerdictTestInput> = {}): VerdictTestInput => ({
  id,
  eligible: true,
  notOracleValidated: false,
  dupeOk: null,
  joinProblems: [],
  inventoryUnresolved: [],
  provenance: { known: true, nativeEntries: [], workerSpawns: [] },
  concurrent: false,
  excludedFiles: [],
  checksContext: 'checks-add',
  unsupportedForms: [],
  unresolvedSelectors: [],
  facet: facet(['2', '3']),
  ...overrides,
});

const pairInput = (overrides: Partial<VerdictPairInput> = {}): VerdictPairInput => ({
  a: A,
  b: B,
  group: 'g1',
  identicalBlocks: true,
  pathUnattributable: false,
  schedule: { status: 'evaluated', reason: null, detail: null },
  isolation: { status: 'agrees', reason: null, disqualifiers: [] },
  rowDeletion: { outcome: 'not-applicable', reasons: ['no-common-table'] },
  staticValueFlow: { status: 'clean', reasons: [] },
  trace: { status: 'clean', reasons: [] },
  ...overrides,
});

interface WorldEdit {
  a?: Partial<VerdictTestInput>;
  b?: Partial<VerdictTestInput>;
  pair?: Partial<VerdictPairInput>;
  observations?: ObservationEdit;
  degraded?: DegradedFlag[];
}

/** The positive control, `add(2, 3)` against `add(5, 5)`, with `edit` applied. */
const world = (edit: WorldEdit = {}): VerdictInput => ({
  tests: [
    testInput(A, { facet: facet(['2', '3']), ...edit.a }),
    testInput(B, { facet: facet(['5', '5']), ...edit.b }),
  ],
  pairs: [pairInput(edit.pair)],
  observations: {
    explicit: (edit.observations ?? ((entries) => entries))(mainRun([A, B])),
    universes: [],
  },
  valueFlowDegraded: edit.degraded ?? [],
});

const verdictOf = (edit: WorldEdit = {}): PairVerdict => computeVerdicts(world(edit)).pairs[0];
const kindsOf = (verdict: PairVerdict): WeakDisqualifier[] =>
  verdict.disqualifiers.map((entry) => entry.kind);
const testOf = (input: VerdictInput, id: string) =>
  computeVerdicts(input).tests.find((entry) => entry.id === id);

const SAME_VALUES: Partial<VerdictTestInput> = { facet: facet(['2', '3']) };
const RESIDUAL_FACET = facet(['5', '5'], { skeleton: [...SKELETON, 'body.1\tCallable'] });
const OTHER_FACET = facet(['5', '5'], { fingerprint: 'facet-other' });

// ── The positive control and its strong conditions ─────────────────────────

describe('positive control add(2, 3) against add(5, 5)', () => {
  it('is a strong repeat when every strong condition holds', () => {
    const verdict = verdictOf();
    expect(verdict).toMatchObject({
      a: A,
      b: B,
      verdict: 'repeat-strong',
      rule: 'all-strong-conditions',
      inconclusive: [],
      disqualifiers: [],
      keep: [],
    });
    expect(verdict.evidence).toMatchObject({
      schedule: 'evaluated',
      universe: 3,
      unknown: 0,
      killsA: 1,
      killsB: 1,
      path: 'same',
      checksContext: 'same',
      facet: 'equal',
      discardedValues: 'differ',
      killSets: 'equal',
      rowDeletion: 'not-applicable',
      trace: 'clean',
      staticValueFlow: 'clean',
      isolation: 'agrees',
    });
  });

  it('is a weak repeat with isolation-not-run when the isolation pass did not run', () => {
    const verdict = verdictOf({ pair: { isolation: null } });
    expect(verdict.verdict).toBe('repeat-weak');
    expect(verdict.rule).toBe('weak-disqualifier');
    expect(verdict.disqualifiers).toEqual([
      { kind: 'isolation-not-run', tests: [], details: ['no isolation result'] },
    ]);
  });

  it('needs no static value-flow check when the discarded values are equal', () => {
    const verdict = verdictOf({ b: SAME_VALUES, pair: { staticValueFlow: null } });
    expect([verdict.verdict, verdict.rule]).toEqual(['repeat-strong', 'all-strong-conditions']);
    expect(verdict.evidence.discardedValues).toBe('equal');
    expect(verdict.evidence.staticValueFlow).toBe('not-run');
  });

  it('sends equal discarded values with a trace veto (asymmetric sites) to Review', () => {
    const verdict = verdictOf({
      b: SAME_VALUES,
      pair: { staticValueFlow: null, trace: { status: 'veto', reasons: ['asymmetric-sites'] } },
    });
    expect([verdict.verdict, verdict.rule]).toEqual(['review', 'value-flow-veto']);
    expect(verdict.details).toEqual(['trace: asymmetric-sites']);
  });

  it('never makes a repeat of a value-flow veto, whatever the disqualifiers (KTD12)', () => {
    const verdict = verdictOf({
      a: { excludedFiles: ['gitnexus/tools/x.ts'] },
      pair: { isolation: null, staticValueFlow: { status: 'veto', reasons: ['opaque: parseInt'] } },
    });
    expect([verdict.verdict, verdict.rule]).toEqual(['review', 'value-flow-veto']);
    expect(kindsOf(verdict)).toEqual(['isolation-not-run', 'excluded-file']);
  });

  it.each([
    {
      label: 'no PDG layer vetoes a clean pair',
      degraded: ['no-pdg-layer'] as DegradedFlag[],
      rule: 'value-flow-veto',
      details: ['static: no-pdg-layer'],
    },
    {
      label: 'a checker version mismatch makes it unknown',
      degraded: ['checker-version'] as DegradedFlag[],
      rule: 'value-flow-unknown',
      details: ['static: checker-version'],
    },
  ])('degraded value flow: $label', ({ degraded, rule, details }) => {
    const verdict = verdictOf({ degraded });
    expect([verdict.verdict, verdict.rule, verdict.details]).toEqual(['review', rule, details]);
  });

  it('ignores a degraded value-flow run when the discarded values are equal', () => {
    const verdict = verdictOf({ b: SAME_VALUES, degraded: ['no-pdg-layer'] });
    expect(verdict.verdict).toBe('repeat-strong');
  });

  it('reads a missing static check of differing values as unknown', () => {
    const verdict = verdictOf({ pair: { staticValueFlow: null } });
    expect([verdict.verdict, verdict.rule, verdict.details]).toEqual([
      'review',
      'value-flow-unknown',
      ['static: not-run'],
    ]);
  });

  it('reads a missing trace on the repeat path as Inconclusive', () => {
    const verdict = verdictOf({ pair: { trace: null } });
    expect([verdict.verdict, verdict.rule, verdict.details]).toEqual([
      'inconclusive',
      'trace-inconclusive',
      ['trace-not-run'],
    ]);
  });

  it('ignores the trace and the static check of a pair that is a Row', () => {
    const verdict = verdictOf({
      pair: {
        rowDeletion: { outcome: 'asymmetric', reasons: [] },
        trace: { status: 'inconclusive', reasons: ['trace-overflow'] },
        staticValueFlow: { status: 'veto', reasons: ['opaque: Math.round'] },
      },
    });
    expect([verdict.verdict, verdict.rule]).toEqual(['row', 'row-deletion-asymmetric']);
  });
});

// ── One case per precedence rule ───────────────────────────────────────────

const RULE_CASES: { rule: RuleId; verdict: Verdict; edit: WorldEdit }[] = [
  {
    rule: 'not-scheduled',
    verdict: 'inconclusive',
    edit: { pair: { schedule: { status: 'inconclusive', reason: 'not-scheduled', detail: null } } },
  },
  {
    rule: 'group-over-budget',
    verdict: 'inconclusive',
    edit: {
      pair: { schedule: { status: 'inconclusive', reason: 'group-over-budget', detail: null } },
    },
  },
  {
    rule: 'manifest-mismatch',
    verdict: 'inconclusive',
    edit: {
      pair: {
        schedule: { status: 'inconclusive', reason: 'manifest-mismatch', detail: 'digest x' },
      },
    },
  },
  { rule: 'path-unattributable', verdict: 'inconclusive', edit: { a: { concurrent: true } } },
  {
    rule: 'kills-unknown',
    verdict: 'inconclusive',
    edit: { observations: change(B, M2, MISSING) },
  },
  {
    rule: 'non-assertion-outcome',
    verdict: 'inconclusive',
    edit: { observations: change(B, M2, { outcome: 'timeout' }) },
  },
  {
    rule: 'isolation-disagrees',
    verdict: 'inconclusive',
    edit: {
      pair: {
        isolation: { status: 'disagrees', reason: 'isolation-disagrees', disqualifiers: [] },
      },
    },
  },
  {
    rule: 'isolation-unknown',
    verdict: 'inconclusive',
    edit: {
      pair: { isolation: { status: 'unknown', reason: 'isolation-unknown', disqualifiers: [] } },
    },
  },
  {
    rule: 'rerun-disagrees',
    verdict: 'inconclusive',
    edit: { observations: add(observation(A, M2, { kind: 'alone', lineage: A })) },
  },
  {
    rule: 'member-inconclusive',
    verdict: 'inconclusive',
    edit: {
      observations: chain(
        change(A, M1, SURVIVED),
        add(observation(A, M1, { kind: 'alone', lineage: A, ...MISSING })),
      ),
    },
  },
  {
    rule: 'trace-inconclusive',
    verdict: 'inconclusive',
    edit: { pair: { trace: { status: 'inconclusive', reasons: ['trace-changed-outcome'] } } },
  },
  { rule: 'not-eligible', verdict: 'out-of-scope', edit: { b: { eligible: false } } },
  {
    rule: 'covers-no-evaluated-mutant',
    verdict: 'out-of-scope',
    edit: { observations: chain(change(B, M1, UNCOVERED), change(B, M2, UNCOVERED)) },
  },
  { rule: 'kills-nothing', verdict: 'weak', edit: { observations: change(B, M1, SURVIVED) } },
  {
    rule: 'value-flow-veto',
    verdict: 'review',
    edit: { pair: { staticValueFlow: { status: 'veto', reasons: ['opaque: Math.round'] } } },
  },
  {
    rule: 'value-flow-unknown',
    verdict: 'review',
    edit: { pair: { staticValueFlow: { status: 'unknown', reasons: ['expected-only'] } } },
  },
  { rule: 'all-strong-conditions', verdict: 'repeat-strong', edit: {} },
  { rule: 'weak-disqualifier', verdict: 'repeat-weak', edit: { a: { notOracleValidated: true } } },
  {
    rule: 'kills-differ',
    verdict: 'row',
    edit: { observations: change(B, M2, { outcome: 'killed-by-test:assertion' }) },
  },
  {
    rule: 'row-deletion-asymmetric',
    verdict: 'row',
    edit: { pair: { rowDeletion: { outcome: 'asymmetric', reasons: [] } } },
  },
  { rule: 'residual-difference', verdict: 'review', edit: { b: { facet: RESIDUAL_FACET } } },
  { rule: 'facet-differs-same-kills', verdict: 'review', edit: { b: { facet: OTHER_FACET } } },
  { rule: 'facet-missing-same-kills', verdict: 'review', edit: { b: { facet: null } } },
  {
    rule: 'path-differs',
    verdict: 'distinct',
    edit: { observations: change(B, M3, { covered: true, sources: ['row'] }) },
  },
  { rule: 'checks-context-missing', verdict: 'distinct', edit: { b: { checksContext: null } } },
  {
    rule: 'checks-context-differs',
    verdict: 'distinct',
    edit: { b: { checksContext: 'checks-other' } },
  },
  {
    rule: 'facet-differs-kills-differ',
    verdict: 'distinct',
    edit: {
      b: { facet: OTHER_FACET },
      observations: change(B, M2, { outcome: 'killed-by-test:assertion' }),
    },
  },
];

describe('precedence rules (design §2)', () => {
  it.each(RULE_CASES)('rule $rule decides $verdict', ({ rule, verdict, edit }) => {
    const decided = verdictOf(edit);
    expect([decided.verdict, decided.rule]).toEqual([verdict, rule]);
  });

  it('lists every Inconclusive cause, the first deciding, above Out of scope', () => {
    const verdict = verdictOf({
      b: { eligible: false },
      pair: {
        schedule: { status: 'inconclusive', reason: 'not-scheduled', detail: null },
        isolation: { status: 'disagrees', reason: 'isolation-disagrees', disqualifiers: [] },
      },
    });
    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.inconclusive).toEqual([
      'not-scheduled',
      'isolation-disagrees',
      'member-inconclusive',
    ]);
  });

  it('makes a timeout on a mutant covered by B Inconclusive with the mutant named', () => {
    const verdict = verdictOf({ observations: change(B, M2, { outcome: 'timeout' }) });
    expect(verdict.details).toEqual([`${B}: timeout on ${M2}`]);
  });

  it('keeps a residual difference (D1) out of every repeat category', () => {
    const verdict = verdictOf({ b: { facet: RESIDUAL_FACET } });
    expect(verdict.evidence.facet).toBe('residual');
    expect(verdict.details).toEqual(['body.1']);
    expect(kindsOf(verdict)).toContain('unresolved-facet-input');
  });

  it('makes a Row of two Set members told apart by row deletion (set-membership)', () => {
    const verdict = verdictOf({
      a: { facet: facet(['200']) },
      b: { facet: facet(['204']) },
      pair: { rowDeletion: { outcome: 'asymmetric', reasons: [] } },
    });
    expect([verdict.verdict, verdict.rule]).toEqual(['row', 'row-deletion-asymmetric']);
  });

  it('makes a Row of kill sets that differ by one mutant', () => {
    const verdict = verdictOf({
      observations: change(B, M2, { outcome: 'killed-by-test:assertion' }),
    });
    expect([verdict.verdict, verdict.evidence.killSets]).toEqual(['row', 'differ']);
  });
});

// ── One case per weak disqualifier ─────────────────────────────────────────

const DISQUALIFIER_CASES: { label: string; kind: WeakDisqualifier; edit: WorldEdit }[] = [
  {
    label: 'native entry point',
    kind: 'provenance-not-strong-eligible',
    edit: {
      a: {
        provenance: {
          known: true,
          nativeEntries: ['node_modules/tree-sitter/index.js'],
          workerSpawns: [],
        },
      },
    },
  },
  {
    label: 'unknown provenance',
    kind: 'provenance-not-strong-eligible',
    edit: { a: { provenance: { known: false, nativeEntries: [], workerSpawns: [] } } },
  },
  {
    label: 'unresolved facet input',
    kind: 'unresolved-facet-input',
    edit: { a: { facet: facet(['2', '3'], { unresolved: ['row value is not static'] }) } },
  },
  {
    label: 'unresolved selector',
    kind: 'unresolved-facet-input',
    edit: { a: { unresolvedSelectors: ['label'] } },
  },
  {
    label: 'inconclusive row deletion',
    kind: 'row-deletion-inconclusive',
    edit: { pair: { rowDeletion: { outcome: 'inconclusive', reasons: ['unsupported-table'] } } },
  },
  {
    label: 'row deletion missing for differing values',
    kind: 'row-deletion-inconclusive',
    edit: { pair: { rowDeletion: null } },
  },
  {
    label: 'unsupported assertion form',
    kind: 'unsupported-construct',
    edit: {
      a: {
        unsupportedForms: [{ line: 4, form: 'assert.equal', reason: 'not an expect assertion' }],
      },
    },
  },
  {
    label: 'join that is not one-to-one',
    kind: 'unsupported-construct',
    edit: { a: { joinProblems: ['join-mismatch'] } },
  },
  {
    label: 'isolation not run',
    kind: 'isolation-not-run',
    edit: {
      pair: { isolation: { status: 'not-run', reason: 'not-scheduled', disqualifiers: [] } },
    },
  },
  {
    label: 'not oracle-validated',
    kind: 'not-oracle-validated',
    edit: { a: { notOracleValidated: true } },
  },
  {
    label: 'non-identical V8 blocks',
    kind: 'non-identical-blocks',
    edit: { pair: { identicalBlocks: false } },
  },
  {
    label: 'executed gitnexus/tools/x.ts',
    kind: 'excluded-file',
    edit: { a: { excludedFiles: ['gitnexus/tools/x.ts'] } },
  },
  {
    label: 'hook-attributed observation',
    kind: 'hook-stratum',
    edit: { observations: change(A, M1, { hookAttributed: true }) },
  },
  {
    label: 'hook stratum from the isolation pass',
    kind: 'hook-stratum',
    edit: {
      pair: {
        isolation: {
          status: 'agrees',
          reason: null,
          disqualifiers: [{ kind: 'hook-stratum-unvalidated', cap: 'weak', mutants: [M1] }],
        },
      },
    },
  },
];

describe('weak disqualifiers', () => {
  it.each(DISQUALIFIER_CASES)('$label caps the repeat at weak ($kind)', ({ kind, edit }) => {
    const verdict = verdictOf(edit);
    expect([verdict.verdict, verdict.rule]).toEqual(['repeat-weak', 'weak-disqualifier']);
    expect(kindsOf(verdict)).toEqual([kind]);
  });

  it('names the test and the file of an excluded-file disqualifier', () => {
    const verdict = verdictOf({ a: { excludedFiles: ['gitnexus/tools/x.ts'] } });
    expect(verdict.disqualifiers).toEqual([
      { kind: 'excluded-file', tests: [A], details: ['gitnexus/tools/x.ts'] },
    ]);
  });

  it('lists the disqualifiers of a pair whatever its verdict', () => {
    const verdict = verdictOf({
      pair: {
        identicalBlocks: false,
        schedule: { status: 'inconclusive', reason: null, detail: null },
      },
    });
    expect([verdict.verdict, verdict.rule]).toEqual(['inconclusive', 'not-scheduled']);
    expect(kindsOf(verdict)).toEqual(['non-identical-blocks']);
  });
});

// ── Per-test properties ────────────────────────────────────────────────────

describe('per-test Weak and Inconclusive', () => {
  it('reports both tests Weak and the pair Weak when both kill sets are empty', () => {
    const input = world({ observations: chain(change(A, M1, SURVIVED), change(B, M1, SURVIVED)) });
    const report = computeVerdicts(input);
    expect([report.pairs[0].verdict, report.pairs[0].rule]).toEqual(['weak', 'kills-nothing']);
    expect(report.tests.map((entry) => [entry.id, entry.status, entry.statements])).toEqual([
      [A, 'weak', [WORDING.weak]],
      [B, 'weak', [WORDING.weak]],
    ]);
  });

  it('reports a test with only a runtime kill Inconclusive, not Weak', () => {
    const input = world({ observations: change(A, M1, { outcome: 'killed-by-test:runtime' }) });
    expect(testOf(input, A)).toMatchObject({
      status: 'inconclusive',
      reasons: ['non-assertion-outcome: killed-by-test:runtime'],
      kills: 0,
      statements: [],
    });
    expect(computeVerdicts(input).pairs[0].rule).toBe('non-assertion-outcome');
  });

  it.each([
    { label: 'killing', edit: {}, status: 'killing', reasons: [] },
    {
      label: 'not eligible',
      edit: { a: { eligible: false } },
      status: 'out-of-scope',
      reasons: ['not-eligible'],
    },
    {
      label: 'covering nothing',
      edit: { observations: chain(change(A, M1, UNCOVERED), change(A, M2, UNCOVERED)) },
      status: 'out-of-scope',
      reasons: ['covers-no-evaluated-mutant'],
    },
    {
      label: 'never evaluated',
      edit: {
        pair: { schedule: { status: 'inconclusive', reason: 'group-over-budget', detail: null } },
      },
      status: 'inconclusive',
      reasons: ['not-evaluated'],
    },
    {
      label: 'with an unknown result and no kill',
      edit: { observations: chain(change(A, M1, SURVIVED), change(A, M2, MISSING)) },
      status: 'inconclusive',
      reasons: ['unknown-result: missing-result'],
    },
    {
      label: 'killing only a static mutant',
      edit: {
        observations: chain(
          change(A, M1, UNCOVERED),
          change(A, M2, UNCOVERED),
          add(observation(A, M4, { covered: false, static: true })),
        ),
      },
      status: 'killing',
      reasons: [],
    },
  ] as { label: string; edit: WorldEdit; status: string; reasons: string[] }[])(
    'test A $label',
    ({ edit, status, reasons }) => {
      expect(testOf(world(edit), A)).toMatchObject({ status, reasons });
    },
  );
});

describe('subsumption (design §5.4)', () => {
  /** A kills M1; B kills M1 and M2 over the same run. */
  const subsumedWorld = (edit: ObservationEdit = (entries) => entries): VerdictInput =>
    world({ observations: chain(change(B, M2, { outcome: 'killed-by-test:assertion' }), edit) });

  it('marks A Subsumed when B kills a strict superset over all of A universe', () => {
    const input = subsumedWorld();
    expect(testOf(input, A)?.subsumption).toMatchObject({
      status: 'subsumed',
      by: [B],
      universe: 3,
    });
    expect(testOf(input, A)?.statements).toEqual([WORDING.subsumed]);
    expect(testOf(input, B)?.subsumption.status).toBe('not-subsumed');
  });

  it.each([
    { label: 'B has no valid result on one mutant', edit: change(B, M3, MISSING) },
    {
      label: 'B was evaluated in another group run that lacks one mutant',
      edit: (entries: MergedObservation[]) =>
        entries
          .filter((entry) => entry.test !== B)
          .concat(
            observation(B, M1, { group: 'g2' }),
            observation(B, M2, { group: 'g2' }),
            observation(C, M1, { group: 'g2', ...SURVIVED }),
            observation(C, M2, { group: 'g2' }),
          ),
    },
  ])('makes subsumption unknown when $label', ({ edit }) => {
    const input = subsumedWorld(edit);
    const extra = { ...input, pairs: [...input.pairs, pairInput({ a: B, b: C, group: 'g2' })] };
    expect(
      testOf({ ...extra, tests: [...extra.tests, testInput(C)] }, A)?.subsumption,
    ).toMatchObject({ status: 'unknown', by: [B] });
  });

  it('does not mark tests with equal kill sets Subsumed', () => {
    expect(testOf(world(), A)?.subsumption.status).toBe('not-subsumed');
  });
});

// ── Gaps ───────────────────────────────────────────────────────────────────

describe('gaps per production file (R11)', () => {
  it('recomputes gaps from every trusted observation, across groups', () => {
    const input: VerdictInput = {
      ...world(),
      tests: [...world().tests, testInput(C), testInput(D)],
      pairs: [
        pairInput(),
        pairInput({ a: C, b: D, group: 'g2' }),
        pairInput({
          a: A,
          b: C,
          group: 'g3',
          schedule: { status: 'inconclusive', reason: 'baseline-failed', detail: null },
        }),
      ],
      observations: {
        explicit: [
          ...mainRun([A, B]),
          observation(A, M4, { covered: false, static: true, ...SURVIVED }),
          observation(B, M4, { covered: false, static: true, ...SURVIVED }),
          // Group g2 kills M2, which survives group g1.
          observation(C, M2, { group: 'g2' }),
          observation(D, M2, { group: 'g2', ...SURVIVED }),
          // Group g3 never completed: its kill of M3 does not count.
          observation(A, M3, { group: 'g3' }),
        ],
        universes: [],
      },
    };
    expect(computeVerdicts(input).gaps).toEqual([
      { file: FILE, mutants: 4, killed: 2, survived: [M4], uncovered: [M3], inconclusive: [] },
    ]);
  });

  it('never counts a missing result as survived', () => {
    const input = world({ observations: chain(change(A, M2, MISSING)) });
    expect(computeVerdicts(input).gaps[0]).toMatchObject({ survived: [], inconclusive: [M2] });
  });
});

// ── dupe-ok and determinism ────────────────────────────────────────────────

describe('report', () => {
  it('moves a pair with dupe-ok on B to the kept list with its evidence (R15)', () => {
    const report = computeVerdicts(world({ b: { dupeOk: 'documents the doubling case' } }));
    expect(report.pairs).toEqual([]);
    expect(report.kept).toHaveLength(1);
    expect(report.kept[0]).toMatchObject({
      verdict: 'repeat-strong',
      keep: [{ test: B, reason: 'documents the doubling case' }],
    });
  });

  it('carries the engine version', () => {
    expect(computeVerdicts(world()).engineVersion).toBe(VERDICT_ENGINE_VERSION);
  });

  it('gives byte-identical output on a rerun and on reordered input', () => {
    const input: VerdictInput = {
      ...world({ observations: change(B, M2, { outcome: 'killed-by-test:assertion' }) }),
      tests: [...world().tests, testInput(C)],
      pairs: [pairInput(), pairInput({ a: C, b: A, group: 'g1' })],
    };
    const withC: VerdictInput = {
      ...input,
      observations: { explicit: [...input.observations.explicit, ...mainRun([C])], universes: [] },
    };
    const reordered: VerdictInput = {
      tests: [...withC.tests].reverse(),
      pairs: [...withC.pairs].reverse().map((pair) => ({ ...pair, a: pair.b, b: pair.a })),
      observations: { explicit: [...withC.observations.explicit].reverse(), universes: [] },
      valueFlowDegraded: [],
    };
    const first = JSON.stringify(computeVerdicts(withC));
    expect(JSON.stringify(computeVerdicts(withC))).toBe(first);
    expect(JSON.stringify(computeVerdicts(reordered))).toBe(first);
  });
});

// ── Compact observations ───────────────────────────────────────────────────

describe('compact observations', () => {
  /** The main run's universe: A and B selected, M1 to M3 evaluated, none static. */
  const universe: RunUniverse = {
    group: 'g1',
    kind: 'main',
    lineage: 'main',
    shard: 0,
    tests: [A, B],
    mutants: [M1, M2, M3].map((id) => ({
      id,
      file: FILE,
      static: false,
      status: 'Survived' as const,
      reasons: [],
      hookMarker: true,
    })),
    valid: true,
    reasons: [],
  };
  const implied = (input: VerdictInput, reasons: string[] = []): VerdictInput => ({
    ...input,
    observations: {
      explicit: input.observations.explicit.filter((entry) => entry.mutant !== M3),
      universes: [{ ...universe, valid: reasons.length === 0, reasons }],
    },
  });

  it.each([
    ['the positive control', {}],
    ['a pair whose kill sets differ', { observations: change(B, M1, SURVIVED) }],
    ['a test that kills nothing', { observations: chain(change(A, M1, SURVIVED)) }],
  ])('decides %s the same when the not-covered survivals of M3 are implied', (_title, edit) => {
    expect(computeVerdicts(implied(world(edit)))).toEqual(computeVerdicts(world(edit)));
  });

  it('makes an implied observation of a run with a run-level reason unknown, never survived', () => {
    const report = computeVerdicts(implied(world(), ['run-flag:dry-run-missing']));
    expect([report.pairs[0].rule, report.gaps[0].inconclusive, report.gaps[0].uncovered]).toEqual([
      'kills-unknown',
      [M3],
      [],
    ]);
  });
});
