/**
 * Locks the production tables and numeric constants of the input facet (U6, KTD6, design §5.3
 * rule 3, D3): string arrays, Set/Map entries, object-literal keys, switch cases and regex
 * alternations are tables; numeric literals and Babel-folded arithmetic are constants for the ±1
 * rule, except Set/Map entries and object keys; the best-fit search goes tier by tier and never
 * pools tables across files.
 */
import { describe, expect, it } from 'vitest';
import {
  bestFit,
  factsOf,
  nearConstant,
  numberKey,
  regexWords,
  stringKey,
  TableIndex,
  type ProductionTable,
} from '../../../tools/scenario-map/facet/tables.js';

const FILE = 'gitnexus/src/m.ts';

/** The tables of one source as sorted value lists, in file order. */
const tablesOf = (source: string): string[][] =>
  factsOf(FILE, source).tables.map((table) => [...table.values].sort());

const constantsOf = (source: string): number[] =>
  [...factsOf(FILE, source).constants].sort((a, b) => a - b);

describe('factsOf: tables', () => {
  it.each([
    [
      'a string array',
      `export const KINDS = ['Function', 'Class', 'Method'];`,
      [['s:Class', 's:Function', 's:Method']],
    ],
    [
      'the entries of a Set, numbers included',
      `const OK = new Set([200, 204]);`,
      [['n:200', 'n:204']],
    ],
    [
      'the one-character entries of a Set',
      `const UNITS = new Set(['s', 'm', 'h']);`,
      [['s:h', 's:m', 's:s']],
    ],
    ['the keys of a Map', `const M = new Map([['a', 1], ['b', 2]]);`, [['s:a', 's:b']]],
    [
      'the keys of an object literal with three properties',
      `const UNIT_FACTORS = { ms: 1, s: 1000, min: 60000 };`,
      [['s:min', 's:ms', 's:s']],
    ],
    [
      'the string cases of a switch',
      `export function f(x: string) { switch (x) { case 'get': return 1; case 'set': return 2; } return 0; }`,
      [['s:get', 's:set']],
    ],
    [
      'the alternatives of a regex literal',
      `export const isAccessor = (n: string) => /^(?:get|set)[A-Z]/.test(n);`,
      [['s:get', 's:set']],
    ],
    [
      'the alternatives of a RegExp built from a string',
      `const R = new RegExp('\\\\b(STRING|UNSTRING)\\\\b');`,
      [['s:STRING', 's:UNSTRING']],
    ],
  ])('finds %s', (_label, source, expected) => {
    expect(tablesOf(source)).toEqual(expected);
  });

  it.each([
    ['an array of one string', `const A = ['only'];`],
    ['an array with fewer than 80% strings', `const A = ['a1', 'b1', x, y, z];`],
    ['an object literal with two properties', `const O = { a: 1, b: 2 };`],
    ['an array of one-character strings', `const A = ['a', 'b'];`],
  ])('finds no table in %s', (_label, source) => {
    expect(tablesOf(source)).toEqual([]);
  });

  it('numbers its tables per file, in source order', () => {
    const facts = factsOf(FILE, `const A = ['xa', 'xb']; const B = new Set(['ya', 'yb']);`);
    expect(facts.tables.map((table) => table.id)).toEqual([`${FILE}#0`, `${FILE}#1`]);
  });

  it('groups the array values of a property key into a column', () => {
    const facts = factsOf(
      FILE,
      `export const P = { exts: ['.rs', '.go'], aliases: new Set(['ab', 'cd']) };`,
    );
    expect([...facts.columns].map(([key, values]) => [key, [...values].sort()])).toEqual([
      ['exts', ['.go', '.rs']],
      ['aliases', ['ab', 'cd']],
    ]);
  });
});

describe('factsOf: numeric constants', () => {
  it.each([
    ['a named constant', `export const LIMIT = 100;`, [100]],
    ['a negated literal', `export function f() { return -1; }`, [-1]],
    ['a folded initialiser', `export const LIMIT = 2 * 50;`, [2, 50, 100]],
    ['arithmetic over a const', `const A = 100; export const B = A + 1;`, [1, 100, 101]],
    ['an object value', `const F = { ms: 1, s: 1000, min: 60000 };`, [1, 1000, 60000]],
    ['no Set entries (D3)', `const OK = new Set([200, 204]);`, []],
    ['no Map entries (D3)', `const M = new Map([[3, 'three'], [4, 'four']]);`, []],
    ['no numeric object keys', `const O = { 7: 'a' };`, []],
    ['no literal types', `type T = 42; export const x: T = 42 as T;`, [42]],
  ])('records %s', (_label, source, expected) => {
    expect(constantsOf(source)).toEqual(expected);
  });

  it.each([
    [99, true],
    [100, true],
    [101, true],
    [102, false],
    [150, false],
  ])('treats %d as near the constant 100: %s', (value, expected) => {
    expect(nearConstant(new Set([100]), value)).toBe(expected);
  });
});

