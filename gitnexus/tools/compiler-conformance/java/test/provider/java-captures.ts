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

import { compareCodeUnits } from '../../../compare.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { emitJavaScopeCaptures } from '../../../../../src/core/ingestion/languages/java/captures.js';

describe('Java invocation classification', () => {
  it('does not also emit free references for qualified member calls', () => {
    const source = new URL(
      '../../../../../test/fixtures/compiler-conformance/java-invocation-classification/Delivery.java',
      import.meta.url,
    );
    const captures = emitJavaScopeCaptures(readFileSync(source, 'utf8'), 'Delivery.java');
    assert.deepEqual(
      captures
        .filter((match) => match['@reference.call.free'])
        .map((match) => match['@reference.call.free']?.text),
      ['dispatch()'],
    );
    assert.deepEqual(
      captures
        .filter((match) => match['@reference.call.member'])
        .map((match) => match['@reference.receiver']?.text),
      ['courier', 'this', 'super'],
    );
  });
});

function wrapExpr(expr: string): string {
  return `class C { void m() { ${expr}; } }`;
}

/** All constructor-call matches in `src`, as `{ name, qualified, qualifiedName, arity }`. */
function ctorRefs(src: string) {
  return emitJavaScopeCaptures(src, 'C.java')
    .filter((m) => m['@reference.call.constructor'] !== undefined)
    .map((m) => ({
      name: m['@reference.name']?.text,
      qualified: m['@reference.call.constructor.qualified']?.text,
      qualifiedName: m['@reference.qualified-name']?.text,
      arity: m['@reference.arity']?.text,
    }));
}

/** All synthesized inheritance references in `src`, reduced to lookup names. */
function inheritanceRefs(src: string): string[] {
  return emitJavaScopeCaptures(src, 'C.java')
    .filter((m) => m['@reference.inherits'] !== undefined)
    .flatMap((m) => m['@reference.name']?.text ?? [])
    .sort(compareCodeUnits);
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
    assert.ok(
      refs.some((actual) =>
        isDeepStrictEqual(actual, {
          name: 'User',
          qualified: undefined,
          qualifiedName: undefined,
          arity: '0',
        }),
      ),
    );
  });

  it('binds the simple-name tail for a qualified `new pkg.Foo()`', () => {
    const refs = ctorRefs(wrapExpr('new pkg.Foo()'));
    const foo = refs.find((r) => r.name === 'Foo');
    assert.notEqual(foo, undefined);
    assert.equal(foo!.qualified, 'pkg.Foo');
    assert.equal(foo!.qualifiedName, 'pkg.Foo');
    // The name must be the bare tail, never the raw scoped text.
    assert.equal(
      refs.some((r) => r.name === 'pkg.Foo'),
      false,
    );
  });

  it('binds the simple-name tail for a deeply-nested `new a.b.Foo()`', () => {
    const refs = ctorRefs(wrapExpr('new a.b.Foo()'));
    const foo = refs.find((r) => r.name === 'Foo');
    assert.notEqual(foo, undefined);
    assert.equal(foo!.qualified, 'a.b.Foo');
    assert.equal(foo!.qualifiedName, 'a.b.Foo');
    assert.equal(
      refs.some((r) => r.name === 'a' || r.name === 'b'),
      false,
    );
  });

  it('binds the simple name for a simple-generic `new Box<String>()`', () => {
    const refs = ctorRefs(wrapExpr('new Box<String>()'));
    const box = refs.find((r) => r.name === 'Box');
    assert.notEqual(box, undefined);
    assert.equal(box!.qualified, undefined);
    assert.equal(box!.qualifiedName, undefined);
  });

  it('binds the simple-name tail for a qualified-generic `new pkg.Box<String>()`', () => {
    const refs = ctorRefs(wrapExpr('new pkg.Box<String>()'));
    const box = refs.find((r) => r.name === 'Box');
    assert.notEqual(box, undefined);
    assert.equal(box!.qualified, 'pkg.Box');
    assert.equal(box!.qualifiedName, 'pkg.Box');
    assert.equal(
      refs.some((r) => r.name === 'pkg.Box' || r.name === 'String'),
      false,
    );
  });

  it('carries the argument arity on a qualified constructor call', () => {
    const refs = ctorRefs(wrapExpr('new pkg.Foo(1, 2, 3)'));
    const foo = refs.find((r) => r.name === 'Foo');
    assert.equal(foo!.arity, '3');
  });

  it('emits exactly one constructor reference per `new` expression', () => {
    // Regression guard: the qualified + qualified-generic arms must not
    // double-match the plain/generic arms.
    assert.equal(ctorRefs(wrapExpr('new pkg.Foo()')).length, 1);
    assert.equal(ctorRefs(wrapExpr('new pkg.Box<String>()')).length, 1);
    assert.equal(ctorRefs(wrapExpr('new a.b.Foo()')).length, 1);
  });
});

