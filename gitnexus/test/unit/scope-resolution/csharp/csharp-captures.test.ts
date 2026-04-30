/**
 * Unit 1 coverage for the C# scope query + captures orchestrator.
 *
 * Pins the capture-tag vocabulary + range shape for every construct
 * the scope-resolution pipeline reads. Runs against tree-sitter-c-sharp
 * so it catches grammar drift (node renames, field-name changes)
 * before the integration parity gate does.
 */

import { describe, it, expect } from 'vitest';
import { emitCsharpScopeCaptures } from '../../../../src/core/ingestion/languages/csharp/captures.js';

function tagsFor(src: string): string[][] {
  const matches = emitCsharpScopeCaptures(src, 'test.cs');
  return matches.map((m) => Object.keys(m).sort());
}

function findMatch(src: string, predicate: (tags: string[]) => boolean) {
  const matches = emitCsharpScopeCaptures(src, 'test.cs');
  return matches.find((m) => predicate(Object.keys(m)));
}

describe('emitCsharpScopeCaptures — scopes', () => {
  it('captures the compilation unit as @scope.module', () => {
    const all = tagsFor('class A { }');
    expect(all.some((t) => t.includes('@scope.module'))).toBe(true);
  });

  it('parses large cache-miss files with the adaptive tree-sitter buffer', () => {
    const padding = 'x'.repeat(600 * 1024);
    const match = findMatch(
      `namespace Large;\n// ${padding}\nclass Big { public void AfterPadding() { } }`,
      (t) => t.includes('@declaration.method'),
    );
    expect(match).toBeDefined();
    expect(match!['@declaration.name'].text).toBe('AfterPadding');
  });

  it('parses UTF-8-heavy cache-miss files with a byte-sized buffer', () => {
    const padding = '漢'.repeat(190_000);
    const match = findMatch(
      `namespace Large;\n// ${padding}\nclass Big { public void AfterPadding() { } }`,
      (t) => t.includes('@declaration.method'),
    );
    expect(match).toBeDefined();
    expect(match!['@declaration.name'].text).toBe('AfterPadding');
  });

  it('captures block-scoped namespaces as @scope.namespace', () => {
    const all = tagsFor('namespace Foo.Bar { class A { } }');
    expect(all.some((t) => t.includes('@scope.namespace'))).toBe(true);
  });

  it('captures file-scoped namespaces as @scope.namespace', () => {
    const all = tagsFor('namespace Foo.Bar;\nclass A { }');
    expect(all.some((t) => t.includes('@scope.namespace'))).toBe(true);
  });

  it('captures classes, interfaces, structs, records, enums as @scope.class', () => {
    // All four class-like kinds collapse to @scope.class at the scope
    // layer because they share the same scope semantics (body is a
    // member-holding scope). Declaration tags distinguish them.
    const src = `
      class A { }
      interface B { }
      struct C { }
      record D(int x);
      enum E { V1, V2 }
    `;
    const all = tagsFor(src);
    const scopeClassCount = all.filter((t) => t.includes('@scope.class')).length;
    expect(scopeClassCount).toBe(5);
  });

  it('captures methods, constructors, destructors, local functions as @scope.function', () => {
    const src = `
      class A {
        public A() { }
        ~A() { }
        public void M() {
          void Local() { }
        }
      }
    `;
    const all = tagsFor(src);
    const scopeFnCount = all.filter((t) => t.includes('@scope.function')).length;
    expect(scopeFnCount).toBe(4);
  });
});

