/**
 * Low-level coverage for `emitCsharpScopeCaptures`, focused on the C# analogs of
 * the Java #1928 parsing-layer fixes:
 *
 *   - F35: qualified / qualified-generic constructor calls bind the simple-name
 *          tail as @reference.name (not the raw `Ns.Foo` text).
 *   - F38: `: base(...)` / `: this(...)` constructor initializers are captured as
 *          @reference.call.constructor references with arity.
 */
import { describe, it, expect } from 'vitest';
import { emitCsharpScopeCaptures } from '../../../../src/core/ingestion/languages/csharp/captures.js';

function ctorRefs(src: string) {
  return emitCsharpScopeCaptures(src, 'C.cs')
    .filter((m) => m['@reference.call.constructor'] !== undefined)
    .map((m) => ({
      name: m['@reference.name']?.text,
      qualified: m['@reference.call.constructor.qualified']?.text,
      qualifiedName: m['@reference.qualified-name']?.text,
      arity: m['@reference.arity']?.text,
    }));
}

const wrap = (expr: string) => `class C { void M() { ${expr} } }`;

describe('emitCsharpScopeCaptures — qualified constructor names (F35)', () => {
  it('binds the simple name for an unqualified `new Foo()`', () => {
    expect(ctorRefs(wrap('var x = new Foo();'))).toContainEqual({
      name: 'Foo',
      qualified: undefined,
      arity: '0',
    });
  });

  it('binds the simple-name tail for a qualified `new Ns.Foo()`', () => {
    const refs = ctorRefs(wrap('var x = new Ns.Foo();'));
    const foo = refs.find((r) => r.name === 'Foo');
    expect(foo).toBeDefined();
    expect(foo!.qualified).toBe('Ns.Foo');
    expect(foo!.qualifiedName).toBe('Ns.Foo');
    expect(refs.some((r) => r.name === 'Ns.Foo' || r.name === 'Ns')).toBe(false);
  });

  it('binds the simple-name tail for a deeply-nested `new A.B.Foo()`', () => {
    const refs = ctorRefs(wrap('var x = new A.B.Foo();'));
    expect(refs.find((r) => r.name === 'Foo')!.qualified).toBe('A.B.Foo');
    expect(refs.some((r) => ['A', 'B', 'A.B.Foo'].includes(r.name as string))).toBe(false);
  });

  it('binds the simple-name tail for a qualified-generic `new Ns.Box<int>()`', () => {
    const refs = ctorRefs(wrap('var x = new Ns.Box<int>();'));
    const box = refs.find((r) => r.name === 'Box');
    expect(box).toBeDefined();
    expect(box!.qualified).toBe('Ns.Box<int>');
    expect(refs.some((r) => r.name === 'Ns.Box' || r.name === 'int')).toBe(false);
  });

  it('binds the simple name for an unqualified generic `new Box<int>()`', () => {
    const refs = ctorRefs(wrap('var x = new Box<int>();'));
    expect(refs.find((r) => r.name === 'Box')).toBeDefined();
  });

  it('carries argument arity on a qualified constructor call', () => {
    expect(
      ctorRefs(wrap('var x = new Ns.Foo(1, 2, 3);')).find((r) => r.name === 'Foo')!.arity,
    ).toBe('3');
  });

  it('emits exactly one constructor reference per `new` expression', () => {
    expect(ctorRefs(wrap('var x = new Ns.Foo();')).length).toBe(1);
    expect(ctorRefs(wrap('var x = new Ns.Box<int>();')).length).toBe(1);
    expect(ctorRefs(wrap('var x = new A.B.Foo();')).length).toBe(1);
  });

  it('binds the tail for an alias-qualified `new MyAlias::Foo()`', () => {
    const refs = ctorRefs(wrap('var x = new MyAlias::Foo();'));
    expect(refs.find((r) => r.name === 'Foo')).toBeDefined();
    expect(refs.length).toBe(1);
  });

  it('binds the tail for `new global::Foo()`', () => {
    expect(
      ctorRefs(wrap('var x = new global::Foo();')).find((r) => r.name === 'Foo'),
    ).toBeDefined();
  });

  it('binds the tail for an alias-then-qualified `new global::Ns.Foo()`', () => {
    const refs = ctorRefs(wrap('var x = new global::Ns.Foo();'));
    expect(refs.find((r) => r.name === 'Foo')).toBeDefined();
    expect(refs.some((r) => r.name === 'Ns' || r.name === 'global')).toBe(false);
  });
});

describe('emitCsharpScopeCaptures — constructor initializers (F38)', () => {
  it('captures `: base(...)` as a ref to the base type with arity', () => {
    const refs = ctorRefs('class Child : Base { public Child() : base(1, 2) {} }');
    const baseRef = refs.find((r) => r.name === 'Base');
    expect(baseRef).toBeDefined();
    expect(baseRef!.arity).toBe('2');
  });

  it('reduces a generic / qualified base `: base(...)` target to the bare name', () => {
    expect(
      ctorRefs('class Child : Pkg.Base<int> { public Child() : base() {} }').some(
        (r) => r.name === 'Base' && r.arity === '0',
      ),
    ).toBe(true);
  });

  it('captures `: this(...)` as a ref to the enclosing type', () => {
    const refs = ctorRefs('class C { public C() : this(1) {} public C(int x) {} }');
    expect(refs.find((r) => r.name === 'C' && r.arity === '1')).toBeDefined();
  });

  it('captures `: this(...)` inside a struct', () => {
    const refs = ctorRefs('struct S { public S(int x) : this() {} public S() {} }');
    expect(refs.some((r) => r.name === 'S' && r.arity === '0')).toBe(true);
  });

  it('captures `: this(...)` inside a record', () => {
    const refs = ctorRefs('record R { public R(int x) : this() {} public R() {} }');
    expect(refs.some((r) => r.name === 'R' && r.arity === '0')).toBe(true);
  });

  it('targets the base CLASS (always first per C# rules) in a mixed base list', () => {
    // `class C : Base, IFoo` — C# requires the base class first, before any
    // interfaces, so the first base-list entry is the correct `base(...)` target.
    const refs = ctorRefs('class C : Base, IFoo { public C() : base() {} }');
    expect(refs.some((r) => r.name === 'Base' && r.arity === '0')).toBe(true);
    expect(refs.some((r) => r.name === 'IFoo')).toBe(false);
  });

  it('does NOT synthesize a base ref when the class has no base list', () => {
    // (Not valid C#, but the synth must be defensive: no base_list → no target.)
    expect(ctorRefs('class C { public C() {} }').length).toBe(0);
  });
});
