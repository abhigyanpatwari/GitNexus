import { expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { assertionEvidence } from '../../../tools/scenario-map/consolidation/assertions.js';
import {
  FixtureCloneIndex,
  FixtureCloneCandidates,
  verifyFixtureClonePairs,
  runFixtureClones,
  type CloneRun,
} from '../../../tools/scenario-map/consolidation/fixture-clones.js';
import {
  capturedFixtureSources,
  mergeFixtureSources,
  type FixtureSources,
} from '../../../tools/scenario-map/consolidation/fixture-sources.js';
import { consolidationReport, overlap } from '../../../tools/scenario-map/consolidation/report.js';
import { computeChecks } from '../../../tools/scenario-map/facet/checks.js';
import { expandCases } from '../../../tools/scenario-map/inventory/cases.js';
import { sha1 } from '../../../tools/scenario-map/util.js';
import type { FixtureProfile } from '../../../tools/scenario-map/facet/fixture-profile.js';
import type {
  CoverageWorkFile,
  CoverageTest,
} from '../../../tools/scenario-map/path-coverage/run-coverage.js';
import type { Layer2Test } from '../../../tools/scenario-map/scenario-map.js';

const SOURCE = 'export function calculate(value: number) { return value + 1; }\n';
const files: [string, string][] = [['main.ts', SOURCE]];
const key = sha1(JSON.stringify(files));
const sources: FixtureSources = { [key]: files };
const profile: FixtureProfile = {
  sourceKeys: [key],
  roots: ['/tmp/input'],
  files: ['/tmp/input/main.ts'],
  contentKey: 'same',
  languages: ['typescript'],
  features: [['def:Function', 1]],
  unresolved: [],
};
const noClones: CloneRun = { tool: 'jscpd', version: 'test', sourceCount: 1, clones: [] };
const atom = (value = '2', shape = 'count') => ({
  line: 1,
  shape,
  shapeKey: shape,
  key: `${shape}:${value}`,
  expected: value,
});
const evidence = (atoms = [atom()]) => ({ atoms, unresolved: [] });
const test = (id: string, blocks = [0, 1]): CoverageTest => ({
  id,
  taskId: id,
  file: 'test/input.test.ts',
  fullName: id,
  location: null,
  state: 'passed',
  concurrent: false,
  attempts: 2,
  blocks,
  suiteBlocks: [],
  provenance: {
    known: true,
    executedFiles: [],
    nativeEntries: [],
    workerSpawns: [],
    excludedCandidates: [],
  },
});
const detail = (id: string, assertions = evidence(), fixture = profile): Layer2Test => ({
  id,
  file: 'test/input.test.ts',
  anchor: null,
  notOracleValidated: false,
  dupeOk: null,
  joinProblems: [],
  inventoryUnresolved: [],
  checksContext: null,
  unsupportedForms: [],
  unresolvedSelectors: [],
  facet: null,
  fixture,
  assertionEvidence: assertions,
});
const work = (tests: CoverageTest[]): CoverageWorkFile => ({
  schemaVersion: 1,
  fixtureCaptureVersion: 1,
  fixtureSources: sources,
  mode: 'normal',
  extraRoots: [],
  repeats: 1,
  blocks: [
    'src/a.ts#one@0|1-2:1',
    'src/a.ts#two@2|3-4:1',
    'src/a.ts#miss@4|5-6:0',
    'src/b.ts#three@0|1-2:1',
  ],
  files: [],
  tests,
  unhandledErrors: [],
});
const report = (tests: CoverageTest[], details: Layer2Test[]) =>
  consolidationReport(work(tests), details, new FixtureCloneIndex(sources, noClones));

it('requires all three axes for observed equality and groups repeated cases without expanding every pair', () => {
  const tests = Array.from({ length: 100 }, (_, i) => test(String(i)));
  const result = report(
    tests,
    tests.map((t) => detail(t.id)),
  );
  expect(result.opportunities).toHaveLength(1);
  expect(result.opportunities[0]).toMatchObject({
    kind: 'same-observed-input-path-assertions',
    representedPairs: 4950,
    path: { coverageA: 1, coverageB: 1 },
    assertions: { coverageA: 1, coverageB: 1 },
  });
});

it('does not mistake shared uncovered branch ranges for shared execution', () => {
  const result = report([test('a', [0, 2]), test('b', [3, 2])], [detail('a'), detail('b')]);
  expect(result.opportunities).toEqual([]);
});

it('reports partial shared checks and retains unique assertions and executed branches', () => {
  const result = report(
    [test('a', [0, 1]), test('b', [0, 3])],
    [
      detail('a', evidence([atom(), atom('a', 'only-a')])),
      detail('b', evidence([atom(), atom('b', 'only-b')])),
    ],
  );
  expect(result.opportunities[0]).toMatchObject({
    kind: 'extract-shared-scenario',
    path: { coverageA: 0.5, coverageB: 0.5 },
    assertions: { shared: 1, totalA: 2, totalB: 2 },
  });
  const found = result.opportunities[0];
  expect([...found.onlyAssertionsA, ...found.onlyAssertionsB].join()).toContain('only-a');
  expect([...found.onlyAssertionsA, ...found.onlyAssertionsB].join()).toContain('only-b');
  expect([...found.onlyBlocksA, ...found.onlyBlocksB]).toContain('src/a.ts#two@2|3-4:1');
});

it('keeps different expected values as parameter rows, not equal assertions', () => {
  const result = report([test('a'), test('b')], [detail('a'), detail('b', evidence([atom('3')]))]);
  expect(result.opportunities[0]).toMatchObject({
    kind: 'parameterize-expectations',
    assertions: { shared: 0 },
    assertionShapes: { shared: 1 },
  });
});

it('rejects disjoint checks, failed cases, concurrent paths, missing inputs, and unresolved expectations', () => {
  expect(
    report([test('a'), test('b')], [detail('a'), detail('b', evidence([atom('2', 'different')]))])
      .opportunities,
  ).toEqual([]);
  for (const patch of [{ state: 'failed' as const }, { concurrent: true }])
    expect(
      report([test('a'), { ...test('b'), ...patch }], [detail('a'), detail('b')]).opportunities,
    ).toEqual([]);
  expect(
    report(
      [test('a'), test('b')],
      [detail('a'), detail('b', evidence(), { ...profile, unresolved: ['missing file'] })],
    ).opportunities,
  ).toEqual([]);
  expect(
    report(
      [test('a'), test('b')],
      [detail('a'), detail('b', evidence([{ ...atom(), key: null, expected: null }]))],
    ).opportunities,
  ).toEqual([]);
});

it('counts repeated assertions as a multiset and handles empty evidence honestly', () => {
  expect(overlap(['a', 'a', 'b'], ['a', 'b'])).toMatchObject({
    shared: 2,
    totalA: 3,
    totalB: 2,
    coverageB: 1,
  });
  expect(overlap([], [])).toMatchObject({ shared: 0, jaccard: 0 });
});

it('merges immutable source tables and rejects altered source hashes', () => {
  expect(mergeFixtureSources([sources, sources])).toEqual(sources);
  expect(() => mergeFixtureSources([{ [key]: [['main.ts', 'changed']] }])).toThrow('hash mismatch');
  expect(capturedFixtureSources([])).toEqual({});
});

it('measures clone coverage using weighted byte spans instead of whole matching lines', () => {
  const otherFiles: [string, string][] = [['main.ts', SOURCE.replace('+', '-')]];
  const otherKey = sha1(JSON.stringify(otherFiles));
  const run: CloneRun = {
    ...noClones,
    sourceCount: 2,
    clones: [
      {
        a: { source: key, file: 'main.ts', start: 0, end: 20, startLine: 1, endLine: 1 },
        b: { source: otherKey, file: 'main.ts', start: 0, end: 20, startLine: 1, endLine: 1 },
        kind: 'similar',
        similarity: 0.5,
        tokens: 12,
      },
    ],
  };
  const index = new FixtureCloneIndex({ ...sources, [otherKey]: otherFiles }, run);
  const found = index.compare(profile, {
    ...profile,
    sourceKeys: [otherKey],
    contentKey: 'different',
  });
  expect(found?.coverageA).toBeGreaterThan(0);
  expect(found?.coverageA).toBeLessThan(0.5);
  expect(found?.kind).toBe('clone');
});

it('runs the pinned external clone engine on renamed and partial fixture functions', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fixture-clone-test-'));
  const renamed: [string, string][] = [
    ['main.ts', SOURCE.replaceAll('calculate', 'compute').replaceAll('value', 'amount')],
  ];
  const longer: [string, string][] = [
    [
      'main.ts',
      SOURCE + '\nexport function extra(x: number) { while (x > 0) { x--; } return x; }\n',
    ],
  ];
  const renamedKey = sha1(JSON.stringify(renamed)),
    longerKey = sha1(JSON.stringify(longer));
  try {
    const all = { ...sources, [renamedKey]: renamed, [longerKey]: longer };
    const run = await runFixtureClones(all, root);
    expect(run.version).toContain('5.4.2');
    const index = new FixtureCloneIndex(all, run);
    expect(
      index.compare(profile, { ...profile, sourceKeys: [renamedKey], contentKey: 'renamed' })
        ?.coverageA,
    ).toBeGreaterThan(0.5);
    const partial = index.compare(profile, {
      ...profile,
      sourceKeys: [longerKey],
      contentKey: 'longer',
    });
    expect(partial?.coverageA).toBeGreaterThan(0.5);
    expect(partial?.coverageB).toBeLessThan(0.8);
    expect(partial?.unmatchedB.some((span) => span.end > SOURCE.length)).toBe(true);
    // The external report may connect both to a representative, omitting this pair.
    const transitive = index.compare(
      { ...profile, sourceKeys: [renamedKey], contentKey: 'renamed' },
      { ...profile, sourceKeys: [longerKey], contentKey: 'longer' },
    );
    expect(transitive?.coverageA).toBeGreaterThan(0.5);
    expect(transitive?.coverageB).toBeLessThan(0.8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('verifies contained representative spans without projecting offsets or treating near misses as transitive', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fixture-contained-test-'));
  const longer: [string, string][] = [
    ['main.ts', SOURCE + 'export function extra(x: number) { while (x > 0) x--; return x; }'],
  ];
  const decoy: [string, string][] = [['decoy.ts', '// unrelated wrapper\n' + longer[0][1]]];
  const longerKey = sha1(JSON.stringify(longer)),
    decoyKey = sha1(JSON.stringify(decoy));
  const all = { ...sources, [longerKey]: longer, [decoyKey]: decoy };
  const b = { ...profile, sourceKeys: [longerKey], contentKey: 'longer' };
  const span = (source: string, file: string, start: number, end: number) => ({
    source,
    file,
    start,
    end,
    startLine: 1,
    endLine: 2,
  });
  try {
    const exported = await runFixtureClones(all, root);
    // The full corpus can choose the same representative with DIFFERENT bounds.
    // These representative links retrieve a candidate, never manufactured clone spans.
    const run: CloneRun = {
      ...exported,
      clones: [
        {
          a: span(key, 'main.ts', 0, SOURCE.length - 1),
          b: span(decoyKey, 'decoy.ts', 21, 21 + SOURCE.length - 1),
          kind: 'renamed',
          similarity: 1,
          tokens: 13,
        },
        {
          a: span(longerKey, 'main.ts', 0, SOURCE.length + 10),
          b: span(decoyKey, 'decoy.ts', 21, 21 + SOURCE.length + 10),
          kind: 'renamed',
          similarity: 1,
          tokens: 17,
        },
      ],
    };
    expect(new FixtureCloneIndex(all, run).compare(profile, b)).toBeNull();
    const candidates = new FixtureCloneCandidates(run);
    consolidationReport(
      { ...work([test('a'), test('b')]), fixtureSources: all },
      [detail('a'), detail('b', evidence(), b)],
      new FixtureCloneIndex(all, run),
      (a, b) => candidates.consider(a, b),
    );
    expect(candidates.pairs()).toEqual([[key, longerKey].sort()]);
    const verified = await verifyFixtureClonePairs(
      all,
      run,
      candidates.pairs(),
      path.join(root, 'pairs'),
    );
    const result = new FixtureCloneIndex(all, verified).compare(profile, b);
    expect(result?.coverageA).toBeGreaterThan(0.8);
    expect(result?.coverageB).toBeLessThan(0.8);
    expect(result?.unmatchedB.some((s) => s.end > SOURCE.length)).toBe(true);
    expect(verified.verifiedPairs).toBe(1);
    const nearMiss = new FixtureCloneCandidates({
      ...run,
      clones: run.clones.map((c) => ({ ...c, kind: 'similar', similarity: 0.9 })),
    });
    nearMiss.consider(profile, b);
    expect(nearMiss.pairs()).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function assertions(source: string) {
  return expandCases([{ path: 'gitnexus/test/unit/controls.test.ts', source }]).sites.flatMap(
    (site) =>
      (site.instances ?? []).map((instance) => {
        const subject = { record: site.record, instance, fullName: site.fullName };
        return assertionEvidence(subject, computeChecks(subject));
      }),
  );
}

it('resolves asserted const origins and distinguishes different queried quantities', () => {
  const found = assertions(`
    it('a', () => { const n = graph.nodes.length; expect(n).toBe(2); });
    it('b', () => { const m = graph.nodes.length; expect(m).toBe(2); });
    it('c', () => { const n = graph.edges.length; expect(n).toBe(2); });
    it('d', () => { let n = graph.nodes.length; n++; expect(n).toBe(2); });
  `);
  expect(found[0].atoms[0].key).toBeTruthy();
  expect(found[1].atoms[0].key).toBe(found[0].atoms[0].key);
  expect(found[2].atoms[0].key).not.toBe(found[0].atoms[0].key);
  expect(found[3].atoms[0].key).toBeNull();
});

it('retains exact expected values, negation, selectors, and row values', () => {
  const found = assertions(`
    it.each([2, 3])('row %i', (n) => { expect(graph.nodes.length).toBe(n); });
    it('literal', () => { expect(graph.nodes.length).toBe(2); });
    it('negative', () => { expect(graph.nodes.length).not.toBe(2); });
    it('selector', () => { expect(graph.get('Function')).toHaveLength(2); });
    it('other selector', () => { expect(graph.get('Class')).toHaveLength(2); });
  `);
  expect(found[0].atoms[0].key).toBe(found[2].atoms[0].key);
  expect(found[0].atoms[0].key).not.toBe(found[1].atoms[0].key);
  expect(found[2].atoms[0].key).not.toBe(found[3].atoms[0].key);
  expect(found[4].atoms[0].key).not.toBe(found[5].atoms[0].key);
});

it('canonicalizes object and signed numeric expectations and rejects unknown expected values', () => {
  const found = assertions(`
    it.each([{ b: 2, a: -1 }])('row', (value) => { expect(result).toEqual(value); });
    it('literal', () => { expect(result).toEqual({ a: -1, b: 2 }); });
    it('unknown', () => { expect(result).toEqual(calculateExpected()); });
    it('shadow', () => { const undefined = calculateExpected(); expect(result).toBe(undefined); });
  `);
  expect(found[0].atoms[0].expected).toBe(found[1].atoms[0].expected);
  expect(found[2].atoms[0].key).toBeNull();
  expect(found[3].atoms[0].key).toBeNull();
});

it('does not hide unknown checks or extra repeated assertions in partial overlaps', () => {
  const a = evidence([atom(), atom(), { ...atom(), key: null, expected: null }]);
  const result = report([test('a'), test('b')], [detail('a', a), detail('b')]);
  const found = result.opportunities[0];
  expect(found.assertions.shared).toBe(1);
  expect([found.assertions.totalA, found.assertions.totalB].sort()).toEqual([1, 3]);
  expect(found.onlyAssertionsA.length + found.onlyAssertionsB.length).toBe(2);
  expect(found.kind).not.toBe('same-observed-input-path-assertions');
});

it('resolves const query chains and lexically bound callback parameters without conflating selectors', () => {
  const found = assertions(`
    it('a', () => { const calls = getRelationships(result, 'CALLS'); const edge = calls.find(c => c.target === 'save'); expect(edge).toBeDefined(); });
    it('b', () => { const relations = getRelationships(result, 'CALLS'); const match = relations.find(e => e.target === 'save'); expect(match).toBeDefined(); });
    it('c', () => { const calls = getRelationships(result, 'CALLS'); const edge = calls.find(c => c.target === 'getName'); expect(edge).toBeDefined(); });
    it('d', () => { const calls = getRelationships(result, 'IMPORTS'); const edge = calls.find(c => c.target === 'save'); expect(edge).toBeDefined(); });
  `);
  expect(found[0].atoms[0].key).toBeTruthy();
  expect(found[1].atoms[0].key).toBe(found[0].atoms[0].key);
  expect(found[2].atoms[0].key).not.toBe(found[0].atoms[0].key);
  expect(found[3].atoms[0].key).not.toBe(found[0].atoms[0].key);
});

it('retains template text when tracing asserted query chains', () => {
  const a = assertions(
    "it('a', () => { const paths = items.map(e => `${e.source} -> ${e.target}`); expect(paths.some(p => p.includes('service'))).toBe(true); });",
  )[0];
  const b = assertions(
    "it('b', () => { const paths = items.map(e => `${e.source} => ${e.target}`); expect(paths.some(p => p.includes('service'))).toBe(true); });",
  )[0];
  expect(a.atoms[0].key).toBeTruthy();
  expect(a.atoms[0].key).not.toBe(b.atoms[0].key);
});

it('does not infer clone families through near-miss similarity', () => {
  const thirdFiles: [string, string][] = [['main.ts', SOURCE.replace('+ 1', '* 2')]];
  const third = sha1(JSON.stringify(thirdFiles));
  const middleFiles: [string, string][] = [['main.ts', SOURCE.replace('+ 1', '- 1')]];
  const middle = sha1(JSON.stringify(middleFiles));
  const span = (source: string) => ({
    source,
    file: 'main.ts',
    start: 0,
    end: 20,
    startLine: 1,
    endLine: 1,
  });
  const run: CloneRun = {
    ...noClones,
    sourceCount: 3,
    clones: [
      { a: span(key), b: span(middle), kind: 'similar', similarity: 0.9, tokens: 12 },
      { a: span(middle), b: span(third), kind: 'similar', similarity: 0.9, tokens: 12 },
    ],
  };
  const index = new FixtureCloneIndex(
    { ...sources, [middle]: middleFiles, [third]: thirdFiles },
    run,
  );
  expect(
    index.compare(profile, { ...profile, sourceKeys: [third], contentKey: 'third' }),
  ).toBeNull();
});

it('surfaces one shared check in a partial scenario and retains all other expectations', () => {
  const found = report(
    [test('a'), test('b')],
    [
      detail('a', evidence([atom(), atom('a', 'unique-a'), atom('b', 'unique-b')])),
      detail(
        'b',
        evidence([atom(), atom('c', 'unique-c'), atom('d', 'unique-d'), atom('e', 'unique-e')]),
      ),
    ],
  ).opportunities[0];
  expect(found.assertions).toMatchObject({ shared: 1 });
  expect(found.onlyAssertionsA.length + found.onlyAssertionsB.length).toBe(5);
});

it('keeps negative zero distinct and locates the real assertion on a shared line', () => {
  const found = assertions(`
    it('a', () => { helper(result).toBe(99); expect(result).toBe(-0); });
    it('b', () => { expect(result).toBe(0); });
  `);
  expect(found[0].atoms[0].expected).toContain('"text":"-0"');
  expect(found[0].atoms[0].key).not.toBe(found[1].atoms[0].key);
});
