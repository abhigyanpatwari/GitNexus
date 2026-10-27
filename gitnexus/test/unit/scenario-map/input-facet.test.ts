/**
 * Locks the input facet of a test instance (U6, R5, R9, KTD6, design §2 "Input facet", §5.3
 * rules 1–8, D1, D2): table members collapse with their discarded values kept per position,
 * inline source keeps its anonymised shape, boundary numbers and numbers within ±1 of a
 * production constant stay exact (constants-only modules and folded initialisers included),
 * selectors stay exact, `it.each` rows are evaluated per instance, unresolvable inputs are
 * marked, and the residual-difference guard catches what the facet does not carry.
 */
import { describe, expect, it } from 'vitest';
import {
  applyResidualGuard,
  computeFacet,
  createFacetContext,
  residualDifference,
  sameDiscardedValues,
  type FacetSources,
  type InputFacet,
} from '../../../tools/scenario-map/facet/input-facet.js';
import { expandCases } from '../../../tools/scenario-map/inventory/cases.js';

const TEST_FILE = 'gitnexus/test/unit/a.test.ts';
const PACKAGE_FILE = 'test/unit/a.test.ts';
const IMPORTS = [
  `import { SupportedLanguages } from 'gitnexus-shared';`,
  `import { add, build, clamp, cobol, edge, getNodesByLabel, isCallable, isSuccess, join, load, make, matches, parse, parseSource, run, typeEdge } from '../../src/m.js';`,
  `import { MiniGraph, NodeLabel } from '../../src/labels.js';`,
];

interface World {
  /** Production and fixture sources by repo path. */
  files: Record<string, string>;
  /** Executed production files; default every `gitnexus/src/` file. */
  executed?: string[] | null;
  /** Static import closure; default the test file and every `gitnexus/src/` file. */
  closure?: string[];
  /** Lines inside the describe, before the tests. */
  prelude?: string[];
}

const KINDS = 'gitnexus/src/kinds.ts';
const M = 'gitnexus/src/m.ts';
const NONE: World = { files: { [M]: `export const noop = (): void => {};` } };
const TABLE: World = {
  files: {
    [M]: `export const isCallable = (k: string) => k.length > 0;`,
    [KINDS]: `export const KINDS = ['Function', 'Class', 'Method'];`,
  },
};
const LIMIT: World = {
  files: {
    [M]: `export const LIMIT = 100;\nexport const parse = (n: number) => Math.min(n, LIMIT);`,
  },
};
const FOLDED: World = {
  files: {
    [M]: `export const LIMIT = 2 * 50;\nexport const parse = (n: number) => Math.min(n, LIMIT);`,
  },
};
const CONSTANTS_ONLY: World = {
  files: {
    [M]: `import { LIMIT } from './limits.js';\nexport const parse = (n: number) => (n > LIMIT ? LIMIT : n);`,
    'gitnexus/src/limits.ts': `export const LIMIT = 100;`,
  },
  executed: [M],
};
const NEAR_TABLE: World = {
  files: {
    [M]: `import { KINDS } from './kinds.js';\nexport const isCallable = (k: string) => KINDS.includes(k);`,
    [KINDS]: `export const KINDS = ['Function', 'Class', 'Method'];`,
  },
  executed: [],
};
const STATUS_SET: World = {
  files: {
    [M]: `const OK = new Set([200, 204]);\nexport const isSuccess = (s: number) => OK.has(s);`,
  },
};

const memorySources = (files: Record<string, string>): FacetSources => ({
  read: (file) => files[file] ?? null,
  list: (dir) =>
    Object.keys(files)
      .filter((file) => file.startsWith(`${dir}/`))
      .sort(),
});

/** The facets of every instance of the tests, written inside one describe. */
async function facetsOf(world: World, ...tests: string[]): Promise<InputFacet[]> {
  const source = [
    ...IMPORTS,
    `describe('d', () => {`,
    ...(world.prelude ?? []),
    ...tests,
    `});`,
  ].join('\n');
  const sites = expandCases([{ path: TEST_FILE, source }]).sites;
  const production = Object.keys(world.files).filter((file) => file.startsWith('gitnexus/src/'));
  const ctx = createFacetContext({
    sources: memorySources({ ...world.files, [TEST_FILE]: source }),
    productionFiles: production,
    closures: new Map([[PACKAGE_FILE, world.closure ?? [TEST_FILE, ...production]]]),
    builtinFiles: [],
  });
  const executed = world.executed === undefined ? production : world.executed;
  const subjects = sites.flatMap((site) =>
    (site.instances ?? []).map((instance) => ({
      id: `${site.record.title}#${instance.row}`,
      file: PACKAGE_FILE,
      record: site.record,
      instance,
      executedFiles: executed,
    })),
  );
  const facets: InputFacet[] = [];
  for (const subject of subjects) facets.push(await computeFacet(subject, ctx));
  return facets;
}

