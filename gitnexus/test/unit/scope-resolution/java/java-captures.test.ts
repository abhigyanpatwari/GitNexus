/**
 * Low-level coverage for the Java scope-captures orchestrator
 * (`emitJavaScopeCaptures`), focused on the #1928 parsing-layer fixes:
 *
 *   - F35: qualified / qualified-generic constructor calls bind the simple-name
 *          tail as @reference.name (not the raw `pkg.Foo` text).
 *   - F38: `super(...)` / `this(...)` explicit constructor invocations are
 *          captured as @reference.call.constructor references with arity.
 *
 * Runs against the installed tree-sitter-java grammar so it catches grammar
 * drift before the integration parity gate.
 */

import { describe, it, expect } from 'vitest';
import { emitJavaScopeCaptures } from '../../../../src/core/ingestion/languages/java/captures.js';

function wrapExpr(expr: string): string {
  return `class C { void m() { ${expr}; } }`;
}

/** All constructor-call matches in `src`, as `{ name, qualified, arity }`. */
function ctorRefs(src: string) {
  return emitJavaScopeCaptures(src, 'C.java')
    .filter((m) => m['@reference.call.constructor'] !== undefined)
    .map((m) => ({
      name: m['@reference.name']?.text,
      qualified: m['@reference.call.constructor.qualified']?.text,
      arity: m['@reference.arity']?.text,
    }));
}

describe('emitJavaScopeCaptures — constructor reference names (F35 #1928)', () => {
  it('binds the simple name for an unqualified `new User()`', () => {
    const refs = ctorRefs(wrapExpr('new User()'));
    expect(refs).toContainEqual({ name: 'User', qualified: undefined, arity: '0' });
  });

  it('binds the simple-name tail for a qualified `new pkg.Foo()`', () => {
    const refs = ctorRefs(wrapExpr('new pkg.Foo()'));
    const foo = refs.find((r) => r.name === 'Foo');
    expect(foo).toBeDefined();
    expect(foo!.qualified).toBe('pkg.Foo');
    // The name must be the bare tail, never the raw scoped text.
    expect(refs.some((r) => r.name === 'pkg.Foo')).toBe(false);
  });

  it('binds the simple-name tail for a deeply-nested `new a.b.Foo()`', () => {
    const refs = ctorRefs(wrapExpr('new a.b.Foo()'));
    const foo = refs.find((r) => r.name === 'Foo');
    expect(foo).toBeDefined();
    expect(foo!.qualified).toBe('a.b.Foo');
    expect(refs.some((r) => r.name === 'a' || r.name === 'b')).toBe(false);
  });

  it('binds the simple name for a simple-generic `new Box<String>()`', () => {
    const refs = ctorRefs(wrapExpr('new Box<String>()'));
    const box = refs.find((r) => r.name === 'Box');
    expect(box).toBeDefined();
    expect(box!.qualified).toBeUndefined();
  });

  it('binds the simple-name tail for a qualified-generic `new pkg.Box<String>()`', () => {
    const refs = ctorRefs(wrapExpr('new pkg.Box<String>()'));
    const box = refs.find((r) => r.name === 'Box');
    expect(box).toBeDefined();
    expect(box!.qualified).toBe('pkg.Box');
    expect(refs.some((r) => r.name === 'pkg.Box' || r.name === 'String')).toBe(false);
  });

  it('carries the argument arity on a qualified constructor call', () => {
    const refs = ctorRefs(wrapExpr('new pkg.Foo(1, 2, 3)'));
    const foo = refs.find((r) => r.name === 'Foo');
    expect(foo!.arity).toBe('3');
  });

  it('emits exactly one constructor reference per `new` expression', () => {
    // Regression guard: the qualified + qualified-generic arms must not
    // double-match the plain/generic arms.
    expect(ctorRefs(wrapExpr('new pkg.Foo()')).length).toBe(1);
    expect(ctorRefs(wrapExpr('new pkg.Box<String>()')).length).toBe(1);
    expect(ctorRefs(wrapExpr('new a.b.Foo()')).length).toBe(1);
  });
});

describe('emitJavaScopeCaptures — explicit constructor invocations (F38 #1928)', () => {
  it('captures `super(...)` as a constructor ref to the superclass simple name', () => {
    const src = 'class C extends pkg.Base { C() { super(1, 2); } }';
    const refs = ctorRefs(src);
    const sup = refs.find((r) => r.name === 'Base');
    expect(sup).toBeDefined();
    expect(sup!.arity).toBe('2');
  });

  it('reduces a generic superclass `super(...)` target to the bare name', () => {
    const src = 'class C extends Box<String> { C() { super(); } }';
    const refs = ctorRefs(src);
    expect(refs.some((r) => r.name === 'Box' && r.arity === '0')).toBe(true);
  });

  it('captures `this(...)` as a constructor ref to the enclosing class name', () => {
    const src = 'class C { C() { this(1); } C(int x) {} }';
    const refs = ctorRefs(src);
    const self = refs.find((r) => r.name === 'C' && r.arity === '1');
    expect(self).toBeDefined();
  });

  it('does NOT synthesize a super ref when there is no explicit superclass', () => {
    // Implicit `Object` super — no in-graph symbol, so no reference is emitted.
    const src = 'class C { C() { super(); } }';
    const refs = ctorRefs(src);
    expect(refs.length).toBe(0);
  });

  it('captures `this(...)` inside an enum constructor', () => {
    const src = 'enum E { A; E() { this(1); } E(int x) {} }';
    const refs = ctorRefs(src);
    expect(refs.some((r) => r.name === 'E' && r.arity === '1')).toBe(true);
  });
});