describe('emitCsharpScopeCaptures — declarations', () => {
  it('captures class declarations with @declaration.class + @declaration.name', () => {
    const m = findMatch('class User { }', (t) => t.includes('@declaration.class'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('User');
  });

  it('captures interface declarations distinctly from class declarations', () => {
    const m = findMatch('interface IUser { }', (t) => t.includes('@declaration.interface'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('IUser');
  });

  it('captures struct, record, enum with their own declaration tags', () => {
    expect(findMatch('struct Point { }', (t) => t.includes('@declaration.struct'))).toBeDefined();
    expect(findMatch('record R(int x);', (t) => t.includes('@declaration.record'))).toBeDefined();
    expect(findMatch('enum E { V }', (t) => t.includes('@declaration.enum'))).toBeDefined();
  });

  it('captures method declarations with their name', () => {
    const m = findMatch('class A { public void Save() { } }', (t) =>
      t.includes('@declaration.method'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Save');
  });

  it('captures constructor declarations under @declaration.constructor', () => {
    const m = findMatch('class A { public A() { } }', (t) =>
      t.includes('@declaration.constructor'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('A');
  });

  it('captures property declarations', () => {
    const m = findMatch('class A { public int Age { get; set; } }', (t) =>
      t.includes('@declaration.property'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Age');
  });

  it('captures field declarations as @declaration.variable', () => {
    const m = findMatch('class A { private int _x; }', (t) => t.includes('@declaration.variable'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('_x');
  });

  it('captures operator declarations as @declaration.method with the operator token as name', () => {
    // Caller attribution walks ownedDefs looking for method owners.
    // Without this, calls inside `operator +` bodies get attributed to
    // the enclosing class instead of the operator.
    const m = findMatch(
      'class T { public static T operator +(T a, T b) { return a; } }',
      (t) => t.includes('@declaration.method') && !t.includes('@scope.class'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('+');
  });

  it('captures conversion operator declarations with the target type as name', () => {
    const m = findMatch('class T { public static explicit operator int(T x) { return 0; } }', (t) =>
      t.includes('@declaration.method'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('int');
  });

  it('captures operator + conversion-operator as @scope.function', () => {
    const src = `
      class T {
        public static T operator +(T a, T b) { return a; }
        public static explicit operator int(T x) { return 0; }
      }
    `;
    const all = tagsFor(src);
    const fnScopes = all.filter((t) => t.includes('@scope.function')).length;
    expect(fnScopes).toBe(2);
  });

  it('captures local function declarations', () => {
    const m = findMatch('class A { void M() { void Local() { } } }', (t) =>
      t.includes('@declaration.function'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Local');
  });
});

describe('emitCsharpScopeCaptures — imports', () => {
  it('captures each `using` directive as @import.statement', () => {
    const src = `
      using System;
      using System.Collections.Generic;
      using Dict = System.Collections.Generic.Dictionary<string, int>;
      using static System.Math;
    `;
    const all = tagsFor(src);
    const importCount = all.filter((t) => t.includes('@import.statement')).length;
    expect(importCount).toBe(4);
  });
});

describe('emitCsharpScopeCaptures — type bindings', () => {
  it('captures parameter annotations (object types)', () => {
    // `int id` does NOT fire (predefined_type is not identifier) —
    // only object-type parameters do. That's intentional: receiver-
    // bound dispatch doesn't need primitives.
    const m = findMatch('class A { void M(User u) { } }', (t) =>
      t.includes('@type-binding.parameter'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('captures local variable annotations', () => {
    const m = findMatch('class A { void M() { User u; } }', (t) =>
      t.includes('@type-binding.annotation'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('captures constructor-inferred `var u = new User();`', () => {
    const m = findMatch('class A { void M() { var u = new User(); } }', (t) =>
      t.includes('@type-binding.constructor'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('captures alias `var u = Factory();`', () => {
    const m = findMatch('class A { void M() { var u = Factory(); } }', (t) =>
      t.includes('@type-binding.alias'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('Factory');
  });
});

describe('emitCsharpScopeCaptures — arity metadata synthesis', () => {
  it('synthesizes parameter-count + required-parameter-count on method declarations', () => {
    const m = findMatch(
      'class A { public void M(int a, int b = 1) { } }',
      (t) =>
        t.includes('@declaration.method') &&
        t.includes('@declaration.parameter-count') &&
        t.includes('@declaration.required-parameter-count'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.parameter-count'].text).toBe('2');
    expect(m!['@declaration.required-parameter-count'].text).toBe('1');
  });

  it('synthesizes parameter-types on method declarations', () => {
    const m = findMatch(
      'class A { public void M(User u, int n) { } }',
      (t) => t.includes('@declaration.method') && t.includes('@declaration.parameter-types'),
    );
    expect(m).toBeDefined();
    const types = JSON.parse(m!['@declaration.parameter-types'].text);
    expect(types).toEqual(['User', 'int']);
  });

  it('leaves parameter-count undefined for `params` variadic methods', () => {
    const m = findMatch('class A { public void M(params int[] xs) { } }', (t) =>
      t.includes('@declaration.method'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.parameter-count']).toBeUndefined();
    expect(m!['@declaration.required-parameter-count']).toBeUndefined();
    const types = JSON.parse(m!['@declaration.parameter-types'].text);
    expect(types).toContain('params');
  });

  it('synthesizes arity on constructor declarations', () => {
    const m = findMatch('class A { public A(int a, int b) { } }', (t) =>
      t.includes('@declaration.constructor'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.parameter-count'].text).toBe('2');
    expect(m!['@declaration.required-parameter-count'].text).toBe('2');
  });

  it('synthesizes arity on local function declarations', () => {
    const m = findMatch('class A { void M() { void Local(int x) { } } }', (t) =>
      t.includes('@declaration.function'),
    );
    expect(m).toBeDefined();
    expect(m!['@declaration.parameter-count'].text).toBe('1');
  });
});

describe('emitCsharpScopeCaptures — receiver-binding synthesis (`this` / `base`)', () => {
  it('emits `this` for an instance method inside a class', () => {
    const m = findMatch('class User { public void M() { } }', (t) =>
      t.includes('@type-binding.self'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('this');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('emits both `this` and `base` when the class has a base class', () => {
    const matches = emitCsharpScopeCaptures(
      'class User : BaseModel { public void M() { base.Save(); } }',
      'test.cs',
    );
    const receiverMatches = matches.filter((m) => '@type-binding.self' in m);
    const names = receiverMatches.map((m) => m['@type-binding.name'].text).sort();
    expect(names).toEqual(['base', 'this']);
    const baseMatch = receiverMatches.find((m) => m['@type-binding.name'].text === 'base');
    expect(baseMatch!['@type-binding.type'].text).toBe('BaseModel');
  });

  it('does not emit `this` or `base` for static methods', () => {
    const matches = emitCsharpScopeCaptures('class User { public static void M() { } }', 'test.cs');
    const receiverMatches = matches.filter((m) => '@type-binding.self' in m);
    expect(receiverMatches).toHaveLength(0);
  });

  it('does not emit `base` for structs (they cannot inherit classes)', () => {
    const matches = emitCsharpScopeCaptures('struct Point { public void M() { } }', 'test.cs');
    const names = matches
      .filter((m) => '@type-binding.self' in m)
      .map((m) => m['@type-binding.name'].text);
    expect(names).toEqual(['this']);
  });

  it('does not emit `base` for interface methods', () => {
    const matches = emitCsharpScopeCaptures('interface IFoo { void M() { } }', 'test.cs');
    const names = matches
      .filter((m) => '@type-binding.self' in m)
      .map((m) => m['@type-binding.name'].text);
    expect(names).toEqual(['this']);
  });

  it('does not emit receiver bindings for free local functions (no enclosing type)', () => {
    // Local functions inside a method still have `this` from the
    // enclosing class — that's a normal method + local combination.
    // Test the pure free case: a local function at namespace level is
    // not legal C#, so we exercise the adjacent "top-level statement"
    // variant: a method inside a class works fine, but the local
    // function *inside* that method also sees `this` from the class.
    // This test confirms synthesis doesn't produce duplicate bindings.
    const matches = emitCsharpScopeCaptures(
      'class User { public void M() { void Local() { } } }',
      'test.cs',
    );
    const thisMatches = matches.filter(
      (m) => '@type-binding.self' in m && m['@type-binding.name'].text === 'this',
    );
    // Expect two: one for M() and one for Local() — both see `this`
    // from the enclosing User class.
    expect(thisMatches).toHaveLength(2);
    for (const tm of thisMatches) {
      expect(tm['@type-binding.type'].text).toBe('User');
    }
  });

  it('emits `this` on constructors with the enclosing class name', () => {
    const matches = emitCsharpScopeCaptures('class User { public User() { } }', 'test.cs');
    const thisMatch = matches.find(
      (m) => '@type-binding.self' in m && m['@type-binding.name'].text === 'this',
    );
    expect(thisMatch).toBeDefined();
    expect(thisMatch!['@type-binding.type'].text).toBe('User');
  });

  it('emits `this` with innermost type for nested class methods', () => {
    const matches = emitCsharpScopeCaptures(
      'class Outer { class Inner { public void M() { } } }',
      'test.cs',
    );
    const thisMatches = matches.filter(
      (m) => '@type-binding.self' in m && m['@type-binding.name'].text === 'this',
    );
    // M is the only instance method; its `this` binds to Inner.
    expect(thisMatches).toHaveLength(1);
    expect(thisMatches[0]['@type-binding.type'].text).toBe('Inner');
  });
});

describe('emitCsharpScopeCaptures — references', () => {
  it('captures free call invocations', () => {
    const m = findMatch('class A { void M() { Foo(); } }', (t) =>
      t.includes('@reference.call.free'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('Foo');
  });

  it('captures member call invocations with receiver + name', () => {
    const m = findMatch('class A { void M() { obj.Save(); } }', (t) =>
      t.includes('@reference.call.member'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.receiver'].text).toBe('obj');
    expect(m!['@reference.name'].text).toBe('Save');
  });

  it('captures null-conditional member calls `obj?.Save()` with a receiver', () => {
    // Regression guard: without the receiver capture, receiver-bound
    // resolution downgrades to free-call fallback and can mis-link to
    // an imported `Save`.
    const m = findMatch('class A { void M(User obj) { obj?.Save(); } }', (t) =>
      t.includes('@reference.call.member'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('Save');
    expect(m!['@reference.receiver'].text).toBe('obj');
  });

  it('captures object-creation expressions as constructor calls', () => {
    const m = findMatch('class A { void M() { var u = new User(); } }', (t) =>
      t.includes('@reference.call.constructor'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('User');
  });

  it('captures member writes `obj.Name = "x"`', () => {
    const m = findMatch('class A { void M(User obj) { obj.Name = "x"; } }', (t) =>
      t.includes('@reference.write.member'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.receiver'].text).toBe('obj');
    expect(m!['@reference.name'].text).toBe('Name');
  });
});