async function pairOf(
  world: World,
  first: string,
  second: string,
): Promise<[InputFacet, InputFacet]> {
  const facets = await facetsOf(world, first, second);
  expect(facets).toHaveLength(2);
  return [facets[0], facets[1]];
}

const positions = (facet: InputFacet): [number, string, string][] =>
  facet.discarded.map((entry) => [entry.position, entry.value, entry.origin]);

describe('computeFacet: equal and different facets', () => {
  it.each([
    [
      'two members of one production string table',
      true,
      TABLE,
      `it('a', () => { expect(isCallable('Function')).toBe(true); });`,
      `it('b', () => { expect(isCallable('Class')).toBe(true); });`,
    ],
    [
      'two members of a table two import hops away',
      true,
      NEAR_TABLE,
      `it('a', () => { expect(isCallable('Function')).toBe(true); });`,
      `it('b', () => { expect(isCallable('Class')).toBe(true); });`,
    ],
    [
      'inline Rust against inline Go',
      false,
      NONE,
      `it('a', () => { expect(parseSource('fn main() { let x = 1; }', SupportedLanguages.Rust)).toBe(true); });`,
      `it('b', () => { expect(parseSource('package main\\nfunc main() { x := 1 }', SupportedLanguages.Go)).toBe(true); });`,
    ],
    [
      'inline TypeScript differing only in a local variable name',
      true,
      NONE,
      `it('a', () => { expect(parseSource('const alpha = compute(1);', SupportedLanguages.TypeScript)).toBe(true); });`,
      `it('b', () => { expect(parseSource('const beta = compute(1);', SupportedLanguages.TypeScript)).toBe(true); });`,
    ],
    [
      'COBOL using different reserved words',
      false,
      NONE,
      `it('a', () => { expect(cobol('PERFORM X THRU Y')).toBe(true); });`,
      `it('b', () => { expect(cobol('MOVE A TO B')).toBe(true); });`,
    ],
    [
      '101 against 150 under a production LIMIT = 100',
      false,
      LIMIT,
      `it('a', () => { expect(parse(101)).toBe(100); });`,
      `it('b', () => { expect(parse(150)).toBe(100); });`,
    ],
    [
      '150 against 170 under a production LIMIT = 100',
      true,
      LIMIT,
      `it('a', () => { expect(parse(150)).toBe(100); });`,
      `it('b', () => { expect(parse(170)).toBe(100); });`,
    ],
    [
      '101 against 150 with LIMIT in a constants-only module the test never executes',
      false,
      CONSTANTS_ONLY,
      `it('a', () => { expect(parse(101)).toBe(100); });`,
      `it('b', () => { expect(parse(150)).toBe(100); });`,
    ],
    [
      '101 against 150 under LIMIT = 2 * 50',
      false,
      FOLDED,
      `it('a', () => { expect(parse(101)).toBe(100); });`,
      `it('b', () => { expect(parse(150)).toBe(100); });`,
    ],
    [
      'a literal 0 against a literal 5',
      false,
      NONE,
      `it('a', () => { expect(clamp(0)).toBe(true); });`,
      `it('b', () => { expect(clamp(5)).toBe(true); });`,
    ],
    [
      'add(1, 2) against add(2, 3): 1 stays exact (D2)',
      false,
      NONE,
      `it('a', () => { expect(add(1, 2)).toBe(3); });`,
      `it('b', () => { expect(add(2, 3)).toBe(5); });`,
    ],
    [
      'add(2, 3) against add(5, 5) (D2)',
      true,
      NONE,
      `it('a', () => { expect(add(2, 3)).toBe(5); });`,
      `it('b', () => { expect(add(5, 5)).toBe(10); });`,
    ],
    [
      'a negative number against another negative number',
      false,
      NONE,
      `it('a', () => { expect(clamp(-5)).toBe(true); });`,
      `it('b', () => { expect(clamp(-7)).toBe(true); });`,
    ],
    [
      'two entries of a production numeric Set (D3)',
      true,
      STATUS_SET,
      `it('a', () => { expect(isSuccess(200)).toBe(true); });`,
      `it('b', () => { expect(isSuccess(204)).toBe(true); });`,
    ],
    [
      'literals [a, b] against [b, a] of different shapes',
      false,
      NONE,
      `it('a', () => { expect(join('abc', 'Abc')).toBe(true); });`,
      `it('b', () => { expect(join('Abc', 'abc')).toBe(true); });`,
    ],
    [
      'two selector literals of an expect subject',
      false,
      NONE,
      `it('a', () => { const r = build(); expect(getNodesByLabel(r, 'Function')).toHaveLength(2); });`,
      `it('b', () => { const r = build(); expect(getNodesByLabel(r, 'Class')).toHaveLength(2); });`,
    ],
    [
      'different object-literal keys',
      false,
      NONE,
      `it('a', () => { expect(make({ alpha: 2 })).toBe(true); });`,
      `it('b', () => { expect(make({ beta: 2 })).toBe(true); });`,
    ],
    [
      'different builder calls',
      false,
      NONE,
      `it('a', () => { expect(typeEdge('x')).toBe(true); });`,
      `it('b', () => { expect(edge('x')).toBe(true); });`,
    ],
    [
      'an empty string against a non-empty one',
      false,
      NONE,
      `it('a', () => { expect(run('')).toBe(true); });`,
      `it('b', () => { expect(run('x')).toBe(true); });`,
    ],
  ])('%s: equal facets is %s', async (_label, equal, world, first, second) => {
    const [a, b] = await pairOf(world, first, second);
    expect(a.fingerprint === b.fingerprint).toBe(equal);
  });

  it('keeps the data part equal when only the source order of the literals differs', async () => {
    const [a, b] = await pairOf(
      NONE,
      `it('a', () => { expect(join('abc', 'Abc')).toBe(true); });`,
      `it('b', () => { expect(join('Abc', 'abc')).toBe(true); });`,
    );
    expect(a.parts.data).toEqual(b.parts.data);
    expect([a.parts.order, b.parts.order]).toEqual([
      ['a', 'Aa'],
      ['Aa', 'a'],
    ]);
  });
});

