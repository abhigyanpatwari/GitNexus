/**
 * Unit test: Lombok accessor method synthesis.
 *
 * Tests the lombok-synthesizer module directly (no worker pool needed).
 * Fixtures use proven lombok imports / FQNs — bare `@Data` without provenance
 * must not synthesize.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  getterName,
  setterName,
  synthesizeLombokAccessors,
  synthesizeLombokAccessorCaptures,
} from '../../../../../src/core/ingestion/languages/java/lombok-synthesizer.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(code);
}

const FILE_PATH = '/test/Order.java';

function ownerMapBySimpleName(tree: Parser.Tree, filePath: string): Map<number, string> {
  const map = new Map<number, string>();
  const CLASS_LIKE = new Set([
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ]);
  const immediateParentName = (node: Parser.SyntaxNode): string | null => {
    for (let current = node.parent; current; current = current.parent) {
      if (CLASS_LIKE.has(current.type)) {
        const nameNode = current.childForFieldName('name');
        if (nameNode) return nameNode.text;
      }
    }
    return null;
  };
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'class_declaration' || node.type === 'enum_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const parent = immediateParentName(node);
        const key = parent ? `${parent}.${nameNode.text}` : nameNode.text;
        const label = node.type === 'enum_declaration' ? 'Enum' : 'Class';
        map.set(node.id, `${label}:${filePath}:${key}`);
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);
  return map;
}

describe('Lombok naming helpers', () => {
  it('uses isPrefix for primitive boolean isX without double-is', () => {
    assert.equal(getterName('isEnabled', 'boolean'), 'isEnabled');
    assert.equal(setterName('isEnabled', 'boolean'), 'setEnabled');
    assert.equal(getterName('active', 'boolean'), 'isActive');
    assert.equal(setterName('active', 'boolean'), 'setActive');
    assert.equal(getterName('active', 'Boolean'), 'getActive');
    assert.equal(setterName('active', 'Boolean'), 'setActive');
    assert.equal(getterName('is1', 'boolean'), 'is1');
    assert.equal(setterName('is1', 'boolean'), 'set1');
    assert.equal(getterName('ßeta', 'String'), 'getßeta');
  });
});

describe('synthesizeLombokAccessors', () => {
  describe('@Data annotation', () => {
    it('generates both getter and setter for each field', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Order {
    private String orderId;
    private Long amount;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);
      assert.equal(result.symbols.length, 4);
      const names = result.symbols.map((s) => s.name).sort();
      assert.deepEqual(names, ['getAmount', 'getOrderId', 'setAmount', 'setOrderId']);
    });

    it('sets correct return types and parameter types', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Order {
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      const getter = result.symbols.find((s) => s.name === 'getOrderId')!;
      assert.equal(getter.returnType, 'String');
      assert.deepEqual(getter.parameterTypes, []);
      const setter = result.symbols.find((s) => s.name === 'setOrderId')!;
      assert.equal(setter.returnType, 'void');
      assert.deepEqual(setter.parameterTypes, ['String']);
    });

    it('emits bodyless declarations for multi-declarator getters and setters', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Pair {
    private int first, second;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(result.symbols.map((s) => s.name).sort(), [
        'getFirst',
        'getSecond',
        'setFirst',
        'setSecond',
      ]);
      const captures = synthesizeLombokAccessorCaptures(tree.rootNode);
      assert.equal(
        captures.some((match) => match['@scope.function'] !== undefined),
        false,
      );
      assert.deepEqual(captures.map((match) => match['@declaration.qualified_name']?.text).sort(), [
        'Pair.getFirst',
        'Pair.getSecond',
        'Pair.setFirst',
        'Pair.setSecond',
      ]);
    });

    it('creates HAS_METHOD relationships linking to the class', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Order {
    private String orderId;
}
`);
      const classNodeIds = ownerMapBySimpleName(tree, FILE_PATH);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);
      assert.ok(result.relationships.length > 0);
      for (const rel of result.relationships) {
        assert.equal(rel.type, 'HAS_METHOD');
        assert.equal(rel.sourceId, `Class:${FILE_PATH}:Order`);
        assert.equal(rel.targetId.startsWith('Method:'), true);
      }
    });

    it('skips unproven bare @Data without lombok import', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.length, 0);
    });

    it('skips lombok subpackages that are not lombok or lombok.experimental', () => {
      const nestedFqn = parse(`
@lombok.foo.Data
public class Order {
    private String orderId;
}
`);
      assert.equal(
        synthesizeLombokAccessors(nestedFqn, FILE_PATH, ownerMapBySimpleName(nestedFqn, FILE_PATH))
          .symbols.length,
        0,
      );

      const nestedImport = parse(`
import lombok.foo.Data;
@Data
public class Order {
    private String orderId;
}
`);
      assert.equal(
        synthesizeLombokAccessors(
          nestedImport,
          FILE_PATH,
          ownerMapBySimpleName(nestedImport, FILE_PATH),
        ).symbols.length,
        0,
      );
    });

    it('keeps lombok and lombok.experimental star imports package-specific', () => {
      const experimentalOnly = parse(`
import lombok.experimental.*;
@Data
public class Order {
    private String orderId;
}
`);
      assert.equal(
        synthesizeLombokAccessors(
          experimentalOnly,
          FILE_PATH,
          ownerMapBySimpleName(experimentalOnly, FILE_PATH),
        ).symbols.length,
        0,
      );

      const coreOnly = parse(`
import lombok.*;
@Data
@Accessors(fluent = true)
public class Order {
    private String orderId;
}
`);
      assert.deepEqual(
        synthesizeLombokAccessors(coreOnly, FILE_PATH, ownerMapBySimpleName(coreOnly, FILE_PATH))
          .symbols.map((symbol) => symbol.name)
          .sort(),
        ['getOrderId', 'setOrderId'],
      );

      const splitPackages = parse(`
import lombok.Data;
import lombok.experimental.*;
@Data
@Accessors(fluent = true)
public class Order {
    private String orderId;
}
`);
      assert.equal(
        synthesizeLombokAccessors(
          splitPackages,
          FILE_PATH,
          ownerMapBySimpleName(splitPackages, FILE_PATH),
        ).symbols.length,
        0,
      );
    });

    it('lets explicit imports and local declarations shadow star imports', () => {
      const explicitShadow = parse(`
import lombok.*;
import com.acme.Data;
@Data
public class Order {
    private String orderId;
}
`);
      assert.equal(
        synthesizeLombokAccessors(
          explicitShadow,
          FILE_PATH,
          ownerMapBySimpleName(explicitShadow, FILE_PATH),
        ).symbols.length,
        0,
      );

      const localShadow = parse(`
import lombok.*;
@interface Data {}
@Data
class Order {
    private String orderId;
}
`);
      assert.equal(
        synthesizeLombokAccessors(
          localShadow,
          FILE_PATH,
          ownerMapBySimpleName(localShadow, FILE_PATH),
        ).symbols.length,
        0,
      );

      // A single-static-import may name a member type, which shadows every
      // type-import-on-demand (JLS 6.4.1); without resolution it is refused.
      const staticImport = parse(`
import static com.acme.Constants.Data;
import lombok.*;
@Data
class Order {
    private String orderId;
}
`);
      assert.equal(
        synthesizeLombokAccessors(
          staticImport,
          FILE_PATH,
          ownerMapBySimpleName(staticImport, FILE_PATH),
        ).symbols.length,
        0,
      );

      const staticWildcard = parse(`
import static com.acme.Constants.*;
import lombok.*;
@Data
class Order {
    private String orderId;
}
`);
      assert.deepEqual(
        synthesizeLombokAccessors(
          staticWildcard,
          FILE_PATH,
          ownerMapBySimpleName(staticWildcard, FILE_PATH),
        ).symbols.map((symbol) => symbol.name),
        ['getOrderId', 'setOrderId'],
      );
    });
  });

  describe('boolean naming', () => {
    it('uses isActive for primitive boolean active', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Flag {
    private boolean active;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(result.symbols.map((s) => s.name).sort(), ['isActive', 'setActive']);
    });

    it('does not double-prefix primitive boolean isEnabled', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Flag {
    private boolean isEnabled;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(result.symbols.map((s) => s.name).sort(), ['isEnabled', 'setEnabled']);
      assert.equal(
        result.symbols.find((s) => s.name === 'isIsEnabled'),
        undefined,
      );
    });

    it('uses get/set for boxed Boolean', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Flag {
    private Boolean active;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(result.symbols.map((s) => s.name).sort(), ['getActive', 'setActive']);
    });
  });

  describe('field-level and NONE', () => {
    it('enables field-only @Getter without class annotation', () => {
      const tree = parse(`
import lombok.Getter;
public class Order {
    @Getter private String orderId;
    private String ignored;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(
        result.symbols.map((s) => s.name),
        ['getOrderId'],
      );
    });

    it('class @Getter(AccessLevel.NONE) does not enable getters', () => {
      const tree = parse(`
import lombok.Getter;
import lombok.AccessLevel;
@Getter(AccessLevel.NONE)
public class Order {
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.length, 0);
    });

    it('keeps class @Getter(NONE) when @Data follows it', () => {
      const tree = parse(`
import lombok.Data;
import lombok.Getter;
import lombok.AccessLevel;
@Getter(AccessLevel.NONE)
@Data
public class Order {
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(
        result.symbols.map((s) => s.name),
        ['setOrderId'],
      );
    });

    it('field @Setter(AccessLevel.NONE) suppresses setter under @Data', () => {
      const tree = parse(`
import lombok.Data;
import lombok.Setter;
import lombok.AccessLevel;
@Data
public class Order {
    @Setter(AccessLevel.NONE)
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(
        result.symbols.map((s) => s.name),
        ['getOrderId'],
      );
    });

    it('honors @Getter(AccessLevel.PROTECTED)', () => {
      const tree = parse(`
import lombok.Getter;
import lombok.AccessLevel;
@Getter(AccessLevel.PROTECTED)
public class Order {
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.length, 1);
      assert.equal(result.symbols[0]!.visibility, 'protected');
    });
  });

  describe('collision and final', () => {
    it('skips setter for final fields', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Order {
    private final String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(
        result.symbols.map((s) => s.name),
        ['getOrderId'],
      );
    });

    it('does not suppress zero-arg getter when getX(int) exists', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Order {
    private String orderId;
    public String getOrderId(int unused) { return orderId; }
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(result.symbols.map((s) => s.name).sort(), ['getOrderId', 'setOrderId']);
      assert.equal(result.symbols.find((s) => s.name === 'getOrderId')!.parameterCount, 0);
    });

    it('suppresses when same name and arity exist (case-insensitive)', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Order {
    private String orderId;
    public String getorderId() { return orderId; }
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(
        result.symbols.map((s) => s.name),
        ['setOrderId'],
      );
    });

    it('ignores proven @Tolerate methods when checking accessor collisions', () => {
      const tree = parse(`
import lombok.Setter;
import lombok.experimental.Tolerate;
public class Order {
    @Setter private java.sql.Date date;
    @Tolerate public void setDate(String date) {}
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.length, 1);
      assert.partialDeepStrictEqual(result.symbols[0], {
        name: 'setDate',
        parameterTypes: ['java.sql.Date'],
      });
    });

    it('does not let an unproven @Tolerate unlock setter synthesis', () => {
      const tree = parse(`
import lombok.Setter;
import lombok.*;
public class Order {
    @Setter private java.sql.Date date;
    @Tolerate public void setDate(String date) {}
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.length, 0);
    });

    it('treats varargs as an arity range for collision checks', () => {
      const tree = parse(`
import lombok.Getter;
public class Order {
    @Getter private String name;
    public String getName(int... ignored) { return name; }
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.length, 0);
    });

    it('finds existing methods nested under enum body declarations', () => {
      const tree = parse(`
import lombok.Getter;
@Getter
public enum Kind {
    A, B;
    private final String code = "";
    public String getCode() { return code; }
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.length, 0);
    });
  });

  describe('@Accessors', () => {
    it('ignores unproven experimental Accessors and still emits beanspec', () => {
      const tree = parse(`
import lombok.Data;
@Data
@Accessors(fluent = true)
public class Order {
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(result.symbols.map((s) => s.name).sort(), ['getOrderId', 'setOrderId']);
    });

    it('omits when proven Accessors fluent=true', () => {
      const tree = parse(`
import lombok.Data;
import lombok.experimental.Accessors;
@Data
@Accessors(fluent = true)
public class Order {
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.length, 0);
    });

    it('models chain=true setter return as declaring type; still emits getter', () => {
      const tree = parse(`
import lombok.Data;
import lombok.experimental.Accessors;
@Data
@Accessors(chain = true)
public class Order {
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      const getter = result.symbols.find((s) => s.name === 'getOrderId')!;
      const setter = result.symbols.find((s) => s.name === 'setOrderId')!;
      assert.equal(getter.returnType, 'String');
      assert.equal(setter.returnType, 'Order');
      assert.notEqual(setter.returnType, 'void');
    });

    it('omits when prefix is configured', () => {
      const tree = parse(`
import lombok.Data;
import lombok.experimental.Accessors;
@Data
@Accessors(prefix = "m")
public class Order {
    private String mOrderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.length, 0);
    });

    it('lets field @Accessors(fluent=false) restore beanspec under class fluent=true', () => {
      const tree = parse(`
import lombok.Data;
import lombok.experimental.Accessors;
@Data
@Accessors(fluent = true)
public class Order {
    @Accessors(fluent = false)
    private String orderId;
    private String other;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(result.symbols.map((s) => s.name).sort(), ['getOrderId', 'setOrderId']);
    });

    it('lets field @Accessors(chain=false) restore void setters under class chain=true', () => {
      const tree = parse(`
import lombok.Data;
import lombok.experimental.Accessors;
@Data
@Accessors(chain = true)
public class Order {
    @Accessors(chain = false)
    private String orderId;
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.equal(result.symbols.find((s) => s.name === 'setOrderId')!.returnType, 'void');
    });
  });

  describe('nested identity', () => {
    it('keeps distinct method ids for same-tailed nested classes with same field', () => {
      const tree = parse(`
import lombok.Data;
public class Outer {
  @Data class Item { private String value; }
}
class Other {
  @Data class Item { private String value; }
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      const getters = result.nodes.filter((n) => n.properties.name === 'getValue');
      assert.equal(getters.length, 2);
      const ids = new Set(getters.map((n) => n.id));
      assert.equal(ids.size, 2);
    });
  });

  describe('enum', () => {
    it('synthesizes getters on enum with proven @Getter', () => {
      const tree = parse(`
import lombok.Getter;
@Getter
public enum Kind {
    A, B;
    private final String code;
    Kind(String code) { this.code = code; }
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      assert.deepEqual(
        result.symbols.map((s) => s.name),
        ['getCode'],
      );
    });
  });
});
