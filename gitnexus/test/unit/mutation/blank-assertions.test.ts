/**
 * Locks the `as` assertion blanking of the mutation prepare step (KTD7): every
 * `TSAsExpression` is replaced by spaces of equal length so line and column positions are
 * unchanged, and a file is accepted only when its blanked AST equals the original AST with
 * every assertion unwrapped.
 */
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { blankAssertions, blankScope } from '../../../tools/mutation/prepare/blank-assertions.js';

const spaces = (text: string): string => ' '.repeat(text.length);
/** The blanked text of a source that must pass the AST-equality check. */
const blankedText = (source: string): string => {
  const result = blankAssertions(source);
  assert.ok(result.ok, 'expected the AST-equality check to pass');
  return result.text;
};

describe('blankAssertions: equal-length blanking', () => {
  it('blanks `as const` and keeps `]` and `;` at their original columns', () => {
    const source = "const T = ['a', 'b'] as const;";
    const text = blankedText(source);

    expect(blankAssertions(source)).toEqual({
      ok: true,
      assertions: 1,
      text: `const T = ['a', 'b']${spaces(' as const')};`,
    });
    expect([text.length, text.indexOf(']'), text.indexOf(';')]).toEqual([
      source.length,
      source.indexOf(']'),
      source.indexOf(';'),
    ]);
  });

  it('keeps `satisfies` and blanks only the `as const` it wraps', () => {
    const source = 'const T = [1, 2] as const satisfies Record<string, number>;';

    expect(blankAssertions(source)).toEqual({
      ok: true,
      assertions: 1,
      text: `const T = [1, 2]${spaces(' as const')} satisfies Record<string, number>;`,
    });
  });

  it('blanks both assertions of a nested `x as unknown as T`', () => {
    expect(blankAssertions('const y = x as unknown as T;')).toEqual({
      ok: true,
      assertions: 2,
      text: `const y = x${spaces(' as unknown as T')};`,
    });
  });

  it('keeps the newlines of a multi-line asserted type so later lines keep their numbers', () => {
    const source = [
      'const v = x as {',
      '  a: string;',
      '  b: number;',
      '};',
      'const after = 1;',
    ].join('\n');

    expect(blankedText(source).split('\n')).toEqual([
      `const v = x${spaces(' as {')}`,
      spaces('  a: string;'),
      spaces('  b: number;'),
      ' ;',
      'const after = 1;',
    ]);
  });

  it('keeps CRLF line endings inside a blanked type', () => {
    expect(blankAssertions('const v = x as {\r\n  a: 1 };\r\nf();')).toEqual({
      ok: true,
      assertions: 1,
      text: `const v = x${spaces(' as {')}\r\n${spaces('  a: 1 }')};\r\nf();`,
    });
  });

  it('keeps the non-null `!` operator', () => {
    expect(blankAssertions('const n = (m as M)!.k;')).toEqual({
      ok: true,
      assertions: 1,
      text: `const n = (m${spaces(' as M')})!.k;`,
    });
  });

  it('keeps the parentheses around a parenthesised operand and a parenthesised type', () => {
    expect(blankAssertions("const p = (['a']) as const, q = x as (A | B);")).toEqual({
      ok: true,
      assertions: 2,
      text: `const p = (['a'])${spaces(' as const')}, q = x${spaces(' as (A | B)')};`,
    });
  });

  it('blanks a comment that sits inside the assertion', () => {
    expect(blankAssertions('const c = x as /* why */ T;')).toEqual({
      ok: true,
      assertions: 1,
      text: `const c = x${spaces(' as /* why */ T')};`,
    });
  });
});

describe('blankAssertions: AST-equality check', () => {
  it.each([
    [
      'a parenthesised member access',
      'const b = (a as T).b;',
      `const b = (a${spaces(' as T')}).b;`,
    ],
    ['an arrow body', 'const f = () => x as T;', `const f = () => x${spaces(' as T')};`],
    ['an assignment target', '(x as T) = y;', `(x${spaces(' as T')}) = y;`],
  ])('accepts %s', (_label, source, text) => {
    expect(blankAssertions(source)).toEqual({ ok: true, assertions: 1, text });
  });

  it.each([
    ['operator precedence', 'const r = a + b as T * c;'],
    ['a next line starting with `(` after no semicolon', 'const f = g as Fn\n(h as H).call();'],
    ['a next line starting with `[` after no semicolon', 'const a = b as B\n[1].forEach(f);'],
    ['a next line starting with a template literal', 'const s = t as Tag\n`x`;'],
  ])('rejects blanking that changes the tree: %s', (_label, source) => {
    expect(blankAssertions(source)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^AST differs/),
    });
  });

  it('rejects a source that does not parse', () => {
    expect(blankAssertions('const = ;')).toMatchObject({
      ok: false,
      assertions: 0,
      reason: expect.stringMatching(/^original does not parse/),
    });
  });
});

describe('blankAssertions: files without `as` assertions', () => {
  it.each([
    ['plain code', 'export function f(a: number): number {\n  return a + 1;\n}\n'],
    ['`satisfies` and non-null `!` only', 'const c = { a: 1 } satisfies R;\nconst n = m!.k;\n'],
    [
      '`as` in strings, comments and import renames',
      "import { a as b } from 'm';\n// x as y\nconst s = 'p as q';\n",
    ],
    ['an angle-bracket assertion', 'const n = <number>v;\n'],
  ])('leaves %s byte-identical', (_label, source) => {
    expect(blankAssertions(source)).toEqual({ ok: true, assertions: 0, text: source });
  });
});

describe('blankScope', () => {
  it('reports a file that fails the AST check instead of writing it', () => {
    const scope = blankScope([
      { path: 'gitnexus/src/good.ts', source: 'export const T = [1] as const;\n' },
      { path: 'gitnexus/src/bad.ts', source: 'export const r = a + b as T * c;\n' },
    ]);

    expect(scope.written).toEqual([
      {
        path: 'gitnexus/src/good.ts',
        assertions: 1,
        text: `export const T = [1]${spaces(' as const')};\n`,
      },
    ]);
    expect(scope.failed).toEqual([
      { path: 'gitnexus/src/bad.ts', reason: expect.stringMatching(/^AST differs/) },
    ]);
  });

  it('writes a file with no assertions unchanged', () => {
    const source = 'export const x = 1;\n';

    expect(blankScope([{ path: 'gitnexus/src/plain.ts', source }])).toEqual({
      written: [{ path: 'gitnexus/src/plain.ts', assertions: 0, text: source }],
      failed: [],
    });
  });
});