describe('computeFacet: discarded values', () => {
  it('keeps each discarded table member at its position', async () => {
    const [a, b] = await pairOf(
      TABLE,
      `it('a', () => { expect(isCallable('Function')).toBe(true); });`,
      `it('b', () => { expect(isCallable('Class')).toBe(true); });`,
    );
    expect([positions(a), positions(b)]).toEqual([
      [[0, 'Function', 'literal']],
      [[0, 'Class', 'literal']],
    ]);
    expect(a.parts.data).toEqual([`T:${KINDS}#0`]);
  });

  it('records where a discarded literal is written', async () => {
    const [facet] = await facetsOf(
      TABLE,
      `it('a', () => { expect(isCallable('Function')).toBe(true); });`,
    );
    expect(facet.discarded[0].location).toEqual({ file: TEST_FILE, line: 5, column: 34 });
  });

  it.each([
    ['a boundary number', `it('a', () => { expect(add(1, -1)).toBe(0); });`, LIMIT],
    ['a number within ±1 of a constant', `it('a', () => { expect(parse(99)).toBe(100); });`, LIMIT],
    [
      'a selector',
      `it('a', () => { const r = build(); expect(getNodesByLabel(r, 'Function')).toHaveLength(1); });`,
      NONE,
    ],
  ])('discards nothing for %s', async (_label, test, world) => {
    const [facet] = await facetsOf(world, test);
    expect(facet.discarded).toEqual([]);
  });

  it.each([
    [
      'equal',
      `it('a', () => { expect(parse(150)).toBe(100); });`,
      `it('b', () => { expect(parse(150)).toBe(100); });`,
      true,
    ],
    [
      'different',
      `it('a', () => { expect(parse(150)).toBe(100); });`,
      `it('b', () => { expect(parse(170)).toBe(100); });`,
      false,
    ],
  ])('compares %s discarded values', async (_label, first, second, same) => {
    const [a, b] = await pairOf(LIMIT, first, second);
    expect(sameDiscardedValues(a, b)).toBe(same);
  });
});

