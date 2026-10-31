import { afterEach, describe, expect, it } from 'vitest';
import { getJavaParser } from '../../../../src/core/ingestion/languages/java/query.js';
import {
  captureJavaOverloadFacts,
  clearJavaOverloadFacts,
  getJavaOverloadCall,
  getJavaOverloadFacts,
  isJavaOverloadFileFacts,
  setJavaOverloadFacts,
} from '../../../../src/core/ingestion/languages/java/overload-argument-facts.js';

function capture(source: string) {
  const tree = getJavaParser().parse(source);
  return captureJavaOverloadFacts(tree.rootNode)!;
}
afterEach(clearJavaOverloadFacts);

describe('Java lossless overload argument facts', () => {
  it('keeps formal parameters in their own methods and respects field/block shadowing', () => {
    const facts = capture(`class A {
      Long value;
      void first(String value) { use(value); }
      void second(Long value) { use(value); }
      void blocks() { { String value = "x"; use(value); } use(value); }
    }`);
    expect(
      facts.calls.filter((call) => call.name === 'use').map((call) => call.arguments[0]),
    ).toMatchObject([
      { kind: 'typed', spelling: 'String' },
      { kind: 'typed', spelling: 'Long' },
      { kind: 'typed', spelling: 'String' },
      { kind: 'typed', spelling: 'Long' },
    ]);
  });

  it('does not let a later local declaration hide the field at an earlier call', () => {
    const facts = capture(
      'class A { Long value; void run() { use(value); String value = "x"; use(value); } }',
    );
    expect(facts.calls.map((call) => call.arguments[0])).toMatchObject([
      { kind: 'typed', spelling: 'Long' },
      { kind: 'typed', spelling: 'String' },
    ]);
  });

  it('uses an explicit this field declaration despite a local with the same name', () => {
    const facts = capture(
      'class A { Long value; void run(String value) { use(value); use(this.value); } }',
    );
    expect(facts.calls.map((call) => call.arguments[0])).toMatchObject([
      { kind: 'typed', spelling: 'String' },
      { kind: 'typed', spelling: 'Long' },
    ]);
  });

  it('looks up inherited fields before enclosing fields and retains declaration context', () => {
    const facts = capture(`class Base { String value; }
      class Outer { Long value; class Inner<String> extends Base {
        void run(Long value) { use(this.value); use(value); }
        void implicit() { use(value); }
      } }`);
    const arguments_ = facts.calls
      .filter((call) => call.name === 'use')
      .map((call) => call.arguments[0]);
    expect(arguments_).toMatchObject([
      { kind: 'typed', spelling: 'String', at: { startLine: 1 } },
      { kind: 'typed', spelling: 'Long', at: { startLine: 3 } },
      { kind: 'typed', spelling: 'String', at: { startLine: 1 } },
    ]);
  });

  it('keeps enhanced-for bindings out of the iterable expression', () => {
    const facts = capture(
      'class A { Long item; void run() { for (String item : source(item)) use(item); } }',
    );
    expect(facts.calls.map((call) => call.arguments[0])).toMatchObject([
      { kind: 'typed', spelling: 'Long' },
      { kind: 'typed', spelling: 'String' },
    ]);
  });

  it.each([
    ['unknown superclass', '', 'extends External'],
    ['generic field substitution', 'class Base<T> { T value; }', 'extends Base<String>'],
    [
      'ambiguous interface fields',
      'interface Left { String value = "x"; } interface Right { Long value = 1L; }',
      'implements Left, Right',
    ],
  ])('does not infer an outer field across %s', (_description, declarations, heritage) => {
    const facts = capture(`${declarations} class Outer { Long value; class Inner ${heritage} {
      void run() { use(value); use(this.value); }
    } }`);
    expect(
      facts.calls.filter((call) => call.name === 'use').map((call) => call.arguments[0]),
    ).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]);
  });

  it('does not inherit private fields or use an outer field for explicit this', () => {
    const facts = capture(
      'class Base { private String value; } class Outer { Long value; class Inner extends Base { void run() { use(value); use(this.value); } } }',
    );
    expect(facts.calls.map((call) => call.arguments[0])).toMatchObject([
      { kind: 'typed', spelling: 'Long' },
      { kind: 'unknown' },
    ]);
  });

  it('resolves an enclosing field through a deep empty inheritance diamond', () => {
    const declarations = ['interface A0 {}', 'interface B0 {}'];
    // Without memoization this small hierarchy expands into millions of paths.
    for (let depth = 1; depth <= 24; depth++) {
      declarations.push(
        `interface A${depth} extends A${depth - 1}, B${depth - 1} {}`,
        `interface B${depth} extends A${depth - 1}, B${depth - 1} {}`,
      );
    }
    const facts = capture(`${declarations.join('\n')}
      class Outer { Long value; class Inner implements A24, B24 {
        void run() { use(value); use(value); }
      } }`);
    expect(facts.calls.map((call) => call.arguments[0])).toMatchObject([
      { kind: 'typed', spelling: 'Long' },
      { kind: 'typed', spelling: 'Long' },
    ]);
  });

  it('does not reuse a shallow field proof beyond the inheritance depth bound', () => {
    const declarations = ['interface A0 {}'];
    for (let depth = 1; depth <= 63; depth++)
      declarations.push(`interface A${depth} extends A${depth - 1} {}`);
    const facts = capture(`${declarations.join('\n')}
      class Outer { Long value; class Inner implements A0, A63 {
        void run() { use(value); use(value); }
      } }`);
    expect(facts.calls.map((call) => call.arguments[0])).toEqual([
      { kind: 'unknown' },
      { kind: 'unknown' },
    ]);
  });

  it('keeps cyclic field inheritance unknown across repeated lookups', () => {
    const facts = capture(`interface Left extends Right {} interface Right extends Left {}
      class Outer { Long value; class Inner implements Left, Right {
        void run() { use(value); use(value); }
      } }`);
    expect(facts.calls.map((call) => call.arguments[0])).toEqual([
      { kind: 'unknown' },
      { kind: 'unknown' },
    ]);
  });

  it('retains numeric suffixes, declared containers, dimensions, casts, and null separately', () => {
    const facts = capture(
      'class A { void run(java.util.List<Long> ids, int[][] grid) { use(1L, 1f, ids, grid, (String)null, null); } }',
    );
    expect(facts.calls[0]!.arguments).toMatchObject([
      { kind: 'typed', spelling: 'long' },
      { kind: 'typed', spelling: 'float' },
      { kind: 'typed', spelling: 'java.util.List<Long>' },
      { kind: 'typed', spelling: 'int[][]' },
      { kind: 'typed', spelling: 'String' },
      { kind: 'null' },
    ]);
  });

  it('retains qualified generic formal types and array dimensions in candidate declarations', () => {
    const facts = capture(
      'class A { void use(java.util.Collection<Long> ids, String[] names, int value[], Long... rest) {} }',
    );
    expect(facts.methods[0]!.parameterTypes).toEqual([
      'java.util.Collection<Long>',
      'String[]',
      'int[]',
      'Long',
      'varargs',
    ]);
  });

  it('preserves trailing dimensions on method and explicitly typed lambda formals', () => {
    const facts = capture(
      'class A { void run(String value[]) { use(value); java.util.function.Consumer<String[]> lambda = (String item[]) -> use(item); } }',
    );
    expect(
      facts.calls.filter((call) => call.name === 'use').map((call) => call.arguments[0]),
    ).toMatchObject([
      { kind: 'typed', spelling: 'String[]' },
      { kind: 'typed', spelling: 'String[]' },
    ]);
  });

  it('retains poly factories and explicit type arguments rather than freezing List<Long>', () => {
    const facts = capture(
      'import java.util.Arrays; class A { void run(Long id) { use(Arrays.<Number>asList(id, 1L)); } }',
    );
    expect(facts.calls.find((call) => call.name === 'use')!.arguments[0]).toMatchObject({
      kind: 'factory',
      owner: 'Arrays',
      name: 'asList',
      typeArguments: ['Number'],
      shadowed: false,
      arguments: [
        { kind: 'typed', spelling: 'Long' },
        { kind: 'typed', spelling: 'long' },
      ],
    });
  });

  it('records value shadowing of a factory qualifier and type-parameter declarations', () => {
    const facts = capture(
      'class A<Long> { <String> void run(Object Arrays) { use(Arrays.asList(1L)); } }',
    );
    expect(facts.types[0]!.typeParameters).toEqual(['Long']);
    expect(facts.methods[0]!.typeParameters).toEqual(['String']);
    expect(facts.calls.find((call) => call.name === 'use')!.arguments[0]).toMatchObject({
      kind: 'factory',
      shadowed: true,
    });
  });

  it('keeps same-start chained call sites distinct through a plain-data round trip', () => {
    const facts = capture('class A { void run(Long id) { lookup.find(id).get(id); } }');
    const restored: unknown = JSON.parse(JSON.stringify(facts));
    expect(isJavaOverloadFileFacts(restored)).toBe(true);
    setJavaOverloadFacts('A.java', restored as typeof facts);
    for (const call of facts.calls)
      expect(getJavaOverloadCall('A.java', call.range, call.name)).toEqual(call);
    setJavaOverloadFacts('A.java', undefined);
    expect(getJavaOverloadFacts('A.java')).toBeUndefined();
    expect(
      getJavaOverloadCall('A.java', facts.calls[0]!.range, facts.calls[0]!.name),
    ).toBeUndefined();
  });

  it('assigns enum constant methods to their synthetic owners and retains the host base', () => {
    const facts = capture(`class Host { enum Mode {
      FIRST { void hook() { helper(); } }, SECOND { void hook() {} }, PLAIN;
      void helper() {}
    } }`);
    expect(facts.types.map(({ name, simpleName, bases }) => ({ name, simpleName, bases }))).toEqual(
      [
        { name: 'Host', simpleName: 'Host', bases: [] },
        { name: 'Mode', simpleName: 'Mode', bases: [] },
        { name: 'Host$Mode$1', simpleName: 'Host$Mode$1', bases: ['Mode'] },
        { name: 'Host$Mode$2', simpleName: 'Host$Mode$2', bases: ['Mode'] },
      ],
    );
    expect(facts.methods.map(({ owner, name }) => `${owner}.${name}`)).toEqual([
      'Host$Mode$1.hook',
      'Host$Mode$2.hook',
      'Mode.helper',
    ]);
  });

  it('captures implicit record accessors without duplicating explicit zero-argument accessors', () => {
    const facts = capture(`class Host { void run() {
      record Data(String name, int count, String... tags) {
        public String name() { return name; }
        int count(int factor) { return count * factor; }
      }
    } }`);
    const accessors = facts.methods.filter((method) => method.owner === 'Host$1Data');
    expect(
      accessors.map(({ name, parameterTypes, modifiers }) => ({
        name,
        parameterTypes,
        modifiers,
      })),
    ).toEqual([
      { name: 'count', parameterTypes: [], modifiers: ['public'] },
      { name: 'tags', parameterTypes: [], modifiers: ['public'] },
      { name: 'name', parameterTypes: [], modifiers: ['public'] },
      { name: 'count', parameterTypes: ['int'], modifiers: [] },
    ]);
    expect(isJavaOverloadFileFacts(JSON.parse(JSON.stringify(facts)))).toBe(true);
  });

  it('does not synthesize accessor facts for malformed record component names', () => {
    const facts = capture('record Missing(int x, y) {} record Unnamed(int _) {}');
    expect(facts.methods.map(({ owner, name }) => `${owner}.${name}`)).toEqual(['Missing.x']);
  });

  it('retains type visibility and gives only direct interface members implicit public access', () => {
    const facts = capture(`public class Outer {
      private static class Hidden {}
      protected class Protected {}
      class PackageMember {}
    }
    interface API {
      class Member {}
      enum Mode { VALUE }
      default void run() { class Local {} }
    }
    @interface Annotation { class Member {} }`);
    expect(facts.types.map(({ name, modifiers }) => ({ name, modifiers }))).toEqual([
      { name: 'Outer', modifiers: ['public'] },
      { name: 'Hidden', modifiers: ['private', 'static'] },
      { name: 'Protected', modifiers: ['protected'] },
      { name: 'PackageMember', modifiers: [] },
      { name: 'API', modifiers: [] },
      { name: 'Member', modifiers: ['public'] },
      { name: 'Mode', modifiers: ['public'] },
      { name: 'API$1Local', modifiers: [] },
      { name: 'Annotation', modifiers: [] },
      { name: 'Member', modifiers: ['public'] },
    ]);
  });

  it('validates optional persisted type modifiers without rejecting older facts', () => {
    const facts = capture('public class A {}');
    const { modifiers: _modifiers, ...olderType } = facts.types[0]!;
    expect(isJavaOverloadFileFacts({ ...facts, types: [olderType] })).toBe(true);
    expect(isJavaOverloadFileFacts(JSON.parse(JSON.stringify(facts)))).toBe(true);
    expect(isJavaOverloadFileFacts({ ...facts, types: [{ ...olderType, modifiers: null }] })).toBe(
      false,
    );
    expect(isJavaOverloadFileFacts({ ...facts, types: [{ ...olderType, modifiers: [1] }] })).toBe(
      false,
    );
  });

  it('rejects malformed persisted facts and retains empty types for inherited inventories', () => {
    expect(capture('class Empty {}').types).toMatchObject([{ name: 'Empty', bases: [] }]);
    const facts = capture('class A { void run() { use(null); } }');
    expect(
      isJavaOverloadFileFacts({
        ...facts,
        calls: [{ ...facts.calls[0], arguments: [{ kind: 'typed', spelling: 1 }] }],
      }),
    ).toBe(false);
    expect(isJavaOverloadFileFacts({ ...facts, methods: [null] })).toBe(false);
  });
});
