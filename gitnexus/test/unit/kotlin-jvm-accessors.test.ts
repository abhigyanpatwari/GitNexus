/**
 * Kotlin JVM accessor synthesis (data class / val / var properties).
 */
import { describe, it, expect } from 'vitest';
import { getKotlinParser } from '../../src/core/ingestion/languages/kotlin/query.js';
import {
  synthesizeKotlinJvmAccessors,
  synthesizeKotlinJvmAccessorCaptures,
} from '../../src/core/ingestion/languages/kotlin/jvm-accessors.js';
import {
  kotlinGetterName,
  kotlinSetterName,
} from '../../src/core/ingestion/languages/jvm/beanspec.js';

const FILE_PATH = '/test/User.kt';

function parse(code: string) {
  return getKotlinParser().parse(code);
}

function ownerMap(tree: ReturnType<typeof parse>, filePath: string): Map<number, string> {
  const map = new Map<number, string>();
  const TYPES = new Set(['class_declaration', 'object_declaration', 'companion_object']);
  const walk = (node: (typeof tree)['rootNode']): void => {
    if (TYPES.has(node.type)) {
      const name =
        node.childForFieldName('name')?.text ??
        node.namedChildren.find(
          (c) => c.type === 'type_identifier' || c.type === 'simple_identifier',
        )?.text ??
        (node.type === 'companion_object' ? 'Companion' : undefined);
      if (name) map.set(node.id, `Class:${filePath}:${name}`);
    }
    for (const c of node.children) walk(c);
  };
  walk(tree.rootNode);
  return map;
}

describe('Kotlin JVM accessor naming', () => {
  it('preserves is-prefixed names and otherwise uses get, including for Boolean', () => {
    expect(kotlinGetterName('active')).toBe('getActive');
    expect(kotlinGetterName('flag')).toBe('getFlag');
    expect(kotlinGetterName('isReady')).toBe('isReady');
    expect(kotlinGetterName('is1')).toBe('is1');
    expect(kotlinSetterName('is1')).toBe('set1');
  });
});

describe('synthesizeKotlinJvmAccessors', () => {
  it('emits get/set for data class var/val constructor properties', () => {
    const tree = parse(`
data class User(val name: String, var age: Int)
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getAge', 'getName', 'setAge']);
  });

  it('uses Kotlin property-name rules for Boolean and is-prefixed properties', () => {
    const tree = parse(`
data class Flags(var active: Boolean, var isReady: Boolean, var isLabel: String, var is1: Boolean)
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual([
      'getActive',
      'is1',
      'isLabel',
      'isReady',
      'set1',
      'setActive',
      'setLabel',
      'setReady',
    ]);
  });

  it('skips getter when an explicit fun getName exists', () => {
    const tree = parse(`
data class User(val name: String) {
  fun getName(): String = name
}
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name)).toEqual([]);
  });

  it('emits custom get/set JVM methods but skips @JvmField', () => {
    const tree = parse(`
class User {
  var extra: String = "x"
    get() = field
    set(v) { field = v }
  @JvmField val raw: Int = 1
}
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getExtra', 'setExtra']);
  });

  it('suppresses accessors renamed with @JvmName until custom names are modeled', () => {
    const tree = parse(`
class User {
  @get:JvmName("fetchName") @set:JvmName("putName")
  var name: String = ""
  var display: String = ""
    @JvmName("readDisplay") get() = field
    @JvmName("writeDisplay") set(v) { field = v }
  @NotJvmName var ordinary: String = ""
}
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getOrdinary', 'setOrdinary']);
  });

  it('extracts the declared type past annotations and honors accessor visibility', () => {
    const tree = parse(`
class User {
  @Deprecated var annotated: String = "x"
    private set
  var typeAnnotated: @Deprecated String? = null
}
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    const getter = result.symbols.find((s) => s.name === 'getAnnotated');
    const setter = result.symbols.find((s) => s.name === 'setAnnotated');
    expect(getter).toMatchObject({
      returnType: 'String',
      parameterTypes: [],
      visibility: 'public',
    });
    expect(setter).toMatchObject({
      returnType: 'void',
      parameterTypes: ['String'],
      visibility: 'private',
    });
    expect(result.symbols.find((s) => s.name === 'getTypeAnnotated')).toMatchObject({
      returnType: 'String?',
    });
    expect(result.symbols.find((s) => s.name === 'setTypeAnnotated')).toMatchObject({
      parameterTypes: ['String?'],
    });
  });

  it('emits nested class accessors and skips function-local classes', () => {
    const tree = parse(`
class Outer {
  fun skip() {
    class Local(val hidden: String)
  }
  class Inner(val name: String)
}
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getName']);
  });

  it('uses unique scope ranges for getter and setter of the same property', () => {
    const tree = parse(`
class Pair(var first: Int, var second: Int)
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols).toHaveLength(4);
    const captures = synthesizeKotlinJvmAccessorCaptures(tree.rootNode);
    const scopes = captures
      .map((m) => m['@scope.function'])
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => `${c.range.startLine}:${c.range.startCol}-${c.range.endLine}:${c.range.endCol}`);
    expect(scopes).toHaveLength(4);
    expect(new Set(scopes).size).toBe(4);
    expect(
      captures
        .map((m) => m['@declaration.qualified_name']?.text)
        .filter((name): name is string => name !== undefined)
        .sort(),
    ).toEqual(['Pair.getFirst', 'Pair.getSecond', 'Pair.setFirst', 'Pair.setSecond']);
    expect(captures.some((m) => '@declaration.qualified-name' in m)).toBe(false);
  });
});
