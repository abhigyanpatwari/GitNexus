/**
 * Coverage for the JavaScript scope-captures orchestrator, focused on the
 * #1876 array-method-callback narrowing.
 *
 * `const x = arr.map(a => …)` must NOT produce a `@declaration.function`
 * named `x` (the binding holds a value, not a callable) — only the
 * `@declaration.const`. Identifier-callee HOCs (`forwardRef`, `useMemo`)
 * and direct arrow assignments keep their `@declaration.function`.
 *
 * Runs against tree-sitter-javascript so it catches grammar drift before
 * the integration parity gate.
 */

import { describe, it, expect } from 'vitest';
import { emitJsScopeCaptures } from '../../../../src/core/ingestion/languages/javascript/captures.js';

function matchesFor(src: string) {
  return emitJsScopeCaptures(src, 'test.js');
}

/** True when some match carries `tag` and its @declaration.name is `name`. */
function hasDecl(src: string, tag: string, name: string): boolean {
  return matchesFor(src).some((m) => m[tag] !== undefined && m['@declaration.name']?.text === name);
}

/** Count matches carrying `tag` (any name). */
function countTag(src: string, tag: string): number {
  return matchesFor(src).filter((m) => m[tag] !== undefined).length;
}

describe('emitJsScopeCaptures — #1876 array-method-callback narrowing', () => {
  it('does not emit @declaration.function for `const x = arr.map(a => …)`', () => {
    const src = 'const exportData = accountsList.map(account => ({ id: account.id }));';
    expect(hasDecl(src, '@declaration.const', 'exportData')).toBe(true);
    expect(hasDecl(src, '@declaration.function', 'exportData')).toBe(false);
    // Exactly one binding-bearing declaration for the name.
    expect(countTag(src, '@declaration.function')).toBe(0);
  });

  // Every method in ARRAY_CALLBACK_METHODS except `map` (covered above).
  it.each([
    'filter',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'reduce',
    'reduceRight',
    'forEach',
    'some',
    'every',
    'flatMap',
    'sort',
  ])('suppresses the Function def for array method .%s()', (method) => {
    const src = `const x = arr.${method}((a) => a);`;
    expect(hasDecl(src, '@declaration.function', 'x')).toBe(false);
    expect(hasDecl(src, '@declaration.const', 'x')).toBe(true);
  });

  it('keeps @declaration.function for an identifier-callee HOC (forwardRef)', () => {
    const src = 'const Button = forwardRef((props, ref) => null);';
    expect(hasDecl(src, '@declaration.function', 'Button')).toBe(true);
  });

  it('keeps @declaration.function for useMemo (identifier callee, unchanged this round)', () => {
    const src = 'const value = useMemo(() => compute(), []);';
    expect(hasDecl(src, '@declaration.function', 'value')).toBe(true);
  });

  it('keeps dual classification for a direct arrow `const fn = () => {}`', () => {
    const src = 'const fn = () => { doThing(); };';
    expect(hasDecl(src, '@declaration.function', 'fn')).toBe(true);
    expect(hasDecl(src, '@declaration.const', 'fn')).toBe(true);
  });

  it('keeps @declaration.function for a non-array fluent-API member call (accepted limitation)', () => {
    const src = 'const q = qb.where((row) => row.ok);';
    expect(hasDecl(src, '@declaration.function', 'q')).toBe(true);
  });

  it('suppresses an in-set method name on a NON-array receiver (accepted receiver-blind limitation)', () => {
    // The predicate keys on the method NAME only, never the receiver type —
    // tree-sitter has no type info. So `.map` on an RxJS observable (or
    // Map/Set `.forEach`, a query builder `.sort`, a lodash chain `.filter`)
    // is also treated as a callback and loses its Function def. Accepted: the
    // binding holds the call's result value, so a value def is correct anyway.
    const src = 'const stream = source$.map((event) => handle(event));';
    expect(hasDecl(src, '@declaration.function', 'stream')).toBe(false);
    expect(hasDecl(src, '@declaration.const', 'stream')).toBe(true);
  });

  it('suppresses the outer .map() callback in a chained array call', () => {
    const src = 'const x = arr.filter((a) => a).map((b) => b);';
    expect(hasDecl(src, '@declaration.function', 'x')).toBe(false);
    expect(hasDecl(src, '@declaration.const', 'x')).toBe(true);
  });

  it('suppresses through an export_statement wrapper', () => {
    const src = 'export const x = arr.map((a) => a);';
    expect(hasDecl(src, '@declaration.function', 'x')).toBe(false);
    expect(hasDecl(src, '@declaration.const', 'x')).toBe(true);
  });

  it('suppresses a function_expression callback', () => {
    const src = 'const x = arr.map(function (a) { return a; });';
    expect(hasDecl(src, '@declaration.function', 'x')).toBe(false);
    expect(hasDecl(src, '@declaration.const', 'x')).toBe(true);
  });

  it('suppresses an optional-chained array call `arr?.map(...)`', () => {
    const src = 'const x = arr?.map((a) => a);';
    expect(hasDecl(src, '@declaration.function', 'x')).toBe(false);
  });

  it('suppresses a parenthesized callee `(arr.map)(cb)`', () => {
    const src = 'const x = (arr.map)((a) => a);';
    expect(hasDecl(src, '@declaration.function', 'x')).toBe(false);
  });

  it('suppresses a computed callee `arr["map"](cb)`', () => {
    const src = 'const x = arr["map"]((a) => a);';
    expect(hasDecl(src, '@declaration.function', 'x')).toBe(false);
  });

  it('suppresses export-default array-method wrappers', () => {
    const src = 'export default arr.map((a) => a);';
    expect(countTag(src, '@declaration.function')).toBe(0);
  });

  it('suppresses obvious built-in callback wrappers in export default', () => {
    const src = 'export default setTimeout(() => work());';
    expect(countTag(src, '@declaration.function')).toBe(0);
  });

  it('rewrites export-default HOC names to the file stem', () => {
    const matches = emitJsScopeCaptures(
      'export default React.memo((props) => props);',
      'routes/health-check.jsx',
    );
    expect(
      matches.some(
        (m) =>
          m['@declaration.function'] !== undefined &&
          m['@declaration.name']?.text === 'health-check',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSX-element-as-call-argument arity (#1956 tri-review U3): a JSX component used
// as a call argument, e.g. `render(<Foo a={1} b={2} />)`, must NOT inherit the
// enclosing call's arity. The JSX element is itself a `@reference.call.*` anchor;
// the call-arity walk-up would ascend from it into the enclosing call_expression
// and mis-attribute that call's arity. An early guard skips arity synthesis when
// the call anchor is a JSX element (restoring the pre-#1951 range-based behavior).
// ---------------------------------------------------------------------------

/** Arity text for the call-site match whose callee `@reference.name` is `name`;
 *  `'NONE'` when no such call-site match exists, `undefined` when it exists with
 *  no `@reference.arity`. */
function callArity(src: string, name: string, file = 'test.jsx'): string | undefined | 'NONE' {
  const matches = emitJsScopeCaptures(src, file).filter(
    (m) =>
      Object.keys(m).some((k) => k.startsWith('@reference.call')) &&
      m['@reference.name']?.text === name,
  );
  if (matches.length === 0) return 'NONE';
  return matches[0]['@reference.arity']?.text;
}

describe('emitJsScopeCaptures — JSX-as-call-arg arity (#1956 U3)', () => {
  it('does not attribute the enclosing call arity to a JSX component reference', () => {
    const src = 'render(<Foo a={1} b={2} />);';
    // The Foo JSX component ref must carry NO arity (was wrongly 1 before the fix).
    expect(callArity(src, 'Foo')).toBeUndefined();
    // The enclosing render() call keeps its real arity (1 argument: the element).
    expect(callArity(src, 'render')).toBe('1');
  });

  it('keeps arity on a plain (non-JSX) call (regression guard)', () => {
    expect(callArity('foo(1, 2);', 'foo', 'test.js')).toBe('2');
  });

  it('emits no arity for a standalone JSX element not used as a call argument', () => {
    expect(callArity('const x = <Foo />;', 'Foo')).toBeUndefined();
  });
});
