/**
 * Locks the scenario fingerprint verdicts (tools/scenario-map/verdict/fingerprint.ts): the base
 * world is two tests that run the same path on the same input and check the same expectation, a
 * duplicate. Each case edits one input and checks the deciding rule, one case per rule, plus the
 * dupe-ok keep list, the orientation and determinism.
 */
import { describe, expect, it } from 'vitest';
import type { InputFacet } from '../../../tools/scenario-map/facet/input-facet.js';
import {
  FINGERPRINT_ENGINE_VERSION,
  computeFingerprints,
  type FingerprintPairInput,
  type FingerprintRule,
  type FingerprintTestInput,
  type FingerprintVerdict,
} from '../../../tools/scenario-map/verdict/fingerprint.js';

const A = 'test/unit/ext.test.ts#extract > User[] → User';
const B = 'test/unit/shared.test.ts#extract > strips the array suffix: User[] → User';

const facet = (values: readonly string[], overrides: Partial<InputFacet> = {}): InputFacet => ({
  fingerprint: 'facet-extract',
  parts: {
    language: '-',
    source: [],
    fixtures: [],
    data: [],
    calls: ['extractElementTypeFromString'],
    order: ['<string>', '<string>'],
  },
  discarded: values.map((value, position) => ({
    position,
    kind: 'string',
    value,
    location: { file: 'gitnexus/test/unit/ext.test.ts', line: 3, column: 10 + position * 3 },
    origin: 'literal',
  })),
  unresolved: [],
  skeleton: ['body.0\tcall extractElementTypeFromString', 'body.0.args.0\t<slot>'],
  ...overrides,
});

const testInput = (
  id: string,
  overrides: Partial<FingerprintTestInput> = {},
): FingerprintTestInput => ({
  id,
  eligible: true,
  dupeOk: null,
  joinProblems: [],
  inventoryUnresolved: [],
  provenance: { known: true, nativeEntries: [], workerSpawns: [] },
  concurrent: false,
  checksContext: 'checks-toBe',
  unsupportedForms: [],
  unresolvedSelectors: [],
  facet: facet(['User[]', 'User']),
  ...overrides,
});

const pairInput = (overrides: Partial<FingerprintPairInput> = {}): FingerprintPairInput => ({
  a: A,
  b: B,
  group: 'g1',
  identicalBlocks: true,
  pathUnattributable: false,
  trace: { status: 'clean', reasons: [] },
  ...overrides,
});

interface WorldEdit {
  a?: Partial<FingerprintTestInput>;
  b?: Partial<FingerprintTestInput>;
  pair?: Partial<FingerprintPairInput>;
}

const verdictOf = (edit: WorldEdit = {}) =>
  computeFingerprints({
    tests: [testInput(A, edit.a), testInput(B, edit.b)],
    pairs: [pairInput(edit.pair)],
  }).pairs[0];

const CASES: { rule: FingerprintRule; verdict: FingerprintVerdict; edit: WorldEdit }[] = [
  { rule: 'not-eligible', verdict: 'out-of-scope', edit: { b: { eligible: false } } },
  { rule: 'path-unattributable', verdict: 'inconclusive', edit: { a: { concurrent: true } } },
  { rule: 'path-differs', verdict: 'distinct', edit: { pair: { identicalBlocks: false } } },
  {
    rule: 'same-input-different-checks',
    verdict: 'different-checks',
    edit: { b: { checksContext: 'checks-toEqual' } },
  },
  {
    rule: 'checks-differ',
    verdict: 'distinct',
    edit: { b: { checksContext: 'checks-toEqual', facet: facet(['string[]', 'string']) } },
  },
  {
    rule: 'input-shape-differs',
    verdict: 'distinct',
    edit: { b: { facet: facet(['User[]', 'User'], { fingerprint: 'facet-other' }) } },
  },
  {
    rule: 'input-values-differ',
    verdict: 'table-row',
    edit: { b: { facet: facet(['string[]', 'string']) } },
  },
  {
    rule: 'runtime-values-differ',
    verdict: 'table-row',
    edit: { pair: { trace: { status: 'veto', reasons: ['args-differ'] } } },
  },
  { rule: 'checks-unknown', verdict: 'possible-duplicate', edit: { a: { checksContext: null } } },
  { rule: 'facet-unknown', verdict: 'possible-duplicate', edit: { b: { facet: null } } },
  {
    rule: 'input-unresolved',
    verdict: 'possible-duplicate',
    edit: { b: { inventoryUnresolved: ['each-table: familySuffixes may be mutated'] } },
  },
  {
    rule: 'trace-unknown',
    verdict: 'possible-duplicate',
    edit: { pair: { trace: { status: 'inconclusive', reasons: ['trace-missing'] } } },
  },
  { rule: 'same-path-input-expectation', verdict: 'duplicate', edit: {} },
];