describe('computeFacet: per-instance rows', () => {
  it.each([
    ['conditional alias', `const input = flag ? 'pool' : undefined;`],
    ['transitive alias', `const selected = flag ? 'pool' : undefined; const input = selected;`],
    ['captured helper', `function input() { return flag ? 'pool' : undefined; }`],
  ])('does not resolve a captured loop %s from identical body text', async (_name, setup) => {
    const facets = await facetsOf(
      NONE,
      `for (const flag of [false, true]) {`,
      setup,
      `it(String(flag), () => { expect(run(input, 'disabled')).toBe(false); });`,
      `}`,
    );
    expect(facets).toHaveLength(2);
    for (const facet of facets) {
      expect(facet.unresolved).toContain('captured loop binding input: instance value unknown');
    }
  });

  it('marks an outer loop alias captured inside an inner loop unresolved', async () => {
    const facets = await facetsOf(
      NONE,
      `for (const flag of [false, true]) {`,
      `const expected = flag ? 'pool' : undefined;`,
      `for (const count of [1, 2]) {`,
      `it(String(count), () => { expect(run(count)).toBe(expected); });`,
      `}}`,
    );
    expect(facets).toHaveLength(4);
    for (const facet of facets) {
      expect(facet.unresolved).toContain('captured loop binding expected: instance value unknown');
    }
  });

  it('leaves unused loop aliases and locally shadowed names out of input uncertainty', async () => {
    const facets = await facetsOf(
      NONE,
      `for (const flag of [false, true]) {`,
      `const input = flag ? 'pool' : undefined;`,
      `it(String(flag), () => { const input = 'same'; expect(run(input)).toBe(false); });`,
      `}`,
    );
    expect(facets).toHaveLength(2);
    expect(facets.map((facet) => facet.unresolved)).toEqual([[], []]);
  });

  it('does not let a nested callback parameter hide a captured loop input', async () => {
    const facets = await facetsOf(
      NONE,
      `for (const flag of [false, true]) {`,
      `const input = flag ? 'pool' : undefined;`,
      `it(String(flag), () => { [1].map(input => input); expect(run(input)).toBe(false); });`,
      `}`,
    );
    expect(facets).toHaveLength(2);
    for (const facet of facets) {
      expect(facet.unresolved).toContain('captured loop binding input: instance value unknown');
    }
  });

  it('evaluates each it.each row, keeping its discarded value', async () => {
    const facets = await facetsOf(
      TABLE,
      `it.each([['Function'], ['Class']])('k %s', (kind) => { expect(isCallable(kind)).toBe(true); });`,
    );
    expect(facets.map((facet) => facet.fingerprint === facets[0].fingerprint)).toEqual([
      true,
      true,
    ]);
    expect(facets.map(positions)).toEqual([[[0, 'Function', 'row']], [[0, 'Class', 'row']]]);
  });

  it('keeps a row number within ±1 of a constant exact', async () => {
    const facets = await facetsOf(
      LIMIT,
      `it.each([[101], [150]])('p %s', (n) => { expect(parse(n)).toBe(100); });`,
    );
    expect(facets[0].fingerprint === facets[1].fingerprint).toBe(false);
  });

  it('marks a row value that is not static unresolved', async () => {
    const [facet] = await facetsOf(
      NONE,
      `it.each([[build()]])('u %s', (value) => { expect(run(value)).toBe(true); });`,
    );
    expect(facet.unresolved).toEqual(
      expect.arrayContaining([expect.stringMatching(/^row value value:/)]),
    );
  });

  it('reads a method call on a static row value as code over that value', async () => {
    const facets = await facetsOf(
      NONE,
      `it.each([['Alpha'], ['Beta']])('m %s', (name) => { expect(run(name.toLowerCase())).toBe(true); });`,
    );
    expect(facets.map((facet) => [facet.unresolved, positions(facet)])).toEqual([
      [[], [[0, 'Alpha', 'row']]],
      [[], [[0, 'Beta', 'row']]],
    ]);
  });

  it('flags rows that differ only in a boolean through the residual guard', async () => {
    const facets = await facetsOf(
      NONE,
      `it.each([[true], [false]])('f %s', (flag) => { expect(run(flag)).toBe(true); });`,
    );
    expect(residualDifference(facets[0], facets[1])).toEqual([
      {
        path: 'body.body[0].expression.callee.object.arguments[0].arguments[0]',
        a: '<row:true>',
        b: '<row:false>',
      },
    ]);
  });
});

