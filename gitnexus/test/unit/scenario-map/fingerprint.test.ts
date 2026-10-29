/**
 * Locks the scenario fingerprint verdicts (tools/scenario-map/verdict/fingerprint.ts): the base
 * world is two tests that run the same path on the same input and check the same expectation, a
 * duplicate. Each case edits one input and checks the deciding rule, one case per rule, plus the
 * dupe-ok keep list, the orientation and determinism.
 */
import { describe, expect, it } from 'vitest';
import { assertionEvidence } from '../../../tools/scenario-map/consolidation/assertions.js';
import { computeChecks } from '../../../tools/scenario-map/facet/checks.js';
import { expandCases } from '../../../tools/scenario-map/inventory/cases.js';
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
  fingerprintEligible: true,
  passed: true,
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
  { rule: 'not-eligible', verdict: 'out-of-scope', edit: { b: { fingerprintEligible: false } } },
  { rule: 'not-passing', verdict: 'inconclusive', edit: { a: { passed: false } } },
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
  it.each([
    ['roundScore(2.4)', 'roundScore(2.5)'],
    ['roundScore({ scores: [2.4] })', 'roundScore({ scores: [2.5] })'],
  ])('keeps changed literal inputs to %s as table rows', (left, right) => {
    const evidence = expandCases([
      {
        path: 'gitnexus/test/unit/input-shapes.test.ts',
        source: `import { roundScore } from './scores.js';
          it('left', () => { const actual = ${left}; expect(actual).toBe(2); });
          it('right', () => { const actual = ${right}; expect(actual).toBe(3); });`,
      },
    ]).sites.map((site) => {
      const subject = {
        record: site.record,
        instance: site.instances![0],
        fullName: site.fullName,
      };
      return assertionEvidence(subject, computeChecks(subject));
    });
    expect(evidence.every((item) => item.atoms[0].key !== null)).toBe(true);
    expect(evidence[0].atoms[0].key).not.toBe(evidence[1].atoms[0].key);
    const inputs = {
      a: { checks: 'same-check', assertionEvidence: evidence[0], facet: facet(['2.4', '2']) },
      b: { checks: 'same-check', assertionEvidence: evidence[1], facet: facet(['2.5', '3']) },
    };
    expect(verdictOf(inputs)).toMatchObject({ verdict: 'table-row', rule: 'input-values-differ' });
  });

  it.each([
    [
      "getNodes(result).find(n => n.name === 'save')",
      "getNodes(result).find(n => n.name === 'load')",
    ],
    ["getNodes(result, 'CALLS')", "getNodes(result, 'IMPORTS')"],
    ['getNodes(/save/)', 'getNodes(/load/)'],
    ['getNodes({ patterns: [/save/] })', 'getNodes({ patterns: [/load/] })'],
    ['getNodes(2).length', 'getEdges(2).length'],
    ['getNodes(2).length', 'getNodes(2).size'],
  ])('case %#: preserves queried subjects when comparing %s', (left, right) => {
    const evidence = expandCases([
      {
        path: 'gitnexus/test/unit/queried-subjects.test.ts',
        source: `import { getNodes, getEdges } from './graph.js';
          it('left', () => { const actual = ${left}; expect(actual).toBeDefined(); });
          it('right', () => { const actual = ${right}; expect(actual).toBeDefined(); });`,
      },
    ]).sites.map((site) => {
      const subject = {
        record: site.record,
        instance: site.instances![0],
        fullName: site.fullName,
      };
      return assertionEvidence(subject, computeChecks(subject));
    });
    expect(
      verdictOf({
        a: { checks: 'coarse', assertionEvidence: evidence[0] },
        b: { checks: 'coarse', assertionEvidence: evidence[1] },
      }),
    ).toMatchObject({ verdict: 'distinct', rule: 'checks-differ' });
  });

  it('does not promote different assertion subjects or literals through a coarse checks key', () => {
    const assertions = (shapeKey: string, expected: string, known = true) => ({
      atoms: [
        {
          line: 1,
          shape: 'expect(<v1>).toContain(<string>)',
          shapeKey,
          key: known ? `${shapeKey}:${expected}` : null,
          expected,
        },
      ],
      unresolved: known ? [] : ['asserted local origin is unresolved'],
    });
    const a = { checks: 'coarse', facet: null, assertionEvidence: assertions('nodes', 'greet') };
    for (const b of [assertions('text', 'greet'), assertions('nodes', 'function twice', false)]) {
      expect(
        verdictOf({
          a,
          b: { checks: 'coarse', checksContext: 'other', facet: null, assertionEvidence: b },
        }),
      ).toMatchObject({ verdict: 'distinct', rule: 'checks-differ' });
    }
    expect(verdictOf({ a, b: { ...a, checksContext: 'other' } }).verdict).toBe(
      'possible-duplicate',
    );
  });

  it('retains existing table rows outside the actionable pair list without hiding other declarations', () => {
    const result = computeFingerprints({
      tests: [
        testInput(A, { declarationKey: 'same-table', facet: null }),
        testInput(B, { declarationKey: 'same-table', facet: null }),
      ],
      pairs: [pairInput()],
    });
    expect(result.pairs).toEqual([]);
    expect(result.kept[0].keep[0].reason).toContain('already parameterized');
    expect(
      verdictOf({ a: { declarationKey: 'first' }, b: { declarationKey: 'second' } }).verdict,
    ).toBe('duplicate');
  });
  it('leaves proven duplicate rows actionable and uncertain helper equivalence unresolved', () => {
    const identical = computeFingerprints({
      tests: [
        testInput(A, { declarationKey: 'same-table' }),
        testInput(B, { declarationKey: 'same-table' }),
      ],
      pairs: [pairInput()],
    });
    expect(identical.pairs[0]?.verdict).toBe('duplicate');
    expect(identical.kept).toEqual([]);
    const evidence = (file: string) => ({
      atoms: [
        {
          line: 1,
          shape: 'expect(run()).toBe(1)',
          shapeKey: file,
          key: file,
          expected: '1',
          observed: `<local:${file}:1:run>()`,
        },
      ],
      unresolved: [],
    });
    expect(
      verdictOf({
        a: { assertionEvidence: evidence('a') },
        b: { assertionEvidence: evidence('b') },
      }).verdict,
    ).toBe('possible-duplicate');
  });
  it.each(['a', 'b'] as const)(
    'does not compare an assertion-only key on side %s with a legacy combined key',
    (side) => {
      const pair = verdictOf({ [side]: { checks: 'checks-toBe' } });
      expect([pair.verdict, pair.rule, pair.evidence.checks]).toEqual([
        'possible-duplicate',
        'checks-unknown',
        'missing',
      ]);
    },
  );

  it('keeps equal assertions with different setup as a review lead, not different checks', () => {
    const pair = verdictOf({
      a: { checks: 'same-expectation' },
      b: { checks: 'same-expectation', checksContext: 'cleanup-context' },
    });
    expect([pair.verdict, pair.rule, pair.evidence.checks]).toEqual([
      'possible-duplicate',
      'context-differs',
      'same',
    ]);
  });

  it('cannot confirm a duplicate when assertion-only keys exist but context is missing', () => {
    const pair = verdictOf({
      a: { checks: 'same-expectation', checksContext: null },
      b: { checks: 'same-expectation', checksContext: null },
    });
    expect([pair.verdict, pair.rule]).toEqual(['possible-duplicate', 'context-unknown']);
  });

  it('retains known input differences when setup also differs', () => {
    const pair = verdictOf({
      a: { checks: 'same-expectation' },
      b: {
        checks: 'same-expectation',
        checksContext: 'other-setup',
        facet: facet(['Number[]', 'Number']),
      },
    });
    expect([pair.verdict, pair.rule]).toEqual(['table-row', 'input-values-differ']);
  });

  it.each(['args-differ', 'receiver-differs'] as const)(
    'retains a proven runtime value difference (%s) when setup also differs',
    (reason) => {
      const pair = verdictOf({
        a: { checks: 'same-expectation' },
        b: { checks: 'same-expectation', checksContext: 'other-setup' },
        pair: { trace: { status: 'veto', reasons: [reason] } },
      });
      expect([pair.verdict, pair.rule]).toEqual(['table-row', 'runtime-values-differ']);
    },
  );

  it('does not prove distinctness from incomplete native/worker paths', () => {
    const pair = verdictOf({
      a: { provenance: { known: true, nativeEntries: ['tree-sitter.node'], workerSpawns: [] } },
      pair: { identicalBlocks: false },
    });
    expect([pair.verdict, pair.rule]).toEqual(['possible-duplicate', 'path-incomplete']);
  });

  it.each(['asymmetric-sites', 'asymmetric-counts'] as const)(
    'does not call a cold/warm trace difference (%s) different input values',
    (reason) => {
      const pair = verdictOf({ pair: { trace: { status: 'veto', reasons: [reason] } } });
      expect([pair.verdict, pair.rule]).toEqual(['possible-duplicate', 'trace-unknown']);
    },
  );

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