describe('regexWords', () => {
  it.each([
    ['^(?:get|set)[A-Z]', ['get', 'set']],
    ['\\b(PERFORM|THRU|THROUGH)\\b', ['PERFORM', 'THRU', 'THROUGH']],
    ['^(a|bc)$', ['bc']],
    ['^plain$', []],
  ])('reads the alternatives of /%s/', (pattern, expected) => {
    expect(regexWords(pattern)).toEqual(expected);
  });
});

describe('bestFit', () => {
  const table = (id: string, ...values: string[]): ProductionTable => ({
    id,
    values: new Set(values.map(stringKey)),
  });

  it.each([
    [
      'the table holding more of the test literals',
      [table('small', 'a', 'b'), table('big', 'a', 'c', 'd', 'e')],
      ['a', 'b'],
      'small',
    ],
    [
      'the larger table on a tie',
      [table('small', 'a', 'b'), table('big', 'a', 'c', 'd')],
      ['a'],
      'big',
    ],
    [
      'the first table on a full tie',
      [table('one', 'a', 'b'), table('two', 'a', 'c')],
      ['a'],
      'one',
    ],
  ])('picks %s', (_label, tables, literals, expected) => {
    expect(bestFit(tables, stringKey('a'), literals.map(stringKey))).toBe(expected);
  });

  it('finds nothing when no table holds the value', () => {
    expect(bestFit([table('t', 'x', 'y')], stringKey('a'), [])).toBeNull();
  });

  it('keeps strings and numbers apart', () => {
    const numbers: ProductionTable = { id: 'n', values: new Set([numberKey(1), numberKey(2)]) };
    expect(bestFit([numbers], stringKey('1'), [])).toBeNull();
  });
});

describe('TableIndex', () => {
  const SOURCES: Record<string, string> = {
    'gitnexus/src/executed.ts': `export const A = ['Function', 'Class'];`,
    'gitnexus/src/near.ts': `export const B = ['Function', 'Class', 'Method'];`,
    'gitnexus/src/far.ts': `export const C = ['Interface', 'Enum'];`,
    'gitnexus/src/registry.ts': `export const R = [{ exts: ['.rs', '.go'] }, { exts: ['.py'] }];`,
    'gitnexus/src/limits.ts': `export const LIMIT = 2 * 50;`,
  };
  const index = (): TableIndex =>
    new TableIndex({
      read: (file) => SOURCES[file] ?? null,
      columnFiles: Object.keys(SOURCES),
    });

  it.each([
    ['an executed file first', 'Function', 'gitnexus/src/executed.ts#0'],
    ['the import closure next', 'Method', 'gitnexus/src/near.ts#0'],
    ['the property columns last', '.py', 'prop:exts'],
  ])('searches %s', (_label, value, expected) => {
    const search = { executed: ['gitnexus/src/executed.ts'], closure: ['gitnexus/src/near.ts'] };
    expect(index().tableOf(search, stringKey(value), [stringKey(value)])).toBe(expected);
  });

  it('never pools a table of a file outside the search', () => {
    const search = { executed: ['gitnexus/src/executed.ts'], closure: ['gitnexus/src/near.ts'] };
    expect(index().tableOf(search, stringKey('Interface'), [])).toBeNull();
  });

  it('merges the constants of the given files, folded initialisers included', () => {
    expect([...index().constantsOf(['gitnexus/src/limits.ts'])].sort((a, b) => a - b)).toEqual([
      2, 50, 100,
    ]);
  });

  it('reads the string values of the given files', () => {
    expect([...index().stringValues(['gitnexus/src/far.ts'])].sort()).toEqual([
      'Enum',
      'Interface',
    ]);
  });

  it('treats an unreadable file as empty', () => {
    expect(index().factsOf('gitnexus/src/missing.ts').tables).toEqual([]);
  });
});
