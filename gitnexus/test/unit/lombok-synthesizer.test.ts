/**
 * Unit test: Lombok accessor method synthesis.
 *
 * Tests the lombok-synthesizer module directly (no worker pool needed).
 * Verifies that @Data/@Getter/@Setter annotated classes produce the correct
 * synthetic getter/setter methods, with proper naming conventions, collision
 * guards, and AccessLevel.NONE suppression.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { synthesizeLombokAccessors } from '../../src/core/ingestion/languages/java/lombok-synthesizer.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(code);
}

const FILE_PATH = '/test/Order.java';

describe('synthesizeLombokAccessors', () => {
  describe('@Data annotation', () => {
    it('generates both getter and setter for each field', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
    private Long amount;
}
`);
      const classNodeIds = new Map([['Order', 'Class:/test/Order.java:Order']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // 2 fields × 2 (getter + setter) = 4 synthetic methods
      expect(result.symbols).toHaveLength(4);

      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getAmount', 'getOrderId', 'setAmount', 'setOrderId']);
    });

    it('sets correct return types and parameter types', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
}
`);
      const classNodeIds = new Map([['Order', 'Class:/test/Order.java:Order']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      const getter = result.symbols.find((s) => s.name === 'getOrderId')!;
      expect(getter.returnType).toBe('String');
      expect(getter.parameterTypes).toEqual([]);
      expect(getter.parameterCount).toBe(0);

      const setter = result.symbols.find((s) => s.name === 'setOrderId')!;
      expect(setter.returnType).toBe('void');
      expect(setter.parameterTypes).toEqual(['String']);
      expect(setter.parameterCount).toBe(1);
    });

    it('creates HAS_METHOD relationships linking to the class', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
}
`);
      const classId = 'Class:/test/Order.java:Order';
      const classNodeIds = new Map([['Order', classId]]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      for (const rel of result.relationships) {
        expect(rel.type).toBe('HAS_METHOD');
        expect(rel.sourceId).toBe(classId);
        expect(rel.confidence).toBe(1.0);
      }
      expect(result.relationships.every((r) => r.reason.startsWith('lombok-'))).toBe(true);
    });
  });

  describe('boolean field naming convention', () => {
    it('uses isXxx() for primitive boolean fields', () => {
      const tree = parse(`
@Data
public class Config {
    private boolean active;
}
`);
      const classNodeIds = new Map([['Config', 'Class:/test/Config.java:Config']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toContain('isActive');
      expect(names).not.toContain('getActive');
      // Setter is always setXxx regardless of type
      expect(names).toContain('setActive');
    });

    it('uses getXxx() for Boolean (boxed) fields', () => {
      const tree = parse(`
@Data
public class Config {
    private Boolean enabled;
}
`);
      const classNodeIds = new Map([['Config', 'Class:/test/Config.java:Config']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toContain('getEnabled');
      expect(names).not.toContain('isEnabled');
    });
  });

  describe('individual @Getter and @Setter', () => {
    it('only generates getters with @Getter', () => {
      const tree = parse(`
@Getter
public class ReadOnly {
    private String name;
}
`);
      const classNodeIds = new Map([['ReadOnly', 'Class:/test/ReadOnly.java:ReadOnly']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('getName');
    });

    it('only generates setters with @Setter', () => {
      const tree = parse(`
@Setter
public class WriteOnly {
    private String name;
}
`);
      const classNodeIds = new Map([['WriteOnly', 'Class:/test/WriteOnly.java:WriteOnly']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('setName');
    });
  });

  describe('collision guard', () => {
    it('skips getter when a hand-written method of the same name exists', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;

    public String getOrderId() {
        return customLogic();
    }
}
`);
      const classNodeIds = new Map([['Order', 'Class:/test/Order.java:Order']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // Getter is skipped (hand-written exists), setter is still generated
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('setOrderId');
    });
  });

  describe('static field exclusion', () => {
    it('does not generate accessors for static fields', () => {
      const tree = parse(`
@Data
public class Constants {
    private static String GLOBAL = "default";
    private String instance;
}
`);
      const classNodeIds = new Map([['Constants', 'Class:/test/Constants.java:Constants']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // Only the instance field gets accessors
      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getInstance', 'setInstance']);
    });
  });

  describe('AccessLevel.NONE suppression', () => {
    it('skips getter when @Getter(AccessLevel.NONE) is on a field', () => {
      const tree = parse(`
@Data
public class Order {
    @Getter(AccessLevel.NONE)
    private String secret;
    private String name;
}
`);
      const classNodeIds = new Map([['Order', 'Class:/test/Order.java:Order']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      const names = result.symbols.map((s) => s.name).sort();
      // secret getter is suppressed, but setter is still generated (@Data includes @Setter)
      expect(names).toEqual(['getName', 'setName', 'setSecret']);
      expect(names).not.toContain('getSecret');
    });
  });

  describe('no Lombok annotations', () => {
    it('returns empty result for classes without Lombok annotations', () => {
      const tree = parse(`
public class PlainClass {
    private String name;

    public String getName() { return name; }
}
`);
      const classNodeIds = new Map([['PlainClass', 'Class:/test/PlainClass.java:PlainClass']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(0);
      expect(result.nodes).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });
  });

  describe('class not in graph', () => {
    it('skips classes not present in the classNodeIds map', () => {
      const tree = parse(`
@Data
public class Orphan {
    private String name;
}
`);
      const classNodeIds = new Map<string, string>(); // empty
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      expect(result.symbols).toHaveLength(0);
    });
  });

  describe('nested classes', () => {
    it('handles nested @Data classes', () => {
      const tree = parse(`
public class Outer {
    @Data
    public static class Inner {
        private String value;
    }
}
`);
      const classNodeIds = new Map([
        ['Inner', 'Class:/test/Outer.java:Inner'],
        ['Outer', 'Class:/test/Outer.java:Outer'],
      ]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // Only Inner has @Data
      expect(result.symbols).toHaveLength(2);
      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getValue', 'setValue']);
    });
  });

  describe('multi-variable declarations', () => {
    it('handles `int x, y;` style declarations', () => {
      const tree = parse(`
@Data
public class Point {
    private int x, y;
}
`);
      const classNodeIds = new Map([['Point', 'Class:/test/Point.java:Point']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      // 2 fields × 2 accessors = 4 methods
      expect(result.symbols).toHaveLength(4);
      const names = result.symbols.map((s) => s.name).sort();
      expect(names).toEqual(['getX', 'getY', 'setX', 'setY']);
    });
  });

  describe('node properties', () => {
    it('marks synthetic methods with synthetic: lombok', () => {
      const tree = parse(`
@Data
public class Order {
    private String orderId;
}
`);
      const classNodeIds = new Map([['Order', 'Class:/test/Order.java:Order']]);
      const result = synthesizeLombokAccessors(tree, FILE_PATH, classNodeIds);

      for (const node of result.nodes) {
        expect(node.properties.synthetic).toBe('lombok');
        expect(node.properties.visibility).toBe('public');
        expect(node.properties.isStatic).toBe(false);
      }
    });
  });
});
