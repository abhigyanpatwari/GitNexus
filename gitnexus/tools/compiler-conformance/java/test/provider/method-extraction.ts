import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  javaRecordMethodExtractor,
  synthesizeJavaRecordComponentAccessorCaptures,
} from '../../../../../src/core/ingestion/languages/java/record-components.js';
import type { MethodExtractorContext } from '../../../../../src/core/ingestion/method-types.js';
import { methodInfoKey } from '../../../../../src/core/ingestion/utils/method-props.js';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { SupportedLanguages } from '../../../../../src/config/supported-languages.js';
const parser = new Parser();

const parseJava = (code: string) => {
  parser.setLanguage(Java);
  return parser.parse(code);
};

const javaCtx: MethodExtractorContext = {
  filePath: 'Test.java',
  language: SupportedLanguages.Java,
};

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

describe('Java MethodExtractor', () => {
  const extractor = javaRecordMethodExtractor;

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parseJava('public class Foo { }');
      assert.equal(extractor.isTypeDeclaration(tree.rootNode.child(0)!), true);
    });

    it('recognizes interface_declaration', () => {
      const tree = parseJava('public interface Bar { }');
      assert.equal(extractor.isTypeDeclaration(tree.rootNode.child(0)!), true);
    });

    it('recognizes enum_declaration', () => {
      const tree = parseJava('public enum Color { RED, GREEN }');
      assert.equal(extractor.isTypeDeclaration(tree.rootNode.child(0)!), true);
    });

    it('rejects import_declaration', () => {
      const tree = parseJava('import java.util.List;');
      assert.equal(extractor.isTypeDeclaration(tree.rootNode.child(0)!), false);
    });
  });

  describe('extract from class', () => {
    it('extracts public method with parameters', () => {
      const tree = parseJava(`
        public class UserService {
          public User findById(Long id, boolean active) {
            return null;
          }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.notEqual(result, null);
      assert.equal(result!.ownerName, 'UserService');
      assert.equal(result!.methods.length, 1);

      const m = result!.methods[0];
      assert.equal(m.name, 'findById');
      assert.equal(m.returnType, 'User');
      assert.equal(m.visibility, 'public');
      assert.equal(m.isStatic, false);
      assert.equal(m.isAbstract, false);
      assert.equal(m.isFinal, false);
      assert.equal(m.parameters.length, 2);
      assert.deepEqual(m.parameters[0], {
        name: 'id',
        type: 'Long',
        rawType: 'Long',
        isOptional: false,
        isVariadic: false,
      });
      assert.deepEqual(m.parameters[1], {
        name: 'active',
        type: 'boolean',
        rawType: 'boolean',
        isOptional: false,
        isVariadic: false,
      });
    });

    it('extracts static method', () => {
      const tree = parseJava(`
        public class MathUtils {
          public static int add(int a, int b) {
            return a + b;
          }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.equal(result!.methods[0].isStatic, true);
    });

    it('extracts final method', () => {
      const tree = parseJava(`
        public class Base {
          public final void doSomething() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.equal(result!.methods[0].isFinal, true);
    });

    it('extracts private method', () => {
      const tree = parseJava(`
        public class Foo {
          private void helper() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.equal(result!.methods[0].visibility, 'private');
    });

    it('detects package-private (default) visibility', () => {
      const tree = parseJava(`
        public class Foo {
          void internalMethod() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.equal(result!.methods[0].visibility, 'package');
    });

    it('extracts annotations', () => {
      const tree = parseJava(`
        public class Service {
          @Override
          public String toString() { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.ok(result!.methods[0].annotations.includes('@Override'));
    });

    it('extracts varargs parameter', () => {
      const tree = parseJava(`
        public class Formatter {
          public String format(String template, Object... args) { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);
      const params = result!.methods[0].parameters;

      assert.equal(params.length, 2);
      assert.equal(params[0].isVariadic, false);
      assert.equal(params[1].isVariadic, true);
      assert.equal(params[1].name, 'args');
    });

    it('extracts void return type', () => {
      const tree = parseJava(`
        public class Foo {
          public void doNothing() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.equal(result!.methods[0].returnType, 'void');
    });
  });

  describe('extract overloaded methods', () => {
    it('extracts all overloads without collision', () => {
      const tree = parseJava(`
        public class Repository {
          public User find(Long id) { return null; }
          public User find(String name, boolean active) { return null; }
          public User find(String name, String email, int limit) { return null; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.notEqual(result, null);
      const finds = result!.methods.filter((m) => m.name === 'find');
      assert.equal(finds.length, 3);
      assert.deepEqual(finds.map((m) => m.parameters.length).sort(), [1, 2, 3]);
    });
  });

  describe('extract from abstract class', () => {
    it('detects abstract methods', () => {
      const tree = parseJava(`
        public abstract class Shape {
          public abstract double area();
          public double perimeter() { return 0; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.equal(result!.methods.length, 2);

      const areaMethod = result!.methods.find((m) => m.name === 'area');
      const perimeterMethod = result!.methods.find((m) => m.name === 'perimeter');

      assert.equal(areaMethod!.isAbstract, true);
      assert.equal(perimeterMethod!.isAbstract, false);
    });
  });

  describe('extract from interface', () => {
    it('marks bodyless methods as abstract', () => {
      const tree = parseJava(`
        public interface Repository {
          User findById(Long id);
          List findAll();
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.equal(result!.methods.length, 2);
      assert.equal(result!.methods[0].isAbstract, true);
      assert.equal(result!.methods[1].isAbstract, true);
    });

    it('marks default methods as non-abstract', () => {
      const tree = parseJava(`
        public interface Greeting {
          void greet();
          default String name() { return "World"; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      const greet = result!.methods.find((m) => m.name === 'greet');
      const name = result!.methods.find((m) => m.name === 'name');

      assert.equal(greet!.isAbstract, true);
      assert.equal(name!.isAbstract, false);
    });
  });

  describe('extract from enum', () => {
    it('extracts enum methods', () => {
      const tree = parseJava(`
        public enum Planet {
          EARTH;
          public double surfaceGravity() { return 9.8; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.equal(result!.methods.length, 1);
      const sg = result!.methods.find((m) => m.name === 'surfaceGravity');
      assert.notEqual(sg, undefined);
      assert.equal(sg!.returnType, 'double');
    });

    it('extracts methods from enum constant anonymous class bodies', () => {
      const tree = parseJava(`
        public enum Operation {
          PLUS {
            public double apply(double x, double y) { return x + y; }
          };
          public abstract double apply(double x, double y);
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      const applies = result!.methods.filter((m) => m.name === 'apply');
      assert.equal(applies.length, 2);
      const abstractApply = applies.find((m) => m.isAbstract);
      const concreteApply = applies.find((m) => !m.isAbstract);
      assert.notEqual(abstractApply, undefined);
      assert.notEqual(concreteApply, undefined);
    });
  });

  describe('extract from annotation type', () => {
    it('extracts annotation element declarations', () => {
      const tree = parseJava(`
        public @interface MyAnnotation {
          String value();
          int count() default 0;
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.notEqual(result, null);
      assert.equal(result!.ownerName, 'MyAnnotation');
      assert.equal(result!.methods.length, 2);
      assert.deepEqual(result!.methods.map((m) => m.name).sort(), ['count', 'value']);
    });
  });

  describe('extract from record', () => {
    it('extracts compact constructor', () => {
      const tree = parseJava(`
        public record Point(int x, int y) {
          public Point {
            if (x < 0) throw new IllegalArgumentException();
          }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      assert.notEqual(result, null);
      const ctor = result!.methods.find((m) => m.name === 'Point');
      assert.notEqual(ctor, undefined);
      // Compact constructors inherit parameters from the record components
      assert.equal(ctor!.parameters.length, 2);
      assert.equal(ctor!.parameters[0].name, 'x');
      assert.equal(ctor!.parameters[1].name, 'y');
    });

    it('synthesizes public zero-argument accessors with full component return types', () => {
      const tree = parseJava('public record User(String name, java.util.List<String> tags) {}');
      const result = extractor.extract(tree.rootNode.child(0)!, javaCtx);

      assert.equal(result!.methods.length, 2);
      for (const expected of [
        {
          name: 'name',
          returnType: 'String',
          parameters: [],
          visibility: 'public',
        },
        {
          name: 'tags',
          returnType: 'java.util.List<String>',
          parameters: [],
          visibility: 'public',
        },
      ])
        assert.partialDeepStrictEqual(
          result!.methods.find((method) => method.name === expected.name),
          expected,
        );
    });

    it('exposes a varargs component through its array-typed accessor', () => {
      const tree = parseJava('public record Samples(String... values) {}');
      const result = extractor.extract(tree.rootNode.child(0)!, javaCtx);

      assert.partialDeepStrictEqual(
        result!.methods.find((method) => method.name === 'values'),
        {
          name: 'values',
          returnType: 'String[]',
          parameters: [],
        },
      );
    });

    it('uses the same annotated array and varargs return types in methods and scope declarations', () => {
      const tree = parseJava(
        'record Group(java.util.List<@A User> @D [] users, User @D []... rows) {}',
      );
      const record = tree.rootNode.namedChild(0)!;
      const expected = ['java.util.List<User>[]', 'User[][]'];
      const methods = extractor.extract(record, javaCtx)!.methods;
      assert.deepEqual(
        methods.map((method) => method.returnType),
        expected,
      );
      const captures = synthesizeJavaRecordComponentAccessorCaptures(tree.rootNode);
      assert.deepEqual(
        captures.flatMap((match) => match['@declaration.return-type']?.text ?? []),
        expected,
      );
    });

    it('keeps an explicit canonical accessor as the single definition', () => {
      const tree = parseJava(`
        public record User(String name) {
          public String name(/* canonical accessor */) { return name.toUpperCase(); }
        }
      `);
      const result = extractor.extract(tree.rootNode.child(0)!, javaCtx);
      const accessors = result!.methods.filter((method) => method.name === 'name');

      assert.equal(accessors.length, 1);
      assert.equal(accessors[0].line, 3);
    });

    it('does not count an explicit accessor receiver parameter toward arity', () => {
      const tree = parseJava(`
        public record User(String name) {
          public String name(User this) { return name.toUpperCase(); }
        }
      `);
      const result = extractor.extract(tree.rootNode.child(0)!, javaCtx);
      const accessors = result!.methods.filter((method) => method.name === 'name');

      assert.equal(accessors.length, 1);
      assert.deepEqual(accessors[0].parameters, []);
      assert.equal(accessors[0].line, 3);
    });

    it('retains an explicit overload alongside the implicit accessor', () => {
      const tree = parseJava(`
        public record User(String name) {
          public String name(int repeat) { return name.repeat(repeat); }
        }
      `);
      const result = extractor.extract(tree.rootNode.child(0)!, javaCtx);
      const accessors = result!.methods.filter((method) => method.name === 'name');

      assert.equal(accessors.length, 2);
      assert.deepEqual(accessors.map((method) => method.parameters.length).sort(), [0, 1]);
    });

    // #2936: the accessor is minted at the COMPONENT's position, so on a single
    // line it shares (name, line) with an explicit overload. The worker's
    // per-class map keys on that pair, so before `column` the appended implicit
    // entry evicted the source-written method and both ids collapsed to `x#0`.
    it('gives a same-line implicit accessor and explicit overload distinct map keys', () => {
      const tree = parseJava(
        'public record User(String name) { public String name(int repeat) { return name.repeat(repeat); } }',
      );
      const result = extractor.extract(tree.rootNode.child(0)!, javaCtx);
      const keys = result!.methods
        .filter((method) => method.name === 'name')
        .map((method) => methodInfoKey(method.name, method.line, method.column))
        .sort();

      assert.deepEqual(keys, ['name:1:19', 'name:1:34']);
    });

    for (const example of [
      ['a dropped component type', 'record M(int x, y) {}', ['x']],
      ['a nameless varargs component', 'record W(int... ) {}', []],
      ['an underscore component', 'record R(int _) {}', []],
      ['an underscore varargs component', 'record S(int... _) {}', []],
    ] as const) {
      it(`synthesizes no accessor for ${example[0]}`, () => {
        const [_label, source, expected] = example;

        const tree = parseJava(source);
        const result = extractor.extract(tree.rootNode.child(0)!, javaCtx);

        assert.deepEqual(
          result!.methods.map((method) => method.name),
          expected,
        );
      });
    }

    for (const example of [
      ['a marker annotation', 'record U(@Marker String name) {}', ['@Marker']],
      ['an annotation with arguments', 'record U(@Marker("x") String name) {}', ['@Marker']],
      ['several annotations', 'record U(@A @B String name) {}', ['@A', '@B']],
      ['an annotated varargs component', 'record U(@A String... xs) {}', ['@A']],
      ['no annotation', 'record U(String name) {}', []],
    ] as const) {
      it(`propagates ${example[0]} to the implicit accessor`, () => {
        const [_label, source, expected] = example;

        const tree = parseJava(source);
        const result = extractor.extract(tree.rootNode.child(0)!, javaCtx);

        assert.deepEqual(result!.methods[0]!.annotations, expected);
      });
    }
  });

  describe('extract primitive varargs', () => {
    it('extracts int... vararg type', () => {
      const tree = parseJava(`
        public class MathUtils {
          public int sum(int... nums) { return 0; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      const m = result!.methods[0];
      assert.equal(m.parameters.length, 1);
      assert.equal(m.parameters[0].type, 'int');
      assert.equal(m.parameters[0].isVariadic, true);
    });
  });

  describe('no methods', () => {
    it('returns null for class with no methods', () => {
      const tree = parseJava(`
        public class Empty {
          public int x;
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      // No method_declaration nodes → empty methods array
      assert.notEqual(result, null);
      assert.equal(result!.methods.length, 0);
    });
  });
});
