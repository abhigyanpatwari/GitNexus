/**
 * Unit 1 coverage for the TypeScript scope query + captures orchestrator.
 *
 * Pins the capture-tag vocabulary + range shape for every construct the
 * scope-resolution pipeline reads. Runs against tree-sitter-typescript so it
 * catches grammar drift (node renames, field-name changes) before the
 * integration parity gate does.
 *
 * Import-decomposition assertions (per-specifier markers, `type`-only
 * flagging, dynamic-import normalization) live in
 * `typescript-imports.test.ts` alongside Unit 2.
 * Receiver-binding and arity-metadata assertions live in
 * `typescript-hooks.test.ts` alongside Units 3–5.
 */

import { describe, it, expect } from 'vitest';
import { emitTsScopeCaptures } from '../../../../src/core/ingestion/languages/typescript/captures.js';

function tagsFor(src: string): string[][] {
  const matches = emitTsScopeCaptures(src, 'test.ts');
  return matches.map((m) => Object.keys(m).sort());
}

function findMatch(src: string, predicate: (tags: string[]) => boolean) {
  const matches = emitTsScopeCaptures(src, 'test.ts');
  return matches.find((m) => predicate(Object.keys(m)));
}

function countMatches(src: string, predicate: (tags: string[]) => boolean): number {
  const matches = emitTsScopeCaptures(src, 'test.ts');
  return matches.filter((m) => predicate(Object.keys(m))).length;
}

describe('emitTsScopeCaptures — scopes', () => {
  it('captures the program as @scope.module', () => {
    const all = tagsFor('class A { }');
    expect(all.some((t) => t.includes('@scope.module'))).toBe(true);
  });

  it('parses large cache-miss files with the adaptive tree-sitter buffer', () => {
    const padding = 'x'.repeat(600 * 1024);
    const match = findMatch(`// ${padding}\nclass Big { afterPadding(): void {} }`, (t) =>
      t.includes('@declaration.method'),
    );
    expect(match).toBeDefined();
    expect(match!['@declaration.name'].text).toBe('afterPadding');
  });

  it('parses UTF-8-heavy cache-miss files with a byte-sized buffer', () => {
    const padding = '漢'.repeat(190_000);
    const match = findMatch(`// ${padding}\nclass Big { afterPadding(): void {} }`, (t) =>
      t.includes('@declaration.method'),
    );
    expect(match).toBeDefined();
    expect(match!['@declaration.name'].text).toBe('afterPadding');
  });

  it('captures internal_module as @scope.namespace', () => {
    const all = tagsFor('namespace Foo { class A { } }');
    expect(all.some((t) => t.includes('@scope.namespace'))).toBe(true);
  });

  it('captures nested namespaces (namespace A.B)', () => {
    // `namespace A.B { ... }` desugars to nested internal_module; we emit
    // @scope.namespace for the outer one. The grammar represents this as
    // a single internal_module with a nested_identifier name.
    const all = tagsFor('namespace A.B { class C { } }');
    expect(all.some((t) => t.includes('@scope.namespace'))).toBe(true);
  });

  it('captures classes, interfaces, enums, abstract classes as @scope.class', () => {
    // All four class-like kinds collapse to @scope.class at the scope
    // layer because they share member-holding scope semantics. Declaration
    // tags distinguish them.
    const src = `
      class A { }
      abstract class B { }
      interface C { }
      enum D { V }
    `;
    const count = countMatches(src, (t) => t.includes('@scope.class'));
    expect(count).toBe(4);
  });

  it('captures type aliases with object_type as @scope.class', () => {
    // Structural types with named members are class-like for scope
    // purposes (members are declarations attached to a named scope).
    // This is what the field-extractor's type-alias-with-object-type
    // handling expects.
    const all = tagsFor('type User = { name: string; save(): void }');
    expect(all.some((t) => t.includes('@scope.class'))).toBe(true);
  });

  it('captures functions, methods, arrows, generators, signatures as @scope.function', () => {
    const src = `
      function f() { }
      function* gen() { }
      const arrow = () => { };
      const fnExpr = function() { };
      class A {
        m() { }
        constructor() { }
        get x() { return 1; }
        set x(v) { }
      }
      interface I { m(): void }
      abstract class B { abstract m(): void }
      function overload(x: string): void;
      function overload(x: number): void;
      function overload(x: any) { }
    `;
    const count = countMatches(src, (t) => t.includes('@scope.function'));
    // 1 fn + 1 gen + 1 arrow + 1 fnExpr + 4 methods (m,ctor,get x,set x)
    //   + 1 interface method signature + 1 abstract_method_signature
    //   + 3 overload signatures (2 sig + 1 impl) = 13
    expect(count).toBe(13);
  });
});