describe('emitJavaScopeCaptures — record and enum interface heritage (#2900, #2918)', () => {
  it('captures simple, generic, and qualified record interfaces by lookup name', () => {
    const refs = inheritanceRefs(
      'record User(int id) implements Named, Comparable<User>, audit.Auditable {}',
    );

    assert.deepEqual(refs, ['Auditable', 'Comparable', 'Named']);
  });

  it('captures simple, generic, and qualified enum interfaces by lookup name', () => {
    const refs = inheritanceRefs(
      'enum Status implements Named, Tagged<Status>, audit.Auditable { ACTIVE }',
    );

    assert.deepEqual(refs, ['Auditable', 'Named', 'Tagged']);
  });

  it('unwraps type-use annotations on enum interface names', () => {
    const refs = inheritanceRefs(
      'enum Status implements @Marker Named, @Marker Tagged<Status>, audit.@Marker Auditable { ACTIVE }',
    );

    assert.deepEqual(refs, ['Auditable', 'Named', 'Tagged']);
  });

  for (const example of [
    ['class extends', 'class Child extends @Marker Base {}', ['Base']],
    ['class implements', 'class Child implements @Marker Named {}', ['Named']],
    ['record implements', 'record Child(int id) implements @Marker Named {}', ['Named']],
    ['interface extends', 'interface Child extends @Marker Named {}', ['Named']],
  ] as const) {
    it(`unwraps type-use annotations for ${example[0]}`, () => {
      const [_label, source, expected] = example;

      assert.deepEqual(inheritanceRefs(source), expected);
    });
  }

  it('does not emit an empty inheritance name from a torn annotated base', () => {
    assert.deepEqual(inheritanceRefs('enum Status implements @Marker {'), []);
  });

  it('preserves the enum constant-body link while adding enum interface heritage', () => {
    assert.deepEqual(
      inheritanceRefs(
        'enum Status implements Named { ACTIVE { public String label() { return "active"; } } }',
      ),
      ['Named', 'Status'],
    );
  });
});

describe('emitJavaScopeCaptures — record component accessors (#2917)', () => {
  it('synthesizes zero-argument declarations with full generic return types', () => {
    assert.deepEqual(
      recordAccessorDeclarations('record User(String name, java.util.List<String> tags) {}'),
      [
        { name: 'name', arity: '0', requiredArity: '0', returnType: 'String' },
        {
          name: 'tags',
          arity: '0',
          requiredArity: '0',
          returnType: 'java.util.List<String>',
        },
      ],
    );
  });

  it('uses the array return type for a varargs component accessor', () => {
    assert.deepEqual(recordAccessorDeclarations('record Samples(String... values) {}'), [
      { name: 'values', arity: '0', requiredArity: '0', returnType: 'String[]' },
    ]);
  });

  it('does not duplicate an explicit canonical accessor', () => {
    const declarations = recordAccessorDeclarations(
      'record User(String name) { public String name(/* canonical */) { return name; } }',
    );

    assert.equal(declarations.filter((declaration) => declaration.name === 'name').length, 1);
  });

  it('does not count an explicit accessor receiver parameter toward arity', () => {
    const declarations = recordAccessorDeclarations(
      'record User(String name) { public String name(User this) { return name; } }',
    );

    assert.deepEqual(
      declarations
        .filter((declaration) => declaration.name === 'name')
        .map(({ arity, requiredArity }) => ({ arity, requiredArity })),
      [{ arity: '0', requiredArity: '0' }],
    );
  });

  it('keeps an overload alongside the implicit zero-argument accessor', () => {
    const declarations = recordAccessorDeclarations(
      'record User(String name) { public String name(int repeat) { return name; } }',
    ).filter((declaration) => declaration.name === 'name');

    assert.deepEqual(declarations.map((declaration) => declaration.arity).sort(compareCodeUnits), [
      '0',
      '1',
    ]);
  });

  // A component is named by a real `identifier` and nothing else. tree-sitter's
  // zero-width MISSING recovery token satisfies `name: (identifier)`, and the
  // grammar admits `underscore_pattern` in the same field, so both would mint an
  // accessor for source that does not compile.
  for (const example of [
    ['a dropped component type', 'record M(int x, y) {}', ['x']],
    ['a nameless varargs component', 'record W(int... ) {}', []],
    ['an underscore component', 'record R(int _) {}', []],
    ['an underscore varargs component', 'record S(int... _) {}', []],
  ] as const) {
    it(`emits no accessor declaration for ${example[0]}`, () => {
      const [_label, source, expected] = example;

      assert.deepEqual(
        recordAccessorDeclarations(source).map((declaration) => declaration.name),
        expected,
      );
    });
  }

  it('emits no accessor scope for a component with no usable name', () => {
    const scopes = emitJavaScopeCaptures('record M(int x, y) {}', 'C.java')
      .filter((m) => m['@scope.function'] !== undefined)
      .map((m) => m['@scope.function']?.text);

    assert.deepEqual(scopes, ['int x']);
  });

  it('is unaffected for a valid record', () => {
    assert.deepEqual(recordAccessorDeclarations('record P(int x, String... ys) {}'), [
      { name: 'x', arity: '0', requiredArity: '0', returnType: 'int' },
      { name: 'ys', arity: '0', requiredArity: '0', returnType: 'String[]' },
    ]);
  });
});

