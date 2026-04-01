import { describe, it, expect } from 'vitest';
import { createMethodExtractor } from '../../src/core/ingestion/method-extractors/generic.js';
import {
  javaMethodConfig,
  kotlinMethodConfig,
} from '../../src/core/ingestion/method-extractors/configs/jvm.js';
import { csharpMethodConfig } from '../../src/core/ingestion/method-extractors/configs/csharp.js';
import {
  typescriptMethodConfig,
  javascriptMethodConfig,
} from '../../src/core/ingestion/method-extractors/configs/typescript-javascript.js';
import type { MethodExtractorContext } from '../../src/core/ingestion/method-types.js';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

let Kotlin: unknown;
try {
  Kotlin = require('tree-sitter-kotlin');
} catch {
  // Kotlin grammar may not be installed
}

const parser = new Parser();

const parseJava = (code: string) => {
  parser.setLanguage(Java);
  return parser.parse(code);
};

const parseKotlin = (code: string) => {
  if (!Kotlin) throw new Error('tree-sitter-kotlin not available');
  parser.setLanguage(Kotlin as Parser.Language);
  return parser.parse(code);
};

const javaCtx: MethodExtractorContext = {
  filePath: 'Test.java',
  language: SupportedLanguages.Java,
};

const kotlinCtx: MethodExtractorContext = {
  filePath: 'Test.kt',
  language: SupportedLanguages.Kotlin,
};

const parseCSharp = (code: string) => {
  parser.setLanguage(CSharp);
  return parser.parse(code);
};

const csharpCtx: MethodExtractorContext = {
  filePath: 'Test.cs',
  language: SupportedLanguages.CSharp,
};

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