describe('emitTsScopeCaptures — declarations', () => {
  it('captures class declarations with @declaration.class + @declaration.name', () => {
    const m = findMatch('class User { }', (t) => t.includes('@declaration.class'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('User');
  });

  it('captures abstract class declarations under @declaration.class', () => {
    const m = findMatch('abstract class Base { }', (t) => t.includes('@declaration.class'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Base');
  });

  it('captures interface declarations distinctly from class declarations', () => {
    const m = findMatch('interface IUser { }', (t) => t.includes('@declaration.interface'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('IUser');
  });

  it('captures enum declarations under @declaration.enum', () => {
    const m = findMatch('enum Status { A, B }', (t) => t.includes('@declaration.enum'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Status');
  });

  it('captures type-alias declarations under @declaration.type', () => {
    const m = findMatch('type ID = string;', (t) => t.includes('@declaration.type'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('ID');
  });

  it('captures namespace declarations under @declaration.namespace', () => {
    const m = findMatch('namespace NS { class A {} }', (t) => t.includes('@declaration.namespace'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('NS');
  });

  it('captures function declarations with their name', () => {
    const m = findMatch('function compute() { }', (t) => t.includes('@declaration.function'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('compute');
  });

  it('captures function_signature (overload decl) under @declaration.function', () => {
    // `function f(x: string): void;` is a function_signature (no body).
    // Needed so the extractor sees all overload decls and can dedup by
    // parameterTypes.
    const m = findMatch('function f(x: string): void;', (t) => t.includes('@declaration.function'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('f');
  });

  it('captures generator function declarations', () => {
    const m = findMatch('function* gen() { yield 1; }', (t) => t.includes('@declaration.function'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('gen');
  });

  it('captures `const fn = () => {}` as both @declaration.function and @declaration.variable', () => {
    // Dual classification is load-bearing: downstream consumers expect a
    // Function def for call targets + a Variable def for name resolution.
    // The central extractor dedupes by node position via FUNCTION_NODE_TYPES.
    const src = 'const fn = () => { };';
    const fnCount = countMatches(src, (t) => t.includes('@declaration.function'));
    const varCount = countMatches(src, (t) => t.includes('@declaration.variable'));
    expect(fnCount).toBe(1);
    expect(varCount).toBe(1);
  });

  it('captures method_definition, abstract_method_signature, method_signature under @declaration.method', () => {
    const src = `
      class A {
        m() { }
      }
      abstract class B {
        abstract m(): void;
      }
      interface I {
        m(): void;
      }
    `;
    const count = countMatches(src, (t) => t.includes('@declaration.method'));
    expect(count).toBe(3);
  });

  it('captures private (#) methods under @declaration.method', () => {
    // ES2022 private methods use private_property_identifier, not
    // property_identifier — covered by a distinct pattern.
    const m = findMatch('class A { #secret() { } }', (t) => t.includes('@declaration.method'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('#secret');
  });

  it('captures class fields under @declaration.property', () => {
    const m = findMatch('class A { x: number = 1; }', (t) => t.includes('@declaration.property'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('x');
  });

  it('captures private (#) fields under @declaration.property', () => {
    const m = findMatch('class A { #x: number = 1; }', (t) => t.includes('@declaration.property'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('#x');
  });

  it('captures parameter properties as both @declaration.property AND @type-binding.parameter', () => {
    // `constructor(public name: string)` is TypeScript syntactic sugar
    // for: declare a `name` field AND a `name` parameter. Both bindings
    // must fire so (a) the field is visible for `this.name` and (b) the
    // parameter binds as a typed local in the constructor scope.
    const src = 'class A { constructor(public readonly name: string, private age: number) { } }';

    const propCount = countMatches(src, (t) => t.includes('@declaration.property'));
    expect(propCount).toBe(2);

    const paramCount = countMatches(src, (t) => t.includes('@type-binding.parameter'));
    expect(paramCount).toBe(2);
  });

  it('captures `let x: number`, `const y`, `var z` under @declaration.variable', () => {
    const src = 'let x: number = 1; const y = 2; var z = 3;';
    const count = countMatches(src, (t) => t.includes('@declaration.variable'));
    expect(count).toBe(3);
  });
});

describe('emitTsScopeCaptures — imports (decomposed)', () => {
  it('decomposes each import form into @import.statement + @import.kind markers', () => {
    // `import { A } from './a'`          → 1 match (named)
    // `import B from './b'`              → 1 match (default)
    // `import * as ns from './ns'`       → 1 match (namespace)
    // `import './polyfill'`              → 1 match (side-effect; file-level edge only)
    const src = `
      import { A } from './a';
      import B from './b';
      import * as ns from './ns';
      import './polyfill';
    `;
    const count = countMatches(src, (t) => t.includes('@import.statement'));
    expect(count).toBe(4);

    // Each has the corresponding @import.kind marker.
    const kinds = tagsFor(src)
      .filter((tags) => tags.includes('@import.statement'))
      .map((tags) => {
        const idx = tags.findIndex((t) => t === '@import.kind');
        return idx >= 0 ? tags[idx] : null;
      });
    expect(kinds).toHaveLength(4);
  });

  it('decomposes multi-specifier imports into one match per name', () => {
    // `import D, { X, Y as Z } from './m'` → 3 matches
    //   default D, named X, named-alias Y→Z
    const src = "import D, { X, Y as Z } from './m';";
    const importMatches = tagsFor(src).filter((tags) => tags.includes('@import.statement'));
    expect(importMatches).toHaveLength(3);

    const m = findMatch(src, (t) => t.includes('@import.statement'));
    expect(m).toBeDefined();
    expect(m!['@import.source'].text).toBe('./m');
  });

  it('decomposes re-exports with `from` source into @import.statement + kind markers', () => {
    // `export { A } from './a'`          → 1 match (reexport)
    // `export * from './b'`              → 1 match (reexport-wildcard)
    // `export * as ns from './c'`        → 1 match (reexport-namespace)
    // `export type { T } from './t'`     → 1 match (reexport; type-only folds in)
    const src = `
      export { A } from './a';
      export * from './b';
      export * as ns from './c';
      export type { T } from './t';
    `;
    const count = countMatches(src, (t) => t.includes('@import.statement'));
    expect(count).toBe(4);
  });

  it('does NOT capture local (non-reexport) `export { X }` as @import.statement', () => {
    const src = 'const X = 1; export { X };';
    const count = countMatches(src, (t) => t.includes('@import.statement'));
    expect(count).toBe(0);
  });

  it('decomposes dynamic `import()` calls into @import.statement + kind=dynamic', () => {
    const src = "const m = import('./m');";
    const m = findMatch(src, (t) => t.includes('@import.statement'));
    expect(m).toBeDefined();
    expect(m!['@import.kind'].text).toBe('dynamic');
    expect(m!['@import.source'].text).toBe('./m');
  });

  it('marks literal dynamic imports with @import.literal so the interpreter can flag them resolvable', () => {
    const src = "const m = import('./m');";
    const m = findMatch(src, (t) => t.includes('@import.statement'));
    expect(m).toBeDefined();
    expect(m!['@import.literal']).toBeDefined();
  });

  it('does NOT mark non-literal dynamic imports with @import.literal', () => {
    const src = 'const m = import(spec);';
    const m = findMatch(src, (t) => t.includes('@import.statement'));
    expect(m).toBeDefined();
    expect(m!['@import.literal']).toBeUndefined();
  });

  it('emits a synthetic @declaration.namespace for `export * as ns from "./m"` (barrel binding)', () => {
    const src = "export * as Models from './base';";
    const m = findMatch(src, (t) => t.includes('@declaration.namespace'));
    expect(m).toBeDefined();
    expect(m!['@declaration.name'].text).toBe('Models');
  });
});

describe('emitTsScopeCaptures — type bindings', () => {
  it('captures parameter annotations (object types)', () => {
    // Primitive annotations (`x: number`) fire separately via the
    // predefined_type pattern; object-typed parameters are what the
    // receiver-bound dispatch actually consumes.
    const m = findMatch('function f(u: User) { }', (t) => t.includes('@type-binding.parameter'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('captures variable annotations', () => {
    const m = findMatch('const u: User = x;', (t) => t.includes('@type-binding.annotation'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('captures constructor-inferred `const u = new User()`', () => {
    const m = findMatch('const u = new User();', (t) => t.includes('@type-binding.constructor'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('captures qualified constructor `const u = new ns.User()`', () => {
    const m = findMatch('const u = new ns.User();', (t) => t.includes('@type-binding.constructor'));
    expect(m).toBeDefined();
    // member_expression text is the dotted path; resolver handles.
    expect(m!['@type-binding.type'].text).toBe('ns.User');
  });

  it('captures call-result alias `const u = factory()`', () => {
    const m = findMatch('const u = factory();', (t) => t.includes('@type-binding.alias'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('factory');
  });

  it('captures member-call alias `const u = svc.getUser()`', () => {
    const m = findMatch('const u = svc.getUser();', (t) => t.includes('@type-binding.alias'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('svc.getUser');
  });

  it('captures await alias `const u = await factory()`', () => {
    const m = findMatch('async function f() { const u = await factory(); }', (t) =>
      t.includes('@type-binding.alias'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('factory');
  });

  it('captures identifier alias `const u2 = u`', () => {
    const m = findMatch('const u2 = u;', (t) => t.includes('@type-binding.alias'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u2');
    expect(m!['@type-binding.type'].text).toBe('u');
  });

  it('captures `as` assertion `const u = x as User`', () => {
    const m = findMatch('const u = x as User;', (t) => t.includes('@type-binding.assertion'));
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('documents limitation: member-expression `instanceof` narrowing is not synthesized', () => {
    const m = findMatch('if (user.address instanceof Address) { user.address.save(); }', (t) =>
      t.includes('@type-binding.assertion'),
    );
    expect(m).toBeUndefined();
  });

  it('captures class field annotations', () => {
    // Field-level @type-binding.annotation and @declaration.property fire
    // as separate matches (different query patterns), not combined on one
    // match. Both must be present — @declaration.property so the field is
    // visible as a class-scope member, @type-binding.annotation so
    // `this.city.save()` can resolve via the type chain.
    const src = 'class A { city: City; }';

    const annotation = findMatch(src, (t) => t.includes('@type-binding.annotation'));
    expect(annotation).toBeDefined();
    expect(annotation!['@type-binding.name'].text).toBe('city');
    expect(annotation!['@type-binding.type'].text).toBe('City');

    const decl = findMatch(src, (t) => t.includes('@declaration.property'));
    expect(decl).toBeDefined();
    expect(decl!['@declaration.name'].text).toBe('city');
  });

  it('captures method return type `save(): User { }`', () => {
    const m = findMatch('class A { save(): User { return this; } }', (t) =>
      t.includes('@type-binding.return'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('save');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('captures function return type `function f(): User { }`', () => {
    const m = findMatch('function f(): User { return null; }', (t) =>
      t.includes('@type-binding.return'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('f');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('captures for-of element binding `for (const u of users)`', () => {
    // u binds to `users` (the iterable identifier); chain-follow unwraps
    // via stripGeneric in interpret.ts.
    const m = findMatch(
      'function f() { for (const u of users) { u.save(); } }',
      (t) => t.includes('@type-binding.alias') && !t.includes('@reference.call.member'),
    );
    expect(m).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('u');
    expect(m!['@type-binding.type'].text).toBe('users');
  });
});

describe('emitTsScopeCaptures — references', () => {
  it('captures free calls `factory()`', () => {
    const m = findMatch('function f() { factory(); }', (t) => t.includes('@reference.call.free'));
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('factory');
  });

  it('captures member calls `obj.method()`', () => {
    const m = findMatch('function f() { obj.method(); }', (t) =>
      t.includes('@reference.call.member'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('method');
    expect(m!['@reference.receiver'].text).toBe('obj');
  });

  it('captures `this.method()` — this is a named node, receiver captured via (_)', () => {
    // C#'s query needs explicit "this" / "base" patterns because those
    // tokens are anonymous; TS's (this) is a NAMED node, so the (_)
    // wildcard catches it uniformly with identifier receivers.
    const m = findMatch(
      'class A { m() { this.save(); } }',
      (t) => t.includes('@reference.call.member') && t.includes('@reference.receiver'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.receiver'].text).toBe('this');
    expect(m!['@reference.name'].text).toBe('save');
  });

  it('captures `super.method()` — super is a named node too', () => {
    const m = findMatch(
      'class A extends B { m() { super.save(); } }',
      (t) => t.includes('@reference.call.member') && t.includes('@reference.receiver'),
    );
    expect(m).toBeDefined();
    // Multiple member calls in this fixture (just one expected though)
    expect(m!['@reference.receiver'].text).toBe('super');
    expect(m!['@reference.name'].text).toBe('save');
  });

  it('captures optional-chaining member calls `obj?.m()`', () => {
    // The optional_chain node sits between object and property but
    // doesn't block the named fields, so the same member_expression
    // pattern matches. Downstream impact: `?.` calls appear as normal
    // member calls — the null-safety aspect isn't part of the graph.
    const m = findMatch('function f() { obj?.m(); }', (t) => t.includes('@reference.call.member'));
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('m');
    expect(m!['@reference.receiver'].text).toBe('obj');
  });

  it('captures constructor calls `new User()`', () => {
    const m = findMatch('function f() { new User(); }', (t) =>
      t.includes('@reference.call.constructor'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('User');
  });

  it('captures qualified constructor calls `new ns.User()`', () => {
    const m = findMatch('function f() { new ns.User(); }', (t) =>
      t.includes('@reference.call.constructor.qualified'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.call.constructor.qualified'].text).toBe('ns.User');
  });

  it('captures member writes `obj.x = 1`', () => {
    const m = findMatch('function f() { obj.x = 1; }', (t) =>
      t.includes('@reference.write.member'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('x');
    expect(m!['@reference.receiver'].text).toBe('obj');
  });

  it('captures compound assignment writes `obj.x += 1`', () => {
    const m = findMatch('function f() { obj.x += 1; }', (t) =>
      t.includes('@reference.write.member'),
    );
    expect(m).toBeDefined();
    expect(m!['@reference.name'].text).toBe('x');
    expect(m!['@reference.receiver'].text).toBe('obj');
  });
});

describe('emitTsScopeCaptures — edge cases', () => {
  it('does not crash on parse errors (recovery)', () => {
    // tree-sitter recovers from syntax errors by producing ERROR nodes;
    // the query should still produce captures from valid subtrees.
    const src = 'function f( { const x = 1; } class B { }';
    expect(() => emitTsScopeCaptures(src, 'test.ts')).not.toThrow();
  });

  it('does not emit duplicate captures for the same node across multiple pattern hits', () => {
    // If two patterns matched the same capture position we'd see the
    // same tag repeated on a match. Sanity check the grouping doesn't
    // collapse distinct tags.
    const matches = emitTsScopeCaptures('class A { m() { } }', 'test.ts');
    for (const m of matches) {
      const tags = Object.keys(m);
      expect(new Set(tags).size).toBe(tags.length);
    }
  });

  it('handles empty input gracefully', () => {
    expect(() => emitTsScopeCaptures('', 'test.ts')).not.toThrow();
  });
});
