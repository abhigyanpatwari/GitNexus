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
  jvmGetterName,
  kotlinUsesIsPrefix,
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
  it('uses is-prefix for non-null Boolean, get for Boolean?', () => {
    expect(jvmGetterName('active', kotlinUsesIsPrefix('Boolean'))).toBe('isActive');
    expect(jvmGetterName('flag', kotlinUsesIsPrefix('Boolean?'))).toBe('getFlag');
    expect(jvmGetterName('isReady', kotlinUsesIsPrefix('Boolean'))).toBe('isReady');
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

  it('skips getter when an explicit fun getName exists', () => {
    const tree = parse(`
data class User(val name: String) {
  fun getName(): String = name
}
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name)).toEqual([]);
  });

  it('skips custom get/set and @JvmField', () => {
    const tree = parse(`
class User {
  var extra: String = "x"
    get() = field
    set(v) { field = v }
  @JvmField val raw: Int = 1
}
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name)).toEqual([]);
  });

  it('uses unique scope ranges for getter and setter of the same property', () => {
    const tree = parse(`
class Pair(var first: Int, var second: Int)
`);
    const result = synthesizeKotlinJvmAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols).toHaveLength(4);
    const scopes = synthesizeKotlinJvmAccessorCaptures(tree.rootNode)
      .map((m) => m['@scope.function'])
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => `${c.range.startLine}:${c.range.startCol}-${c.range.endLine}:${c.range.endCol}`);
    expect(scopes).toHaveLength(4);
    expect(new Set(scopes).size).toBe(4);
  });
});
