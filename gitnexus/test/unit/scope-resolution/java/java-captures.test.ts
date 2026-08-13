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

/** All synthesized inheritance references in `src`, reduced to lookup names. */
function inheritanceRefs(src: string): string[] {
  return emitJavaScopeCaptures(src, 'C.java')
    .filter((m) => m['@reference.inherits'] !== undefined)
    .flatMap((m) => m['@reference.name']?.text ?? [])
    .sort();
}

function recordAccessorDeclarations(src: string) {
  return emitJavaScopeCaptures(src, 'C.java')
    .filter((m) => m['@declaration.method'] !== undefined)
    .map((m) => ({
      name: m['@declaration.name']?.text,
      arity: m['@declaration.parameter-count']?.text,
      requiredArity: m['@declaration.required-parameter-count']?.text,
      returnType: m['@declaration.return-type']?.text,
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

describe('emitJavaScopeCaptures — record and enum interface heritage (#2900, #2918)', () => {
  it('captures simple, generic, and qualified record interfaces by lookup name', () => {
    const refs = inheritanceRefs(
      'record User(int id) implements Named, Comparable<User>, audit.Auditable {}',
    );

    expect(refs).toEqual(['Auditable', 'Comparable', 'Named']);
  });

  it('captures simple, generic, and qualified enum interfaces by lookup name', () => {
    const refs = inheritanceRefs(
      'enum Status implements Named, Tagged<Status>, audit.Auditable { ACTIVE }',
    );

    expect(refs).toEqual(['Auditable', 'Named', 'Tagged']);
  });

  it('unwraps type-use annotations on enum interface names', () => {
    const refs = inheritanceRefs(
      'enum Status implements @Marker Named, @Marker Tagged<Status>, audit.@Marker Auditable { ACTIVE }',
    );

    expect(refs).toEqual(['Auditable', 'Named', 'Tagged']);
  });

  it.each([
    ['class extends', 'class Child extends @Marker Base {}', ['Base']],
    ['class implements', 'class Child implements @Marker Named {}', ['Named']],
    ['record implements', 'record Child(int id) implements @Marker Named {}', ['Named']],
    ['interface extends', 'interface Child extends @Marker Named {}', ['Named']],
  ])('unwraps type-use annotations for %s', (_label, source, expected) => {
    expect(inheritanceRefs(source)).toEqual(expected);
  });

  it('does not emit an empty inheritance name from a torn annotated base', () => {
    expect(inheritanceRefs('enum Status implements @Marker {')).toEqual([]);
  });

  it('preserves the enum constant-body link while adding enum interface heritage', () => {
    expect(
      inheritanceRefs(
        'enum Status implements Named { ACTIVE { public String label() { return "active"; } } }',
      ),
    ).toEqual(['Named', 'Status']);
  });
});

describe('emitJavaScopeCaptures — record component accessors (#2917)', () => {
  it('synthesizes zero-argument declarations with full generic return types', () => {
    expect(
      recordAccessorDeclarations('record User(String name, java.util.List<String> tags) {}'),
    ).toEqual([
      { name: 'name', arity: '0', requiredArity: '0', returnType: 'String' },
      {
        name: 'tags',
        arity: '0',
        requiredArity: '0',
        returnType: 'java.util.List<String>',
      },
    ]);
  });

  it('uses the array return type for a varargs component accessor', () => {
    expect(recordAccessorDeclarations('record Samples(String... values) {}')).toEqual([
      { name: 'values', arity: '0', requiredArity: '0', returnType: 'String[]' },
    ]);
  });

  it('does not duplicate an explicit canonical accessor', () => {
    const declarations = recordAccessorDeclarations(
      'record User(String name) { public String name(/* canonical */) { return name; } }',
    );

    expect(declarations.filter((declaration) => declaration.name === 'name')).toHaveLength(1);
  });

  it('does not count an explicit accessor receiver parameter toward arity', () => {
    const declarations = recordAccessorDeclarations(
      'record User(String name) { public String name(User this) { return name; } }',
    );

    expect(declarations.filter((declaration) => declaration.name === 'name')).toEqual([
      expect.objectContaining({ arity: '0', requiredArity: '0' }),
    ]);
  });

  it('keeps an overload alongside the implicit zero-argument accessor', () => {
    const declarations = recordAccessorDeclarations(
      'record User(String name) { public String name(int repeat) { return name; } }',
    ).filter((declaration) => declaration.name === 'name');

    expect(declarations.map((declaration) => declaration.arity).sort()).toEqual(['0', '1']);
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

  it('unwraps an annotated superclass for explicit `super(...)`', () => {
    const refs = ctorRefs('class C extends @Marker Base { C() { super(); } }');
    expect(refs.some((r) => r.name === 'Base' && r.arity === '0')).toBe(true);
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

describe('emitJavaScopeCaptures — callable-flow protocol methods (#2522 review)', () => {
  function invokeFactsFor(src: string): number {
    return emitJavaScopeCaptures(src, 'C.java').filter(
      (m) => m['@callable-flow.invoke'] !== undefined,
    ).length;
  }

  it('does not emit invoke facts for ordinary container accessors', () => {
    const src = `
import java.util.HashMap;
class C {
  static Object entry(HashMap<String, Object> map) {
    return map.get("x");
  }
}
`;
    expect(invokeFactsFor(src)).toBe(0);
  });

  it('still emits invoke facts for functional-interface dispatch', () => {
    const src = `
class C {
  static void invoke(Runnable callback) { callback.run(); }
}
`;
    expect(invokeFactsFor(src)).toBe(1);
  });
});

describe('emitJavaScopeCaptures — local-type identities (#2562)', () => {
  it('uses the source-type-relative identity for the definition and the simple lexical binding', () => {
    const matches = emitJavaScopeCaptures(
      'class Outer { void m() { class Local {} new Local(); } }',
      'Outer.java',
    );
    const local = matches.find((m) => m['@declaration.name']?.text === 'Outer$1Local');

    expect(local?.['@declaration.binding-name']?.text).toBe('Local');
  });

  it('leaves non-local class declarations unchanged', () => {
    const matches = emitJavaScopeCaptures('class Outer { class Member {} }', 'Outer.java');
    const member = matches.find((m) => m['@declaration.name']?.text === 'Member');

    expect(member?.['@declaration.binding-name']).toBeUndefined();
  });

  it('recognizes a local class inside a record compact constructor', () => {
    const matches = emitJavaScopeCaptures(
      'record R(int x) { R { class Local {} new Runnable() {}; } }',
      'R.java',
    );
    const names = matches.flatMap((m) => m['@declaration.name']?.text ?? []);

    expect(names).toContain('R$1Local');
    expect(names).toContain('R$1');
  });

  it('uses javac-compatible independent sequences for anonymous and named local types', () => {
    const matches = emitJavaScopeCaptures(
      `class Outer {
         void first() {
           new Runnable() {};
           class Local {}
           class Other {}
           new Runnable() {};
         }
         void second() { class Local {} }
       }`,
      'Outer.java',
    );
    const names = matches.flatMap((m) => m['@declaration.name']?.text ?? []);

    expect(names).toEqual(
      expect.arrayContaining([
        'Outer$1',
        'Outer$2',
        'Outer$1Local',
        'Outer$2Local',
        'Outer$1Other',
      ]),
    );
  });

  it('synthesizes every legal local type kind with its lexical binding name', () => {
    const matches = emitJavaScopeCaptures(
      `class Outer {
         void types() {
           class C {}
           enum E { A }
           record R(int x) {}
           interface I { void run(); }
         }
       }`,
      'Outer.java',
    );

    for (const [tag, identityName, bindingName] of [
      ['@declaration.class', 'Outer$1C', 'C'],
      ['@declaration.enum', 'Outer$1E', 'E'],
      ['@declaration.record', 'Outer$1R', 'R'],
      ['@declaration.interface', 'Outer$1I', 'I'],
    ] as const) {
      const declaration = matches.find(
        (match) => match[tag] !== undefined && match['@declaration.name']?.text === identityName,
      );
      expect(declaration?.['@declaration.binding-name']?.text).toBe(bindingName);
    }
  });

  it('detects local types from block position in initializers, lambdas, and anonymous bodies', () => {
    const matches = emitJavaScopeCaptures(
      `class Outer {
         static { class StaticLocal {} }
         { record InstanceLocal(int x) {} }
         Runnable task = () -> { interface LambdaLocal {} };
         Runnable anon = new Runnable() {
           { enum AnonymousLocal { A } }
           public void run() {}
         };
       }`,
      'Outer.java',
    );
    const names = matches.flatMap((match) => match['@declaration.name']?.text ?? []);

    expect(names).toEqual(
      expect.arrayContaining([
        'Outer$1StaticLocal',
        'Outer$1InstanceLocal',
        'Outer$1LambdaLocal',
        'Outer$1$1AnonymousLocal',
      ]),
    );
  });

  it('emits declaration-to-block visibility scopes for local types', () => {
    const matches = emitJavaScopeCaptures(
      `class Outer {
         void blocks() {
           new Local();
           class Local {}
           new Local();
         }
       }`,
      'Outer.java',
    );
    const local = matches.find((match) => match['@declaration.name']?.text === 'Outer$1Local');
    const visibility = matches.find(
      (match) =>
        match['@scope.block']?.range.startLine === local?.['@declaration.class']?.range.startLine,
    );

    expect(visibility?.['@scope.block']?.range.endLine).toBe(6);
  });
});