describe('Java MethodExtractor', () => {
  const extractor = createMethodExtractor(javaMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parseJava('public class Foo { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes interface_declaration', () => {
      const tree = parseJava('public interface Bar { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes enum_declaration', () => {
      const tree = parseJava('public enum Color { RED, GREEN }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('rejects import_declaration', () => {
      const tree = parseJava('import java.util.List;');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(false);
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

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('UserService');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('findById');
      expect(m.returnType).toBe('User');
      expect(m.visibility).toBe('public');
      expect(m.isStatic).toBe(false);
      expect(m.isAbstract).toBe(false);
      expect(m.isFinal).toBe(false);
      expect(m.parameters).toHaveLength(2);
      expect(m.parameters[0]).toEqual({
        name: 'id',
        type: 'Long',
        isOptional: false,
        isVariadic: false,
      });
      expect(m.parameters[1]).toEqual({
        name: 'active',
        type: 'boolean',
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

      expect(result!.methods[0].isStatic).toBe(true);
    });

    it('extracts final method', () => {
      const tree = parseJava(`
        public class Base {
          public final void doSomething() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].isFinal).toBe(true);
    });

    it('extracts private method', () => {
      const tree = parseJava(`
        public class Foo {
          private void helper() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].visibility).toBe('private');
    });

    it('detects package-private (default) visibility', () => {
      const tree = parseJava(`
        public class Foo {
          void internalMethod() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].visibility).toBe('package');
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

      expect(result!.methods[0].annotations).toContain('@Override');
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

      expect(params).toHaveLength(2);
      expect(params[0].isVariadic).toBe(false);
      expect(params[1].isVariadic).toBe(true);
      expect(params[1].name).toBe('args');
    });

    it('extracts void return type', () => {
      const tree = parseJava(`
        public class Foo {
          public void doNothing() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].returnType).toBe('void');
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

      expect(result).not.toBeNull();
      const finds = result!.methods.filter((m) => m.name === 'find');
      expect(finds).toHaveLength(3);
      expect(finds.map((m) => m.parameters.length).sort()).toEqual([1, 2, 3]);
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

      expect(result!.methods).toHaveLength(2);

      const areaMethod = result!.methods.find((m) => m.name === 'area');
      const perimeterMethod = result!.methods.find((m) => m.name === 'perimeter');

      expect(areaMethod!.isAbstract).toBe(true);
      expect(perimeterMethod!.isAbstract).toBe(false);
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

      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].isAbstract).toBe(true);
      expect(result!.methods[1].isAbstract).toBe(true);
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

      expect(greet!.isAbstract).toBe(true);
      expect(name!.isAbstract).toBe(false);
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

      expect(result!.methods).toHaveLength(1);
      const sg = result!.methods.find((m) => m.name === 'surfaceGravity');
      expect(sg).toBeDefined();
      expect(sg!.returnType).toBe('double');
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
      expect(applies).toHaveLength(2);
      const abstractApply = applies.find((m) => m.isAbstract);
      const concreteApply = applies.find((m) => !m.isAbstract);
      expect(abstractApply).toBeDefined();
      expect(concreteApply).toBeDefined();
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

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('MyAnnotation');
      expect(result!.methods).toHaveLength(2);
      expect(result!.methods.map((m) => m.name).sort()).toEqual(['count', 'value']);
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

      expect(result).not.toBeNull();
      const ctor = result!.methods.find((m) => m.name === 'Point');
      expect(ctor).toBeDefined();
      // Compact constructors inherit parameters from the record components
      expect(ctor!.parameters).toHaveLength(2);
      expect(ctor!.parameters[0].name).toBe('x');
      expect(ctor!.parameters[1].name).toBe('y');
    });
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
      expect(m.parameters).toHaveLength(1);
      expect(m.parameters[0].type).toBe('int');
      expect(m.parameters[0].isVariadic).toBe(true);
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
      expect(result).not.toBeNull();
      expect(result!.methods).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

const describeKotlin = Kotlin ? describe : describe.skip;

describeKotlin('Kotlin MethodExtractor', () => {
  const extractor = createMethodExtractor(kotlinMethodConfig);

  describe('extract from class', () => {
    it('extracts public method with parameters', () => {
      const tree = parseKotlin(`
        class UserService {
          fun findById(id: Long, active: Boolean): User? {
            return null
          }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('UserService');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('findById');
      expect(m.visibility).toBe('public');
      expect(m.isStatic).toBe(false);
      expect(m.isAbstract).toBe(false);
      expect(m.parameters).toHaveLength(2);
    });

    it('extracts private method', () => {
      const tree = parseKotlin(`
        class Foo {
          private fun helper(): Int = 42
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      const m = result!.methods.find((m) => m.name === 'helper');
      expect(m).toBeDefined();
      expect(m!.visibility).toBe('private');
    });
  });

  describe('extract vararg parameter', () => {
    it('detects vararg as isVariadic', () => {
      const tree = parseKotlin(`
        class Logger {
          fun log(vararg messages: String) { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result).not.toBeNull();
      const m = result!.methods[0];
      expect(m.parameters).toHaveLength(1);
      expect(m.parameters[0].name).toBe('messages');
      expect(m.parameters[0].isVariadic).toBe(true);
    });
  });

  describe('extension functions', () => {
    it('extracts receiverType for extension functions', () => {
      const tree = parseKotlin(`
        class StringUtils {
          fun String.addBang(): String = this + "!"
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result).not.toBeNull();
      const m = result!.methods[0];
      expect(m.name).toBe('addBang');
      expect(m.receiverType).toBe('String');
    });

    it('returns null receiverType for regular methods', () => {
      const tree = parseKotlin(`
        class Foo {
          fun bar(): Int = 42
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result!.methods[0].receiverType).toBeNull();
    });
  });

  describe('extract from abstract class', () => {
    it('detects abstract methods', () => {
      const tree = parseKotlin(`
        abstract class Shape {
          abstract fun area(): Double
          fun description(): String = "shape"
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      const area = result!.methods.find((m) => m.name === 'area');
      const desc = result!.methods.find((m) => m.name === 'description');

      expect(area).toBeDefined();
      expect(area!.isAbstract).toBe(true);
      expect(desc).toBeDefined();
      expect(desc!.isAbstract).toBe(false);
    });
  });

  describe('extract from interface', () => {
    it('marks bodyless methods as abstract', () => {
      const tree = parseKotlin(`
        interface Repository {
          fun findById(id: Long): Any?
          fun findAll(): List<Any>
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result!.methods).toHaveLength(2);
      for (const m of result!.methods) {
        expect(m.isAbstract).toBe(true);
      }
    });
  });

  describe('default visibility', () => {
    it('defaults to public', () => {
      const tree = parseKotlin(`
        class Foo {
          fun bar() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result!.methods[0].visibility).toBe('public');
    });
  });

  describe('isFinal semantics', () => {
    it('regular methods are final by default', () => {
      const tree = parseKotlin(`
        class Foo {
          fun bar() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result!.methods[0].isFinal).toBe(true);
    });

    it('open methods are not final', () => {
      const tree = parseKotlin(`
        open class Foo {
          open fun bar() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result!.methods[0].isFinal).toBe(false);
    });

    it('abstract methods are not final', () => {
      const tree = parseKotlin(`
        abstract class Foo {
          abstract fun bar(): Int
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result!.methods[0].isFinal).toBe(false);
      expect(result!.methods[0].isAbstract).toBe(true);
    });

    it('interface methods are not final (domain invariant)', () => {
      const tree = parseKotlin(`
        interface Foo {
          fun bar(): Int
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result!.methods[0].isAbstract).toBe(true);
      expect(result!.methods[0].isFinal).toBe(false);
    });
  });

  describe('companion object', () => {
    it('extracts methods from companion object', () => {
      const tree = parseKotlin(`
        class UserService {
          companion object {
            fun create(): UserService = UserService()
          }
        }
      `);
      // companion_object is inside class_body
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.namedChild(1)!;
      const companion = classBody.namedChild(0)!;
      const result = extractor.extract(companion, kotlinCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Companion');
      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('create');
      expect(result!.methods[0].isStatic).toBe(true);
    });

    it('extracts methods from named companion object', () => {
      const tree = parseKotlin(`
        class Foo {
          companion object Factory {
            fun build(): Foo = Foo()
          }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.namedChild(1)!;
      const companion = classBody.namedChild(0)!;
      const result = extractor.extract(companion, kotlinCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Factory');
      expect(result!.methods[0].name).toBe('build');
      expect(result!.methods[0].isStatic).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

describe('C# MethodExtractor', () => {
  const extractor = createMethodExtractor(csharpMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parseCSharp('public class Foo { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes interface_declaration', () => {
      const tree = parseCSharp('public interface IBar { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes struct_declaration', () => {
      const tree = parseCSharp('public struct Point { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes record_declaration', () => {
      const tree = parseCSharp('public record Person { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('rejects using_directive', () => {
      const tree = parseCSharp('using System;');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(false);
    });
  });

  describe('extract from class', () => {
    it('extracts public method with parameters', () => {
      const tree = parseCSharp(`
        public class UserService {
          public User FindById(int id, bool active) { return null; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('UserService');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('FindById');
      expect(m.returnType).toBe('User');
      expect(m.visibility).toBe('public');
      expect(m.isStatic).toBe(false);
      expect(m.isAbstract).toBe(false);
      expect(m.isFinal).toBe(false);
      expect(m.parameters).toHaveLength(2);
      expect(m.parameters[0]).toEqual({
        name: 'id',
        type: 'int',
        isOptional: false,
        isVariadic: false,
      });
      expect(m.parameters[1]).toEqual({
        name: 'active',
        type: 'bool',
        isOptional: false,
        isVariadic: false,
      });
    });

    it('extracts static method', () => {
      const tree = parseCSharp(`
        public class MathUtils {
          public static int Add(int a, int b) { return a + b; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].isStatic).toBe(true);
    });

    it('extracts private method (default visibility)', () => {
      const tree = parseCSharp(`
        public class Foo {
          void InternalMethod() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].visibility).toBe('private');
    });

    it('extracts sealed method', () => {
      const tree = parseCSharp(`
        public class Derived {
          public sealed override string ToString() { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].isFinal).toBe(true);
      expect(result!.methods[0].isOverride).toBe(true);
    });
  });

  describe('extract from abstract class', () => {
    it('detects abstract methods', () => {
      const tree = parseCSharp(`
        public abstract class Shape {
          public abstract double Area();
          public double Perimeter() { return 0; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods).toHaveLength(2);

      const areaMethod = result!.methods.find((m) => m.name === 'Area');
      const perimeterMethod = result!.methods.find((m) => m.name === 'Perimeter');

      expect(areaMethod!.isAbstract).toBe(true);
      expect(perimeterMethod!.isAbstract).toBe(false);
    });
  });

  describe('extract from interface', () => {
    it('marks bodyless methods as abstract', () => {
      const tree = parseCSharp(`
        public interface IRepository {
          void Save(int id);
          string FindAll();
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].isAbstract).toBe(true);
      expect(result!.methods[1].isAbstract).toBe(true);
    });
  });

  describe('extract params (variadic)', () => {
    it('detects params as isVariadic', () => {
      const tree = parseCSharp(`
        public class Formatter {
          public string Format(string template, params object[] args) { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);
      const params = result!.methods[0].parameters;

      expect(params).toHaveLength(2);
      expect(params[0].isVariadic).toBe(false);
      expect(params[1].isVariadic).toBe(true);
      expect(params[1].name).toBe('args');
    });
  });

  describe('extract out/ref parameters', () => {
    it('handles out parameter (type prefixed with modifier)', () => {
      const tree = parseCSharp(`
        public class Parser {
          public bool TryParse(string input, out int result) { return false; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);
      const params = result!.methods[0].parameters;

      expect(params).toHaveLength(2);
      expect(params[0].name).toBe('input');
      expect(params[1].name).toBe('result');
      expect(params[1].type).toBe('out int');
    });

    it('handles ref parameter', () => {
      const tree = parseCSharp(`
        public class Swapper {
          public void Swap(ref int a, ref int b) { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);
      const params = result!.methods[0].parameters;

      expect(params).toHaveLength(2);
      expect(params[0].type).toBe('ref int');
      expect(params[1].type).toBe('ref int');
    });
  });

  describe('extract optional parameters', () => {
    it('detects optional with defaults', () => {
      const tree = parseCSharp(`
        public class Logger {
          public void Log(string message, int level = 0) { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);
      const params = result!.methods[0].parameters;

      expect(params).toHaveLength(2);
      expect(params[0].isOptional).toBe(false);
      expect(params[1].isOptional).toBe(true);
    });
  });

  describe('extract attributes', () => {
    it('extracts attribute names', () => {
      const tree = parseCSharp(`
        public class Controller {
          [HttpGet]
          [Authorize]
          public string GetAll() { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].annotations).toContain('@HttpGet');
      expect(result!.methods[0].annotations).toContain('@Authorize');
    });

    it('skips targeted attributes like [return: NotNull]', () => {
      const tree = parseCSharp(`
        public class Service {
          [return: MarshalAs(UnmanagedType.Bool)]
          [Obsolete]
          public bool Check() { return true; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      // [Obsolete] is a method attribute, [return: MarshalAs(...)] targets the return value
      expect(result!.methods[0].annotations).toContain('@Obsolete');
      expect(result!.methods[0].annotations).not.toContain('@MarshalAs');
    });
  });

  describe('extract constructor', () => {
    it('extracts constructor', () => {
      const tree = parseCSharp(`
        public class Service {
          public Service(string name) { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      const ctor = result!.methods.find((m) => m.name === 'Service');
      expect(ctor).toBeDefined();
      expect(ctor!.returnType).toBeNull();
      expect(ctor!.parameters).toHaveLength(1);
      expect(ctor!.parameters[0].name).toBe('name');
    });

    it('extracts static constructor as isStatic: true with same name as class', () => {
      const tree = parseCSharp(`
        public class Config {
          static Config() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      const ctor = result!.methods.find((m) => m.name === 'Config');
      expect(ctor).toBeDefined();
      expect(ctor!.isStatic).toBe(true);
      expect(ctor!.parameters).toHaveLength(0);
    });
  });

  describe('extract from struct', () => {
    it('extracts struct methods', () => {
      const tree = parseCSharp(`
        public struct Point {
          public double Distance() { return 0; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Point');
      expect(result!.methods).toHaveLength(1);
    });
  });

  describe('extract from record', () => {
    it('extracts record methods', () => {
      const tree = parseCSharp(`
        public record Person {
          public string FullName() { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Person');
      expect(result!.methods).toHaveLength(1);
    });
  });

  describe('internal visibility', () => {
    it('detects internal visibility', () => {
      const tree = parseCSharp(`
        public class Foo {
          internal void InternalMethod() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].visibility).toBe('internal');
    });
  });

  describe('extract destructor', () => {
    it('extracts destructor declaration', () => {
      const tree = parseCSharp(`
        public class Resource {
          ~Resource() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      const dtor = result!.methods.find((m) => m.name === '~Resource');
      expect(dtor).toBeDefined();
      expect(dtor!.returnType).toBeNull();
    });
  });

  describe('extract operator overload', () => {
    it('extracts operator+ declaration', () => {
      const tree = parseCSharp(`
        public class Vector {
          public static Vector operator +(Vector a, Vector b) { return a; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      const op = result!.methods.find((m) => m.name === 'operator +');
      expect(op).toBeDefined();
      expect(op!.isStatic).toBe(true);
      expect(op!.returnType).toBe('Vector');
      expect(op!.parameters).toHaveLength(2);
    });
  });

  describe('extract conversion operator', () => {
    it('extracts implicit conversion operator', () => {
      const tree = parseCSharp(`
        public class Celsius {
          public static implicit operator double(Celsius c) { return 0; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      const conv = result!.methods.find((m) => m.name === 'implicit operator double');
      expect(conv).toBeDefined();
      expect(conv!.isStatic).toBe(true);
      expect(conv!.returnType).toBe('double');
      expect(conv!.parameters).toHaveLength(1);
    });
  });

  describe('extract in parameter modifier', () => {
    it('handles in parameter (read-only ref)', () => {
      const tree = parseCSharp(`
        public class Calculator {
          public double Calculate(in double value) { return value; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);
      const params = result!.methods[0].parameters;

      expect(params).toHaveLength(1);
      expect(params[0].name).toBe('value');
      expect(params[0].type).toBe('in double');
    });
  });

  describe('extract this parameter (extension methods)', () => {
    it('prefixes type with this for extension method parameter', () => {
      const tree = parseCSharp(`
        public static class StringExtensions {
          public static bool IsNullOrEmpty(this string s) { return false; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);
      const params = result!.methods[0].parameters;

      expect(params).toHaveLength(1);
      expect(params[0].name).toBe('s');
      expect(params[0].type).toBe('this string');
    });
  });

  describe('compound visibility', () => {
    it('detects protected internal', () => {
      const tree = parseCSharp(`
        public class Foo {
          protected internal void SharedMethod() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].visibility).toBe('protected internal');
    });

    it('detects private protected', () => {
      const tree = parseCSharp(`
        public class Foo {
          private protected void RestrictedMethod() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].visibility).toBe('private protected');
    });
  });

  describe('expression-bodied members', () => {
    it('extracts expression-bodied method', () => {
      const tree = parseCSharp(`
        public class MathUtils {
          public int Double(int x) => x * 2;
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('Double');
      expect(result!.methods[0].returnType).toBe('int');
      expect(result!.methods[0].parameters).toHaveLength(1);
    });
  });

  describe('primary constructor (C# 12)', () => {
    it('extracts primary constructor from class declaration', () => {
      const tree = parseCSharp(`
        public class Point(int x, int y) {
          public double Distance() => 0;
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      expect(result!.methods).toHaveLength(2);

      const ctor = result!.methods.find((m) => m.name === 'Point');
      expect(ctor).toBeDefined();
      expect(ctor!.returnType).toBeNull();
      expect(ctor!.parameters).toHaveLength(2);
      expect(ctor!.parameters[0]).toEqual({
        name: 'x',
        type: 'int',
        isOptional: false,
        isVariadic: false,
      });

      const method = result!.methods.find((m) => m.name === 'Distance');
      expect(method).toBeDefined();
    });

    it('extracts primary constructor from record declaration', () => {
      const tree = parseCSharp(`
        public record Person(string Name, int Age);
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      const ctor = result!.methods.find((m) => m.name === 'Person');
      expect(ctor).toBeDefined();
      expect(ctor!.parameters).toHaveLength(2);
      expect(ctor!.parameters[0].name).toBe('Name');
      expect(ctor!.parameters[1].name).toBe('Age');
    });
  });

  describe('virtual / override / async modifiers', () => {
    it('detects virtual method', () => {
      const tree = parseCSharp(`
        public class Base {
          public virtual void Process() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].isVirtual).toBe(true);
      expect(result!.methods[0].isOverride).toBeUndefined();
    });

    it('detects override method', () => {
      const tree = parseCSharp(`
        public class Derived {
          public override void Process() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].isOverride).toBe(true);
      expect(result!.methods[0].isVirtual).toBeUndefined();
    });

    it('detects async method', () => {
      const tree = parseCSharp(`
        public class Service {
          public async Task<string> FetchData() { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].isAsync).toBe(true);
    });

    it('regular method has no virtual/override/async', () => {
      const tree = parseCSharp(`
        public class Foo {
          public void Bar() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].isVirtual).toBeUndefined();
      expect(result!.methods[0].isOverride).toBeUndefined();
      expect(result!.methods[0].isAsync).toBeUndefined();
    });
  });

  describe('record struct', () => {
    // tree-sitter-c-sharp ^0.23.1 emits record_declaration for 'record struct' —
    // there is no separate record_struct_declaration node type.
    it('recognizes record struct via record_declaration', () => {
      const tree = parseCSharp('public record struct Point { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('extracts methods from record struct', () => {
      const tree = parseCSharp(`
        public record struct Measurement(double Value) {
          public string Format() { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Measurement');
      expect(result!.methods.find((m) => m.name === 'Format')).toBeDefined();
    });

    it('extracts primary constructor from record struct', () => {
      const tree = parseCSharp('public record struct Point(int X, int Y);');
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      const ctor = result!.methods.find((m) => m.name === 'Point');
      expect(ctor).toBeDefined();
      expect(ctor!.parameters).toHaveLength(2);
    });
  });

  describe('partial methods', () => {
    it('detects partial method declaration (no body)', () => {
      const tree = parseCSharp(`
        public partial class Foo {
          partial void OnChanged();
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      const m = result!.methods.find((m) => m.name === 'OnChanged');
      expect(m).toBeDefined();
      expect(m!.isPartial).toBe(true);
      // partial declaration-only is not abstract — it's a compile-time slot
      expect(m!.isAbstract).toBe(false);
    });

    it('detects partial method implementation (with body)', () => {
      const tree = parseCSharp(`
        public partial class Foo {
          partial void OnChanged() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      const m = result!.methods.find((m) => m.name === 'OnChanged');
      expect(m).toBeDefined();
      expect(m!.isPartial).toBe(true);
    });

    // When both declaration and implementation coexist in the same
    // declaration_list, two MethodInfo entries are produced (one per node).
    // Deduplication across partial class files is the caller's responsibility.
    it('produces two entries when declaration and implementation coexist', () => {
      const tree = parseCSharp(`
        public partial class Foo {
          partial void OnChanged();
          partial void OnChanged() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      const partials = result!.methods.filter((m) => m.name === 'OnChanged');
      expect(partials).toHaveLength(2);
      for (const m of partials) {
        expect(m.isPartial).toBe(true);
      }
    });

    // Generic method type parameters are stripped from the name.
    // public T GetValue<T>() → name: 'GetValue' (no <T>).
    // This is intentional — the call graph uses names, not signatures.
    it('generic method type parameters are stripped from name', () => {
      const tree = parseCSharp(`
        public class Repo {
          public T GetValue<T>() { return default; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, csharpCtx);

      expect(result!.methods[0].name).toBe('GetValue');
    });
  });
});

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

const parseTypeScript = (code: string) => {
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code);
};

const tsCtx: MethodExtractorContext = {
  filePath: 'Test.ts',
  language: SupportedLanguages.TypeScript,
};

describe('TypeScript MethodExtractor', () => {
  const extractor = createMethodExtractor(typescriptMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parseTypeScript('class Foo { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes abstract_class_declaration', () => {
      const tree = parseTypeScript('abstract class Foo { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes interface_declaration', () => {
      const tree = parseTypeScript('interface Bar { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('rejects function_declaration', () => {
      const tree = parseTypeScript('function hello() {}');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(false);
    });
  });

  describe('extract', () => {
    it('extracts typed method with return type and parameters', () => {
      const tree = parseTypeScript(`
        class UserService {
          greet(name: string, age: number): string {
            return name;
          }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('UserService');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('greet');
      expect(m.returnType).toBe('string');
      expect(m.visibility).toBe('public');
      expect(m.isStatic).toBe(false);
      expect(m.isAbstract).toBe(false);
      expect(m.parameters).toHaveLength(2);
      expect(m.parameters[0]).toEqual({
        name: 'name',
        type: 'string',
        isOptional: false,
        isVariadic: false,
      });
      expect(m.parameters[1]).toEqual({
        name: 'age',
        type: 'number',
        isOptional: false,
        isVariadic: false,
      });
    });

    it('extracts static method', () => {
      const tree = parseTypeScript(`
        class MathUtils {
          static add(a: number, b: number): number { return a + b; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result!.methods[0].isStatic).toBe(true);
      expect(result!.methods[0].name).toBe('add');
    });

    it('extracts abstract class with abstract and concrete methods', () => {
      const tree = parseTypeScript(`
        abstract class Shape {
          abstract area(): number;
          describe(): string { return "shape"; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result).not.toBeNull();
      expect(result!.methods).toHaveLength(2);

      const abstractMethod = result!.methods.find((m) => m.name === 'area');
      const concreteMethod = result!.methods.find((m) => m.name === 'describe');
      expect(abstractMethod!.isAbstract).toBe(true);
      expect(abstractMethod!.returnType).toBe('number');
      expect(concreteMethod!.isAbstract).toBe(false);
      expect(concreteMethod!.returnType).toBe('string');
    });

    it('extracts interface methods as abstract', () => {
      const tree = parseTypeScript(`
        interface Printable {
          print(format: string): void;
          getLabel(): string;
        }
      `);
      const interfaceNode = tree.rootNode.child(0)!;
      const result = extractor.extract(interfaceNode, tsCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Printable');
      expect(result!.methods).toHaveLength(2);
      expect(result!.methods.every((m) => m.isAbstract)).toBe(true);

      const printMethod = result!.methods.find((m) => m.name === 'print');
      expect(printMethod!.parameters[0]).toEqual({
        name: 'format',
        type: 'string',
        isOptional: false,
        isVariadic: false,
      });
      expect(printMethod!.returnType).toBe('void');
    });

    it('extracts private and protected visibility', () => {
      const tree = parseTypeScript(`
        class Account {
          private secret(): void {}
          protected validate(): boolean { return true; }
          public display(): void {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result!.methods).toHaveLength(3);
      const secret = result!.methods.find((m) => m.name === 'secret');
      const validate = result!.methods.find((m) => m.name === 'validate');
      const display = result!.methods.find((m) => m.name === 'display');
      expect(secret!.visibility).toBe('private');
      expect(validate!.visibility).toBe('protected');
      expect(display!.visibility).toBe('public');
    });

    it('extracts optional and rest parameters', () => {
      const tree = parseTypeScript(`
        class Logger {
          log(message: string, level?: string, ...tags: string[]): void {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(3);
      expect(params[0]).toEqual({
        name: 'message',
        type: 'string',
        isOptional: false,
        isVariadic: false,
      });
      expect(params[1].name).toBe('level');
      expect(params[1].isOptional).toBe(true);
      expect(params[1].isVariadic).toBe(false);
      expect(params[2].name).toBe('tags');
      expect(params[2].isOptional).toBe(false);
      expect(params[2].isVariadic).toBe(true);
    });

    it('extracts default parameter as optional', () => {
      const tree = parseTypeScript(`
        class Formatter {
          format(value: string, prefix: string = ">>") { return prefix + value; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(2);
      expect(params[1].name).toBe('prefix');
      expect(params[1].isOptional).toBe(true);
    });

    it('extracts decorators as annotations', () => {
      const tree = parseTypeScript(`
        class Controller {
          @Log
          @deprecated("use newMethod")
          handle(req: Request): void {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      const annotations = result!.methods[0].annotations;
      expect(annotations).toContain('@Log');
      expect(annotations).toContain('@deprecated');
    });

    it('extracts async method', () => {
      const tree = parseTypeScript(`
        class ApiClient {
          async fetch(url: string): Promise<Response> { return new Response(); }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result!.methods[0].isAsync).toBe(true);
      expect(result!.methods[0].name).toBe('fetch');
      expect(result!.methods[0].returnType).toBe('Promise');
    });

    it('extracts constructor', () => {
      const tree = parseTypeScript(`
        class Person {
          constructor(public name: string, private age: number) {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result!.methods).toHaveLength(1);
      const ctor = result!.methods[0];
      expect(ctor.name).toBe('constructor');
      expect(ctor.parameters).toHaveLength(2);
      expect(ctor.parameters[0].name).toBe('name');
      expect(ctor.parameters[0].type).toBe('string');
      expect(ctor.parameters[1].name).toBe('age');
      expect(ctor.parameters[1].type).toBe('number');
    });

    it('extracts override method', () => {
      const tree = parseTypeScript(`
        class Child extends Parent {
          override toString(): string { return "child"; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result!.methods[0].name).toBe('toString');
      expect(result!.methods[0].isOverride).toBe(true);
    });

    it('extracts getter and setter as methods', () => {
      const tree = parseTypeScript(`
        class Config {
          get value(): number { return 1; }
          set value(v: number) {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      // Getter and setter both have name 'value' (no get/set prefix from extractName)
      expect(result!.methods).toHaveLength(2);
      const getter = result!.methods[0];
      const setter = result!.methods[1];
      expect(getter.name).toBe('value');
      expect(getter.parameters).toHaveLength(0);
      expect(getter.returnType).toBe('number');
      expect(setter.name).toBe('value');
      expect(setter.parameters).toHaveLength(1);
      expect(setter.parameters[0].name).toBe('v');
    });

    it('extracts destructured parameter', () => {
      const tree = parseTypeScript(`
        class Handler {
          handle({ method, path }: Request): void {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(1);
      // Destructured params extract the pattern text and type from annotation
      expect(params[0].name).toBe('{ method, path }');
      expect(params[0].type).toBe('Request');
    });

    it('extracts generator method as method_definition', () => {
      const tree = parseTypeScript(`
        class Stream {
          *items(): Generator<number> { yield 1; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('items');
      expect(result!.methods[0].returnType).toBe('Generator');
    });

    it('extracts async generator method with isAsync true', () => {
      const tree = parseTypeScript(`
        class Stream {
          async *values(): AsyncGenerator<number> { yield 1; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('values');
      expect(result!.methods[0].isAsync).toBe(true);
      expect(result!.methods[0].returnType).toBe('AsyncGenerator');
    });

    it('extracts computed property name with brackets', () => {
      const tree = parseTypeScript(`
        class Iterable {
          [Symbol.iterator](): Iterator<number> { return this; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result!.methods).toHaveLength(1);
      // Computed names include brackets — this is intentional for static analysis disambiguation
      expect(result!.methods[0].name).toBe('[Symbol.iterator]');
    });

    it('extracts class-level method overloads', () => {
      const tree = parseTypeScript(`
        class Parser {
          parse(input: string): string;
          parse(input: number): number;
          parse(input: string | number): string | number { return input; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      // Two overload signatures (method_signature) + one implementation (method_definition) = 3
      const parseMethods = result!.methods.filter((m) => m.name === 'parse');
      expect(parseMethods).toHaveLength(3);
      // Overload signatures inside a class body are not abstract
      for (const m of parseMethods) {
        expect(m.isAbstract).toBe(false);
      }
    });

    it('filters out this-parameter (compile-time constraint)', () => {
      const tree = parseTypeScript(`
        class Handler {
          handle(this: void, event: Event): void {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      const params = result!.methods[0].parameters;
      // 'this' is not a real parameter — only 'event' should appear
      expect(params).toHaveLength(1);
      expect(params[0].name).toBe('event');
      expect(params[0].type).toBe('Event');
    });

    it('does not false-positive on methods named after soft keywords', () => {
      const tree = parseTypeScript(`
        class Foo {
          static abstract() {}
          static() {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      const abstractMethod = result!.methods.find((m) => m.name === 'abstract');
      expect(abstractMethod).toBeDefined();
      expect(abstractMethod!.isStatic).toBe(true);
      expect(abstractMethod!.isAbstract).toBe(false); // name, not keyword

      const staticMethod = result!.methods.find((m) => m.name === 'static');
      expect(staticMethod).toBeDefined();
      expect(staticMethod!.isStatic).toBe(false); // name, not keyword
    });

    it('extracts destructured rest parameter via required_parameter + rest_pattern', () => {
      const tree = parseTypeScript(`
        class Router {
          route(base: string, ...{ method, path }: RouteConfig): void {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(2);
      expect(params[0].name).toBe('base');
      expect(params[1].name).toBe('{ method, path }');
      expect(params[1].isVariadic).toBe(true);
      expect(params[1].type).toBe('RouteConfig');
    });

    it('extracts ES2022 #private method as visibility private', () => {
      const tree = parseTypeScript(`
        class Vault {
          #decrypt(data: string): string { return data; }
          public read(): string { return this.#decrypt("x"); }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      const decrypt = result!.methods.find((m) => m.name === '#decrypt');
      expect(decrypt).toBeDefined();
      expect(decrypt!.visibility).toBe('private');
      expect(decrypt!.parameters[0].type).toBe('string');

      const read = result!.methods.find((m) => m.name === 'read');
      expect(read!.visibility).toBe('public');
    });

    it('extracts generic method without type params in name', () => {
      const tree = parseTypeScript(`
        class Mapper {
          transform<T, U>(input: T, fn: (x: T) => U): U { return fn(input); }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      const m = result!.methods[0];
      expect(m.name).toBe('transform');
      expect(m.parameters).toHaveLength(2);
      expect(m.parameters[0].name).toBe('input');
      expect(m.parameters[0].type).toBe('T');
    });

    it('returns empty methods for class with no methods', () => {
      const tree = parseTypeScript(`
        class Empty {}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, tsCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Empty');
      expect(result!.methods).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

const parseJavaScript = (code: string) => {
  parser.setLanguage(JavaScript);
  return parser.parse(code);
};

const jsCtx: MethodExtractorContext = {
  filePath: 'Test.js',
  language: SupportedLanguages.JavaScript,
};

describe('JavaScript MethodExtractor', () => {
  const extractor = createMethodExtractor(javascriptMethodConfig);

  describe('extract', () => {
    it('extracts class method with default public visibility and null types', () => {
      const tree = parseJavaScript(`
        class Greeter {
          greet(name) { return "Hello " + name; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, jsCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Greeter');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('greet');
      expect(m.returnType).toBeNull();
      expect(m.visibility).toBe('public');
      expect(m.isAbstract).toBe(false);
      expect(m.parameters).toHaveLength(1);
      expect(m.parameters[0]).toEqual({
        name: 'name',
        type: null,
        isOptional: false,
        isVariadic: false,
      });
    });

    it('extracts static method and constructor', () => {
      const tree = parseJavaScript(`
        class Factory {
          constructor(type) { this.type = type; }
          static create(type) { return new Factory(type); }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, jsCtx);

      expect(result!.methods).toHaveLength(2);
      const ctor = result!.methods.find((m) => m.name === 'constructor');
      const create = result!.methods.find((m) => m.name === 'create');
      expect(ctor).toBeDefined();
      expect(create!.isStatic).toBe(true);
    });

    it('extracts default parameter as optional and rest as variadic', () => {
      const tree = parseJavaScript(`
        class EventEmitter {
          emit(event, data = null, ...listeners) {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, jsCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(3);
      expect(params[0]).toEqual({
        name: 'event',
        type: null,
        isOptional: false,
        isVariadic: false,
      });
      expect(params[1].name).toBe('data');
      expect(params[1].isOptional).toBe(true);
      expect(params[2].name).toBe('listeners');
      expect(params[2].isVariadic).toBe(true);
    });

    it('does not detect abstract or interface types (JS has neither)', () => {
      const tree = parseJavaScript(`
        class Shape {
          area() { return 0; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, jsCtx);

      expect(result!.methods[0].isAbstract).toBe(false);
      expect(result!.methods[0].isFinal).toBe(false);
    });

    it('extracts private field method with # prefix', () => {
      const tree = parseJavaScript(`
        class Encapsulated {
          #internal() { return 42; }
          expose() { return this.#internal(); }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, jsCtx);

      const internal = result!.methods.find((m) => m.name === '#internal');
      expect(internal).toBeDefined();
      expect(internal!.name).toBe('#internal');
      // ES2022 private methods (#name) are inherently private
      expect(internal!.visibility).toBe('private');
    });

    it('extracts destructured object parameter', () => {
      const tree = parseJavaScript(`
        class Handler {
          handle({ method, path }) {}
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, jsCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(1);
      expect(params[0].name).toBe('{ method, path }');
      expect(params[0].type).toBeNull();
    });

    it('extracts async method', () => {
      const tree = parseJavaScript(`
        class Client {
          async fetch(url) { return null; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, jsCtx);

      expect(result!.methods[0].isAsync).toBe(true);
      expect(result!.methods[0].name).toBe('fetch');
    });
  });
});
