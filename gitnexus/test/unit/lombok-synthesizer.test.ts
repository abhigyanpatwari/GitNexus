/**
 * Unit test: Lombok accessor method synthesis.
 *
 * Tests the lombok-synthesizer module directly (no worker pool needed).
 * Fixtures use proven lombok imports / FQNs — bare `@Data` without provenance
 * must not synthesize.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  getterName,
  setterName,
  synthesizeLombokAccessors,
} from '../../src/core/ingestion/languages/java/lombok-synthesizer.js';

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
    expect(getterName('isEnabled', 'boolean')).toBe('isEnabled');
    expect(setterName('isEnabled', 'boolean')).toBe('setEnabled');
    expect(getterName('active', 'boolean')).toBe('isActive');
    expect(setterName('active', 'boolean')).toBe('setActive');
    expect(getterName('active', 'Boolean')).toBe('getActive');
    expect(setterName('active', 'Boolean')).toBe('setActive');
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
      expect(result.symbols).toHaveLength(4);
      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getAmount', 'getOrderId', 'setAmount', 'setOrderId']);
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
      expect(getter.returnType).toBe('String');
      expect(getter.parameterTypes).toEqual([]);
      const setter = result.symbols.find((s) => s.name === 'setOrderId')!;
      expect(setter.returnType).toBe('void');
      expect(setter.parameterTypes).toEqual(['String']);
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
      expect(result.relationships.length).toBeGreaterThan(0);
      for (const rel of result.relationships) {
        expect(rel.type).toBe('HAS_METHOD');
        expect(rel.sourceId).toBe(`Class:${FILE_PATH}:Order`);
        expect(rel.targetId.startsWith('Method:')).toBe(true);
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
      expect(result.symbols).toHaveLength(0);
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
      expect(result.symbols.map((s) => s.name).sort()).toEqual(['isActive', 'setActive']);
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
      expect(result.symbols.map((s) => s.name).sort()).toEqual(['isEnabled', 'setEnabled']);
      expect(result.symbols.find((s) => s.name === 'isIsEnabled')).toBeUndefined();
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
      expect(result.symbols.map((s) => s.name).sort()).toEqual(['getActive', 'setActive']);
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
      expect(result.symbols.map((s) => s.name)).toEqual(['getOrderId']);
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
      expect(result.symbols).toHaveLength(0);
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
      expect(result.symbols.map((s) => s.name)).toEqual(['getOrderId']);
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
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]!.visibility).toBe('protected');
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
      expect(result.symbols.map((s) => s.name)).toEqual(['getOrderId']);
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
      expect(result.symbols.map((s) => s.name).sort()).toEqual(['getOrderId', 'setOrderId']);
      expect(result.symbols.find((s) => s.name === 'getOrderId')!.parameterCount).toBe(0);
    });

    it('suppresses when same name and arity exist (case-insensitive)', () => {
      const tree = parse(`
import lombok.Data;
@Data
public class Order {
    private String orderId;
    public String getOrderId() { return orderId; }
}
`);
      const result = synthesizeLombokAccessors(
        tree,
        FILE_PATH,
        ownerMapBySimpleName(tree, FILE_PATH),
      );
      expect(result.symbols.map((s) => s.name)).toEqual(['setOrderId']);
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
      expect(result.symbols.map((s) => s.name).sort()).toEqual(['getOrderId', 'setOrderId']);
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
      expect(result.symbols).toHaveLength(0);
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
      expect(getter.returnType).toBe('String');
      expect(setter.returnType).toBe('Order');
      expect(setter.returnType).not.toBe('void');
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
      expect(result.symbols).toHaveLength(0);
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
      expect(getters.length).toBe(2);
      const ids = new Set(getters.map((n) => n.id));
      expect(ids.size).toBe(2);
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
      expect(result.symbols.map((s) => s.name)).toEqual(['getCode']);
    });
  });
});
