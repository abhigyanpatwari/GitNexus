/**
 * Regression tests for JS/TS scope-resolution coverage gaps (issue #1929).
 *
 * Each fixture FAILS on main and PASSES on the fix branch.
 */
import { describe, it, expect } from 'vitest';
import { emitTsScopeCaptures } from '../../../src/core/ingestion/languages/typescript/captures.js';

function countTags(src: string, predicate: (tags: string[]) => boolean): number {
  const matches = emitTsScopeCaptures(src, 'test.ts');
  return matches.filter((m) => predicate(Object.keys(m))).length;
}

/**
 * F44: Class expression scope.
 * On main: (class) is NOT matched → zero @scope.class for class expressions.
 * On fix: (class) @scope.class matches → exactly one Class scope.
 */
describe('F44 — class expression @scope.class', () => {
  it('anonymous class expression emits @scope.class', () => {
    const src = `
      export const instance = class {
        greet(): string { return 'hi'; }
      };
    `;
    const count = countTags(src, (t) => t.includes('@scope.class'));
    expect(count).toBe(1);
  });

  it('named class expression emits @scope.class with the Class scope', () => {
    const src = `
      const X = class Named {
        greet(): string { return 'hi'; }
      };
    `;
    const count = countTags(src, (t) => t.includes('@scope.class'));
    // 1 for class expression
    expect(count).toBe(1);
  });
});

/**
 * F86: Class expression method_definition scope parent (blocked on F44).
 * On main: class expression has no @scope.class → method falls through to
 * enclosing scope, losing Class ownership.
 * On fix: (class) @scope.class (F44) gives the method a proper Class parent.
 */
describe('F86 — class expression method ownership', () => {
  it('class expression method has @declaration.method and @declaration.name', () => {
    const src = `
      export const instance = class {
        greet(): string { return 'hi'; }
      };
    `;
    const matches = emitTsScopeCaptures(src, 'test.ts');
    const methodDecls = matches.filter((m) => Object.keys(m).includes('@declaration.method'));
    expect(methodDecls.length).toBe(1);
    expect(methodDecls[0]['@declaration.name']?.text).toBe('greet');
  });
});

/**
 * F83: Qualified new_expression name capture.
 * On main: new ns.Foo() has no @reference.name on the property.
 * On fix: the member_expression's property is captured as @reference.name.
 */
describe('F83 — qualified new_expression @reference.name', () => {
  it('new ns.Foo() captures Foo as @reference.name', () => {
    const src = `
      namespace ns {
        export class Foo {}
      }
      const x = new ns.Foo();
    `;
    const matches = emitTsScopeCaptures(src, 'test.ts');
    const nameTags = matches
      .filter((m) => Object.keys(m).includes('@reference.name'))
      .map((m) => m['@reference.name']?.text);
    expect(nameTags).toContain('Foo');
  });
});

/**
 * F85: Enum member @declaration.property.
 * On main: enum members are NOT captured as @declaration.property.
 * On fix: enum_assignment.name is captured as @declaration.property.
 */
describe('F85 — enum member @declaration.property', () => {
  it('enum member names are captured as @declaration.property', () => {
    const src = `
      enum Color {
        Red,
        Green = 1,
        Blue
      }
    `;
    const propCount = countTags(src, (t) => t.includes('@declaration.property'));
    // Red, Green, Blue → 3 enum members
    expect(propCount).toBe(3);
  });
});

/**
 * F87: Optional parameter type annotations.
 * On main: optional_parameter only matches type_identifier and generic_type.
 * On fix: matches predefined_type, union_type, array_type, readonly_type too.
 */
describe('F87 — optional_parameter type annotations', () => {
  it('optional_parameter with predefined_type (string) captures type binding', () => {
    const src = `
      function f(x?: string): void {}
    `;
    const typeCount = countTags(src, (t) => t.includes('@type-binding.parameter'));
    expect(typeCount).toBe(1);
  });

  it('optional_parameter with union_type captures type binding', () => {
    const src = `
      function f(x?: string | null): void {}
    `;
    const typeCount = countTags(src, (t) => t.includes('@type-binding.parameter'));
    expect(typeCount).toBe(1);
  });

  it('optional_parameter with array_type captures type binding', () => {
    const src = `
      function f(x?: string[]): void {}
    `;
    const typeCount = countTags(src, (t) => t.includes('@type-binding.parameter'));
    expect(typeCount).toBe(1);
  });

  it('optional_parameter with readonly_type captures type binding', () => {
    const src = `
      function f(x?: readonly string[]): void {}
    `;
    const typeCount = countTags(src, (t) => t.includes('@type-binding.parameter'));
    expect(typeCount).toBe(1);
  });
});
