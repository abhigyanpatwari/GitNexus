/**
 * Kotlin JVM accessor synthesis (data class / val / var properties).
 */
import { describe, it, expect } from 'vitest';
import { getKotlinParser } from '../../src/core/ingestion/languages/kotlin/query.js';
import {
  kotlinGetterName,
  kotlinSetterName,
  synthesizeLombokAccessors,
  synthesizeLombokAccessorCaptures,
} from '../../src/core/ingestion/languages/kotlin/lombok-synthesizer.js';

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
        )?.text;
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
    expect(kotlinGetterName('ßeta')).toBe('getßeta');
    expect(kotlinGetterName('élan')).toBe('getélan');
    expect(kotlinSetterName('élan')).toBe('setélan');
  });
});

describe('synthesizeLombokAccessors', () => {
  it('emits get/set for data class var/val constructor properties', () => {
    const tree = parse(`
data class User(val name: String, var age: Int)
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getAge', 'getName', 'setAge']);
  });

  it('uses Kotlin property-name rules for Boolean and is-prefixed properties', () => {
    const tree = parse(`
data class Flags(var active: Boolean, var isReady: Boolean, var isLabel: String, var is1: Boolean)
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
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
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name)).toEqual([]);
  });

  it('still emits getName when only a differently-cased GetName exists', () => {
    const tree = parse(`
data class User(val name: String) {
  fun GetName(): String = name
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name)).toEqual(['getName']);
  });

  it('does not treat a member extension receiver as a zero-arity accessor collision', () => {
    const tree = parse(`
class User(val name: String) {
  fun String.getName(): String = this
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name)).toEqual(['getName']);
  });

  it('does not treat a suspend continuation as a zero-arity accessor collision', () => {
    const tree = parse(`
class User(var name: String) {
  suspend fun getName(): String = name
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getName', 'setName']);
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
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getExtra', 'setExtra']);
  });

  it('does not treat a custom qualified JvmField annotation as kotlin.jvm.JvmField', () => {
    const tree = parse(`
class User {
  @com.acme.JvmField val name: String = "x"
  @kotlin.jvm.JvmField val raw: Int = 1
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name)).toEqual(['getName']);
  });

  it('resolves Kotlin JVM annotation aliases and explicit shadows', () => {
    const alias = parse(`
import kotlin.jvm.JvmField as Field
class User {
  @Field val name: String = "x"
}
`);
    expect(
      synthesizeLombokAccessors(alias, FILE_PATH, ownerMap(alias, FILE_PATH)).symbols,
    ).toHaveLength(0);

    const shadow = parse(`
import com.acme.JvmField
class User {
  @JvmField val name: String = "x"
}
`);
    expect(
      synthesizeLombokAccessors(shadow, FILE_PATH, ownerMap(shadow, FILE_PATH)).symbols.map(
        (symbol) => symbol.name,
      ),
    ).toEqual(['getName']);

    const renamed = parse(`
import kotlin.jvm.JvmName as Rename
class User {
  @get:Rename("fetchName") val name: String = "x"
}
`);
    expect(
      synthesizeLombokAccessors(renamed, FILE_PATH, ownerMap(renamed, FILE_PATH)).symbols,
    ).toHaveLength(0);

    const localShadow = parse(`
annotation class JvmField
annotation class JvmName
class User {
  @JvmField val field: String = "x"
  @get:JvmName("fetchName") val name: String = "x"
}
`);
    expect(
      synthesizeLombokAccessors(
        localShadow,
        FILE_PATH,
        ownerMap(localShadow, FILE_PATH),
      ).symbols.map((symbol) => symbol.name),
    ).toEqual(['getField', 'getName']);
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
  @com.acme.JvmName("custom") var qualified: String = ""
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual([
      'getOrdinary',
      'getQualified',
      'setOrdinary',
      'setQualified',
    ]);
  });

  it('extracts the declared type past annotations and honors accessor visibility', () => {
    const tree = parse(`
class User {
  @Deprecated var annotated: String = "x"
    private set
  var typeAnnotated: @Deprecated String? = null
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
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

  it('infers common initializer types without claiming Any', () => {
    const tree = parse(`
class User {
  val name = "x"
  val count = 1
  val total = 1L
  val unsigned = 1u
  val unsignedTotal = 1UL
  val ratio = 1.0
  val enabled = true
  val initial = 'x'
  val nested = User()
  val unresolved = compute()
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    const returnTypes = Object.fromEntries(
      result.symbols.map((symbol) => [symbol.name, symbol.returnType]),
    );
    expect(returnTypes).toMatchObject({
      getName: 'String',
      getCount: 'Int',
      getTotal: 'Long',
      getUnsigned: 'UInt',
      getUnsignedTotal: 'ULong',
      getRatio: 'Double',
      getEnabled: 'Boolean',
      getInitial: 'Char',
      getNested: 'User',
      getUnresolved: 'unknown',
    });
    expect(Object.values(returnTypes)).not.toContain('Any');
  });

  it('attaches object and companion accessors to their dispatch owners', () => {
    const tree = parse(`
object Config {
  var enabled: Boolean = true
}
class Outer {
  companion object {
    var tag: String = "x"
  }
}
class Named {
  companion object Factory {
    val code: Int = 1
  }
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(
      result.symbols.map((symbol) => `${symbol.ownerId}:${symbol.qualifiedName}`).sort(),
    ).toEqual([
      `Class:${FILE_PATH}:Config:Config.getEnabled`,
      `Class:${FILE_PATH}:Config:Config.setEnabled`,
      `Class:${FILE_PATH}:Factory:Factory.getCode`,
      `Class:${FILE_PATH}:Outer:Outer.getTag`,
      `Class:${FILE_PATH}:Outer:Outer.setTag`,
    ]);
    expect(
      result.symbols.map((symbol) => `${symbol.qualifiedName}:${String(symbol.isStatic)}`).sort(),
    ).toEqual([
      'Config.getEnabled:false',
      'Config.setEnabled:false',
      'Factory.getCode:true',
      'Outer.getTag:true',
      'Outer.setTag:true',
    ]);
    expect(
      synthesizeLombokAccessorCaptures(tree.rootNode)
        .map((match) => match['@declaration.qualified_name']?.text)
        .filter((name): name is string => name !== undefined)
        .sort(),
    ).toEqual([
      'Config.getEnabled',
      'Config.setEnabled',
      'Factory.getCode',
      'Outer.getTag',
      'Outer.setTag',
    ]);
  });

  it('does not replace a real enclosing method with an unnamed companion accessor', () => {
    const tree = parse(`
class Outer {
  fun getTag(): String = "real"
  companion object {
    var tag: String = "x"
  }
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(['setTag']);
    expect(result.symbols[0]?.isStatic).toBe(true);
  });

  it('keeps capture and graph identities deduplicated for one dispatch owner', () => {
    const tree = parse(`
class Collision(var tag: String) {
  companion object {
    var tag: Int = 1
  }
}
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((symbol) => symbol.qualifiedName).sort()).toEqual([
      'Collision.getTag',
      'Collision.setTag',
    ]);
    expect(
      synthesizeLombokAccessorCaptures(tree.rootNode)
        .map((match) => match['@declaration.qualified_name']?.text)
        .filter((name): name is string => name !== undefined)
        .sort(),
    ).toEqual(['Collision.getTag', 'Collision.setTag']);
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
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['getName']);
  });

  it('uses unique scope ranges for getter and setter of the same property', () => {
    const tree = parse(`
class Pair(var first: Int, var second: Int)
`);
    const result = synthesizeLombokAccessors(tree, FILE_PATH, ownerMap(tree, FILE_PATH));
    expect(result.symbols).toHaveLength(4);
    const captures = synthesizeLombokAccessorCaptures(tree.rootNode);
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

  it('marks interface property accessors abstract unless they have a body', () => {
    const abstractTree = parse(`
interface Named { val name: String; var age: Int }
`);
    const abstractResult = synthesizeLombokAccessors(
      abstractTree,
      FILE_PATH,
      ownerMap(abstractTree, FILE_PATH),
    );
    expect(abstractResult.symbols.map((s) => `${s.name}:${s.isAbstract}`).sort()).toEqual([
      'getAge:true',
      'getName:true',
      'setAge:true',
    ]);

    const defaultTree = parse(`
interface Named { val name: String get() = "x" }
`);
    const defaultResult = synthesizeLombokAccessors(
      defaultTree,
      FILE_PATH,
      ownerMap(defaultTree, FILE_PATH),
    );
    expect(defaultResult.symbols.map((s) => `${s.name}:${s.isAbstract}`)).toEqual([
      'getName:false',
    ]);
  });
});
