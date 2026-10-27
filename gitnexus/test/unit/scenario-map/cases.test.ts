/**
 * Locks the static expansion of test calls into instances (U3, design §5.3): `it.each` /
 * `test.each` / `test.for` tables, tagged-template tables, `describe.each` and `for…of` loops over
 * literal arrays give one instance per row with its bound values; anything whose number of
 * instances is not static (a computed table, another loop, a test inside a helper or callback)
 * fails closed as unresolved. Also pins the predicted Vitest location and static full name.
 */
import { describe, expect, it } from 'vitest';
import { expandCases, renderRowValue } from '../../../tools/scenario-map/inventory/cases.js';
import type { StaticCallSite } from '../../../tools/scenario-map/types.js';
import type { SourceFile } from '../../../tools/test-dupes/test-dupes.js';

const FILE = 'gitnexus/test/unit/a.test.ts';
const file = (...lines: string[]): SourceFile => ({ path: FILE, source: lines.join('\n') });
const sitesOf = (...lines: string[]): StaticCallSite[] => expandCases([file(...lines)]).sites;
const onlySite = (...lines: string[]): StaticCallSite => {
  const sites = sitesOf(...lines);
  expect(sites).toHaveLength(1);
  return sites[0];
};

/** Rows of a site as rendered callback arguments; null when the count is not static. */
const argsOf = (site: StaticCallSite): (string[] | null)[] | null =>
  site.instances?.map((instance) => instance.args?.map(renderRowValue) ?? null) ?? null;