describe('residual-difference guard', () => {
  it('marks two tests that differ only in an enum member unresolved', async () => {
    const [a, b] = await pairOf(
      NONE,
      `it('a', () => { const graph = new MiniGraph(); graph.addNode(NodeLabel.Function); expect(graph.hasCallableNode()).toBe(true); });`,
      `it('b', () => { const graph = new MiniGraph(); graph.addNode(NodeLabel.Method); expect(graph.hasCallableNode()).toBe(true); });`,
    );
    const guarded = applyResidualGuard(a, b);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(guarded.residual).toEqual([
      {
        path: 'body.body[1].expression.arguments[0].property',
        a: 'Name:Function',
        b: 'Name:Method',
      },
    ]);
    expect([guarded.a.unresolved, guarded.b.unresolved]).toEqual([
      ['residual difference: body.body[1].expression.arguments[0].property'],
      ['residual difference: body.body[1].expression.arguments[0].property'],
    ]);
  });

  it('marks two tests that differ only in a regex literal unresolved', async () => {
    const [a, b] = await pairOf(
      NONE,
      `it('a', () => { expect(matches(/^a/, 'x')).toBe(true); });`,
      `it('b', () => { expect(matches(/^b/, 'x')).toBe(true); });`,
    );
    const guarded = applyResidualGuard(a, b);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(guarded.residual.map((entry) => entry.path)).toEqual([
      'body.body[0].expression.callee.object.arguments[0].arguments[0]',
    ]);
    expect(guarded.a.unresolved).toHaveLength(1);
  });

  it('finds no residual difference between textually identical bodies', async () => {
    const [a, b] = await pairOf(
      LIMIT,
      `it('a', () => { const n = parse(150); expect(n).toBe(100); });`,
      `it('b', () => { const n = parse(150); expect(n).toBe(100); });`,
    );
    const guarded = applyResidualGuard(a, b);
    expect([guarded.residual, guarded.a.unresolved, guarded.b.unresolved]).toEqual([[], [], []]);
  });

  it('ignores renamed locals and discarded values', async () => {
    const [a, b] = await pairOf(
      LIMIT,
      `it('a', () => { const first = parse(150); expect(first).toBe(100); });`,
      `it('b', () => { const second = parse(170); expect(second).toBe(100); });`,
    );
    expect(residualDifference(a, b)).toEqual([]);
  });

  it('does not apply to facet-unequal pairs', async () => {
    const [a, b] = await pairOf(
      LIMIT,
      `it('a', () => { expect(parse(101)).toBe(100); });`,
      `it('b', () => { expect(parse(150)).toBe(100); });`,
    );
    expect(residualDifference(a, b)).toEqual([]);
  });
});

describe('computeFacet: fixtures and unresolved inputs', () => {
  it('marks a fixture file that cannot be shaped unresolved', async () => {
    const world: World = {
      files: { ...NONE.files, 'gitnexus/test/fixtures/big/huge.dat': 'x'.repeat(200_001) },
    };
    const [facet] = await facetsOf(
      world,
      `it('a', () => { expect(load('huge.dat')).toBe(true); });`,
    );
    expect(facet.unresolved).toEqual(['fixture file huge.dat: cannot be shaped']);
  });

  it('gives a literal naming one fixture file that file shape', async () => {
    const world: World = {
      files: {
        ...NONE.files,
        'gitnexus/test/fixtures/proj/main.go': 'package main\nfunc Handle() {}\n',
      },
    };
    const [facet] = await facetsOf(
      world,
      `it('a', () => { expect(load('proj/main.go')).toBe(true); });`,
    );
    expect([facet.parts.fixtures, facet.parts.data]).toEqual([
      [expect.stringMatching(/^fixfile:/)],
      [],
    ]);
  });

  it('resolves a literal against the fixture a describe hook names', async () => {
    const world: World = {
      files: {
        ...NONE.files,
        'gitnexus/test/fixtures/sample-proj/main.go':
          'package main\nfunc Handle(n int) int { return n }\n',
      },
      prelude: [`beforeAll(() => { load('sample-proj'); });`],
    };
    const [facet] = await facetsOf(world, `it('a', () => { expect(run('Handle')).toBe(true); });`);
    expect([facet.parts.fixtures, facet.parts.data, facet.parts.language]).toEqual([
      [expect.stringMatching(/^def:/)],
      [],
      '-',
    ]);
  });

  it('marks unknown executed files unresolved', async () => {
    const world: World = { ...LIMIT, executed: null };
    const [facet] = await facetsOf(world, `it('a', () => { expect(parse(150)).toBe(100); });`);
    expect(facet.unresolved).toEqual(['executed files not known']);
  });
});