describe('fingerprint rules', () => {
  it.each(CASES)('rule $rule decides $verdict', ({ rule, verdict, edit }) => {
    const decided = verdictOf(edit);
    expect([decided.verdict, decided.rule]).toEqual([verdict, rule]);
  });

  it.each([
    {
      label: 'an unresolved facet input',
      edit: { a: { facet: facet(['User[]', 'User'], { unresolved: ['helper()'] }) } },
    },
    { label: 'an unresolved selector', edit: { a: { unresolvedSelectors: ['key'] } } },
    { label: 'a join problem', edit: { a: { joinProblems: ['join-count-unknown'] } } },
    {
      label: 'an unsupported assertion',
      edit: { a: { unsupportedForms: [{ line: 4, form: 'toSatisfy', reason: 'predicate' }] } },
    },
    { label: 'an unknown provenance', edit: { a: { provenance: null } } },
    {
      label: 'a worker spawn',
      edit: {
        a: {
          provenance: {
            known: true,
            nativeEntries: [],
            workerSpawns: [{ api: 'new Worker', target: 'w.js', site: null }],
          },
        },
      },
    },
    { label: 'a missing trace', edit: { pair: { trace: null } } },
  ])('never calls a pair with $label a duplicate', ({ edit }) => {
    expect(verdictOf(edit).verdict).toBe('possible-duplicate');
  });

  it('keeps a residual body difference out of the duplicates (D1)', () => {
    const residual = facet(['User[]', 'User'], {
      skeleton: ['body.0\tcall extractElementTypeFromString', 'body.1\tCallable'],
    });
    expect([verdictOf({ b: { facet: residual } }).rule]).toEqual(['input-unresolved']);
  });

  it('records the evidence of a duplicate', () => {
    expect(verdictOf().evidence).toEqual({
      path: 'same',
      checks: 'same',
      facet: 'equal',
      values: 'equal',
      trace: 'clean',
      unresolved: [],
    });
  });
});

describe('computeFingerprints', () => {
  it('orients a pair with the smaller id first and keeps a dupe-ok pair apart', () => {
    const report = computeFingerprints({
      tests: [testInput(A, { dupeOk: 'kept on purpose' }), testInput(B)],
      pairs: [pairInput({ a: B, b: A })],
    });
    expect([
      report.engineVersion,
      report.pairs,
      report.kept.map((p) => [p.a, p.b, p.keep]),
    ]).toEqual([
      FINGERPRINT_ENGINE_VERSION,
      [],
      [[A, B, [{ test: A, reason: 'kept on purpose' }]]],
    ]);
  });

  it('is deterministic whatever the input order', () => {
    const C = 'test/unit/ext.test.ts#extract > string[] → string';
    const tests = [
      testInput(A),
      testInput(B),
      testInput(C, { facet: facet(['string[]', 'string']) }),
    ];
    const pairs = [pairInput(), pairInput({ a: A, b: C, group: 'g2' })];
    expect(
      computeFingerprints({ tests: [...tests].reverse(), pairs: [...pairs].reverse() }),
    ).toEqual(computeFingerprints({ tests, pairs }));
  });

  it('throws for a pair whose test has no input', () => {
    expect(() => computeFingerprints({ tests: [testInput(A)], pairs: [pairInput()] })).toThrow(
      /no test input/,
    );
  });
});