describe('emitJavaScopeCaptures — explicit constructor invocations (F38 #1928)', () => {
  it('captures `super(...)` as a constructor ref to the superclass simple name', () => {
    const src = 'class C extends pkg.Base { C() { super(1, 2); } }';
    const refs = ctorRefs(src);
    const sup = refs.find((r) => r.name === 'Base');
    assert.notEqual(sup, undefined);
    assert.equal(sup!.arity, '2');
  });

  it('reduces a generic superclass `super(...)` target to the bare name', () => {
    const src = 'class C extends Box<String> { C() { super(); } }';
    const refs = ctorRefs(src);
    assert.equal(
      refs.some((r) => r.name === 'Box' && r.arity === '0'),
      true,
    );
  });

  it('unwraps an annotated superclass for explicit `super(...)`', () => {
    const refs = ctorRefs('class C extends @Marker Base { C() { super(); } }');
    assert.equal(
      refs.some((r) => r.name === 'Base' && r.arity === '0'),
      true,
    );
  });

  it('captures `this(...)` as a constructor ref to the enclosing class name', () => {
    const src = 'class C { C() { this(1); } C(int x) {} }';
    const refs = ctorRefs(src);
    const self = refs.find((r) => r.name === 'C' && r.arity === '1');
    assert.notEqual(self, undefined);
  });

  it('does NOT synthesize a super ref when there is no explicit superclass', () => {
    // Implicit `Object` super — no in-graph symbol, so no reference is emitted.
    const src = 'class C { C() { super(); } }';
    const refs = ctorRefs(src);
    assert.equal(refs.length, 0);
  });

  it('captures `this(...)` inside an enum constructor', () => {
    const src = 'enum E { A; E() { this(1); } E(int x) {} }';
    const refs = ctorRefs(src);
    assert.equal(
      refs.some((r) => r.name === 'E' && r.arity === '1'),
      true,
    );
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
    assert.equal(invokeFactsFor(src), 0);
  });

  it('still emits invoke facts for functional-interface dispatch', () => {
    const src = `
class C {
  static void invoke(Runnable callback) { callback.run(); }
}
`;
    assert.equal(invokeFactsFor(src), 1);
  });
});

describe('emitJavaScopeCaptures — local-type identities (#2562)', () => {
  it('uses the source-type-relative identity for the definition and the simple lexical binding', () => {
    const matches = emitJavaScopeCaptures(
      'class Outer { void m() { class Local {} new Local(); } }',
      'Outer.java',
    );
    const local = matches.find((m) => m['@declaration.name']?.text === 'Outer$1Local');

    assert.equal(local?.['@declaration.binding-name']?.text, 'Local');
  });

  it('leaves non-local class declarations unchanged', () => {
    const matches = emitJavaScopeCaptures('class Outer { class Member {} }', 'Outer.java');
    const member = matches.find((m) => m['@declaration.name']?.text === 'Member');

    assert.equal(member?.['@declaration.binding-name'], undefined);
  });

  it('recognizes a local class inside a record compact constructor', () => {
    const matches = emitJavaScopeCaptures(
      'record R(int x) { R { class Local {} new Runnable() {}; } }',
      'R.java',
    );
    const names = matches.flatMap((m) => m['@declaration.name']?.text ?? []);

    assert.ok(names.includes('R$1Local'));
    assert.ok(names.includes('R$1'));
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

    assert.ok(
      ['Outer$1', 'Outer$2', 'Outer$1Local', 'Outer$2Local', 'Outer$1Other'].every((expected) =>
        names.includes(expected),
      ),
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
      assert.equal(declaration?.['@declaration.binding-name']?.text, bindingName);
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

    assert.ok(
      [
        'Outer$1StaticLocal',
        'Outer$1InstanceLocal',
        'Outer$1LambdaLocal',
        'Outer$1$1AnonymousLocal',
      ].every((expected) => names.includes(expected)),
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

    assert.equal(visibility?.['@scope.block']?.range.endLine, 6);
  });
});

it('captures primitive parameter bindings so they shadow lexical names', () => {
  const captures = emitJavaScopeCaptures(
    'class Model { void use(int first, double second, boolean third) {} }',
    'model.java',
  );
  assert.deepEqual(
    captures
      .filter((capture) => capture['@type-binding.parameter'])
      .map((capture) => [capture['@type-binding.name']?.text, capture['@type-binding.type']?.text]),
    [
      ['first', 'int'],
      ['second', 'double'],
      ['third', 'boolean'],
    ],
  );
});