describe('expandCases: tables', () => {
  it('expands it.each([[1, 2], [3, 4]]) into two instances with spread bound values', () => {
    const site = onlySite(`it.each([[1, 2], [3, 4]])('adds %i', (a, b) => { add(a, b); });`);
    expect(site.instances?.map((instance) => instance.row)).toEqual([0, 1]);
    expect(argsOf(site)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(site.instances?.map((instance) => instance.unresolved)).toEqual([[], []]);
  });

  it.each([
    [
      'scalar rows, passed whole',
      '',
      `it.each(['a', 'b'])('t %s', (s) => {});`,
      [['"a"'], ['"b"']],
    ],
    [
      'mixed array and scalar rows, passed whole',
      '',
      `it.each([[1], 2])('t %s', (x) => {});`,
      [['[1]'], ['2']],
    ],
    [
      'object rows',
      '',
      `it.each([{ a: 1 }, { a: -2 }])('t $a', ({ a }) => {});`,
      [['{a: 1}'], ['{a: -2}']],
    ],
    [
      'test.for rows, never spread',
      '',
      `test.for([[1, 2], [3, 4]])('t %i', ([a, b]) => {});`,
      [['[1, 2]'], ['[3, 4]']],
    ],
    [
      'a tagged-template table',
      '',
      'it.each`\n  a    | b\n  ${1} | ${"x"}\n  ${2} | ${"y"}\n`(\'t $a\', ({ a, b }) => {});',
      [['{a: 1, b: "x"}'], ['{a: 2, b: "y"}']],
    ],
    [
      'a const table',
      `const ROWS = [[1], [2]] as const;`,
      `it.each(ROWS)('t %i', (n) => {});`,
      [['1'], ['2']],
    ],
    [
      'a sliced const table',
      `const ROWS = ['a', 'b', 'c'];`,
      `it.each(ROWS.slice(1))('t %s', (s) => {});`,
      [['"b"'], ['"c"']],
    ],
    [
      'a spread of const tables',
      `const A = [1]; const B = [2];`,
      `it.each([...A, ...B])('t %i', (n) => {});`,
      [['1'], ['2']],
    ],
    [
      'templates, arithmetic and Number constants',
      `const P = 'pre-';`,
      "it.each([[`${P}x`, Number.MAX_SAFE_INTEGER - 1, -0]])('t', (s, n, z) => {});",
      [['"pre-x"', '9007199254740990', '-0']],
    ],
  ])('binds %s', (_label, prelude, call, expected) => {
    expect(argsOf(onlySite(prelude, call))).toEqual(expected);
  });

  it.each([
    ['a computed table', `it.each(buildRows())('t %s', (r) => {});`, /^each-table: /],
    ['a let table', `let rows = [1]; it.each(rows)('t %s', (r) => {});`, /not a const/],
    [
      'an imported table',
      `import { rows } from './rows'; it.each(rows)('t', (r) => {});`,
      /import/,
    ],
    [
      'a const table mutated elsewhere',
      `const rows = [1]; rows.push(2); it.each(rows)('t %s', (r) => {});`,
      /may be mutated/,
    ],
    [
      'a const table passed to a function',
      `const rows = [1]; shuffle(rows); it.each(rows)('t %s', (r) => {});`,
      /may be mutated/,
    ],
    [
      'a const table whose rows a callback method reaches',
      `const rows = [[1]]; expect(rows.find((r) => r.pop())); it.each(rows)('t', (r) => {});`,
      /may be mutated/,
    ],
    ['a spread of an unknown array', `it.each([...more()])('t %s', (r) => {});`, /^each-table: /],
  ])('marks %s unresolved with no instance count', (_label, source, reason) => {
    const site = onlySite(source);
    expect(site.instances).toBeNull();
    expect(site.unresolved.join('\n')).toMatch(reason);
  });

  it('keeps the row count of a literal table whose values are not static, marking the rows', () => {
    const site = onlySite(`it.each([[make(), 1], [make(), 2]])('t', (x, n) => {});`);
    expect(argsOf(site)).toEqual([
      ['?(make())', '1'],
      ['?(make())', '2'],
    ]);
    expect(site.instances?.map((instance) => instance.unresolved.length > 0)).toEqual([true, true]);
  });

  it('cannot tell whether Vitest spreads rows of unknown shape: args unknown, rows unresolved', () => {
    const site = onlySite(`import { a, b } from './x';`, `it.each([a, b])('t', (x) => {});`);
    expect(argsOf(site)).toEqual([null, null]);
    expect(site.instances?.map((instance) => instance.unresolved)).toEqual([
      expect.arrayContaining(['each-row-shape']),
      expect.arrayContaining(['each-row-shape']),
    ]);
  });
});

describe('expandCases: enclosing constructs', () => {
  it('expands a for…of loop over a literal array into one instance per element', () => {
    const site = onlySite(`for (const lang of ['go', 'rust']) {`, `  it('parses', () => {});`, `}`);
    expect(
      site.instances?.map((instance) =>
        instance.dimensions.map((d) => [d.kind, d.index, renderRowValue(d.row)]),
      ),
    ).toEqual([[['for-of', 0, '"go"']], [['for-of', 1, '"rust"']]]);
    expect(argsOf(site)).toEqual([[], []]);
  });

  it('expands describe.each times the inner it.each, outer rows varying slowest', () => {
    const site = onlySite(
      `describe.each(['x', 'y'])('suite %s', (s) => {`,
      `  it.each([1, 2])('t %i', (n) => {});`,
      `});`,
    );
    expect(
      site.instances?.map((instance) =>
        instance.dimensions.map((d) => `${d.kind}:${renderRowValue(d.row)}`).join(' '),
      ),
    ).toEqual([
      'describe-each:"x" each:1',
      'describe-each:"x" each:2',
      'describe-each:"y" each:1',
      'describe-each:"y" each:2',
    ]);
  });

  it.each([
    ['a counting loop', `for (let i = 0; i < 2; i++) { it('t', () => {}); }`, 'loop: ForStatement'],
    ['a while loop', `while (more()) { it('t', () => {}); }`, 'loop: WhileStatement'],
    ['a for…of over a computed list', `for (const x of list()) { it('t', () => {}); }`, 'for-of: '],
    ['a forEach callback', `cases.forEach((c) => { it('t', () => {}); });`, 'nested-function'],
    ['a helper function', `function suite() { it('t', () => {}); }`, 'nested-function'],
  ])('fails closed on a test inside %s', (_label, source, reason) => {
    const site = onlySite(source);
    expect(site.instances).toBeNull();
    expect(site.unresolved.join('\n')).toContain(reason);
  });

  it('leaves a test under an if as one instance: the runtime join catches a skipped branch', () => {
    expect(onlySite(`if (process.env.X) { it('t', () => {}); }`).instances).toHaveLength(1);
  });
});

describe('expandCases: location, name and files', () => {
  it.each([
    ['a plain call, at the callee', ['describe("d", () => {', '  it("t", () => {});', '});'], 2, 3],
    ['a member call, at the property', ['test.skip("t", () => {});'], 1, 6],
    ['an each call, at the outer call paren', ['it.each([', '  [1],', '])("t", (n) => {});'], 3, 3],
  ])('predicts the Vitest location of %s', (_label, lines, line, column) => {
    expect(sitesOf(...lines).at(-1)?.location).toEqual({ line, column });
  });

  it.each([
    ['plain titles', ['describe("a", () => {', '  it("b", () => {});', '});'], 'a > b'],
    ['an each test', ['it.each([1])("b %i", (n) => {});'], null],
    [
      'a describe.each suite',
      ['describe.each([1])("a %i", () => {', '  it("b", () => {});', '});'],
      null,
    ],
    ['a computed title', ['it(NAME, () => {});'], null],
  ])('derives the static full name for %s', (_label, lines, fullName) => {
    expect(sitesOf(...lines).at(-1)?.fullName).toBe(fullName);
  });

  it('reports the package path, and reads a fixture *.case.ts file when it is a test of the run', () => {
    const fixture: SourceFile = {
      path: 'gitnexus/test/fixtures/mutation-scenario-map/rows.case.ts',
      source: `it('t', () => {});`,
    };
    expect(expandCases([fixture]).sites.map((site) => site.file)).toEqual([
      'test/fixtures/mutation-scenario-map/rows.case.ts',
    ]);
  });

  it('gives equal row fingerprints to equal rows and distinct ones to distinct rows', () => {
    const site = onlySite(`it.each([[1], [2], [1]])('t %i', (n) => {});`);
    const [a, b, c] = site.instances?.map((instance) => instance.rowFingerprint) ?? [];
    expect([a === c, a === b]).toEqual([true, false]);
  });
});
