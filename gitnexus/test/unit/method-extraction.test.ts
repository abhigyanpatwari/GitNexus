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
import { cppMethodConfig } from '../../src/core/ingestion/method-extractors/configs/c-cpp.js';
import { pythonMethodConfig } from '../../src/core/ingestion/method-extractors/configs/python.js';
import { rubyMethodConfig } from '../../src/core/ingestion/method-extractors/configs/ruby.js';
import { rustMethodConfig } from '../../src/core/ingestion/method-extractors/configs/rust.js';
import { dartMethodConfig } from '../../src/core/ingestion/method-extractors/configs/dart.js';
import { phpMethodConfig } from '../../src/core/ingestion/method-extractors/configs/php.js';
import { swiftMethodConfig } from '../../src/core/ingestion/method-extractors/configs/swift.js';
import { goMethodConfig } from '../../src/core/ingestion/method-extractors/configs/go.js';
import type { MethodExtractorContext } from '../../src/core/ingestion/method-types.js';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import Go from 'tree-sitter-go';
import CSharp from 'tree-sitter-c-sharp';
import CPP from 'tree-sitter-cpp';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';
import Rust from 'tree-sitter-rust';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

let Kotlin: unknown;
try {
  Kotlin = require('tree-sitter-kotlin');
} catch {
  // Kotlin grammar may not be installed
}

let Dart: unknown;
try {
  Dart = require('tree-sitter-dart');
  // Verify the grammar actually works with the installed tree-sitter version
  const testParser = new Parser();
  testParser.setLanguage(Dart as Parser.Language);
} catch {
  Dart = null;
}

let Swift: unknown;
try {
  Swift = require('tree-sitter-swift');
  // Verify the grammar actually works with the installed tree-sitter version
  const testParser = new Parser();
  testParser.setLanguage(Swift as Parser.Language);
} catch {
  Swift = null;
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
      expect(result!.methods[0].returnType).toBe('Promise<Response>');
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
      expect(result!.methods[0].returnType).toBe('Generator<number>');
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
      expect(result!.methods[0].returnType).toBe('AsyncGenerator<number>');
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

// ---------------------------------------------------------------------------
// C++
// ---------------------------------------------------------------------------

const parseCPP = (code: string) => {
  parser.setLanguage(CPP);
  return parser.parse(code);
};

const cppCtx: MethodExtractorContext = {
  filePath: 'Test.cpp',
  language: SupportedLanguages.CPlusPlus,
};

describe('C++ MethodExtractor', () => {
  const extractor = createMethodExtractor(cppMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes class_specifier', () => {
      const tree = parseCPP('class Foo {};');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes struct_specifier', () => {
      const tree = parseCPP('struct Bar {};');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes union_specifier', () => {
      const tree = parseCPP('union Variant {};');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('rejects function_definition', () => {
      const tree = parseCPP('void foo() {}');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(false);
    });
  });

  describe('extract', () => {
    it('extracts pure virtual method as isAbstract and isVirtual', () => {
      const tree = parseCPP(`
        class Shape {
        public:
          virtual double area() const = 0;
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Shape');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('area');
      expect(m.returnType).toBe('double');
      expect(m.isAbstract).toBe(true);
      expect(m.isVirtual).toBe(true);
      expect(m.visibility).toBe('public');
    });

    it('extracts virtual non-pure method as isAbstract false', () => {
      const tree = parseCPP(`
        class Base {
        public:
          virtual void draw() {}
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      const m = result!.methods[0];
      expect(m.name).toBe('draw');
      expect(m.isAbstract).toBe(false);
      expect(m.isVirtual).toBe(true);
    });

    it('extracts final method', () => {
      const tree = parseCPP(`
        class Derived {
        public:
          void process() final;
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods[0].name).toBe('process');
      expect(result!.methods[0].isFinal).toBe(true);
      // final is only legal on virtual functions — isVirtual must be true
      expect(result!.methods[0].isVirtual).toBe(true);
    });

    it('extracts override method', () => {
      const tree = parseCPP(`
        class Child {
        public:
          void draw() override {}
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods[0].name).toBe('draw');
      expect(result!.methods[0].isOverride).toBe(true);
      // override is only legal on virtual functions — isVirtual must be true
      expect(result!.methods[0].isVirtual).toBe(true);
    });

    it('non-virtual method has isVirtual false', () => {
      const tree = parseCPP(`
        class Plain {
        public:
          void bar();
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods[0].isVirtual).toBe(undefined);
    });

    it('extracts static method', () => {
      const tree = parseCPP(`
        class Factory {
        public:
          static Factory* create();
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods[0].name).toBe('create');
      expect(result!.methods[0].isStatic).toBe(true);
      expect(result!.methods[0].returnType).toBe('Factory');
    });

    it('extracts parameters with types including pointer and reference', () => {
      const tree = parseCPP(`
        class Handler {
        public:
          void process(int x, const char* name, double& ref);
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(3);
      expect(params[0].name).toBe('x');
      expect(params[0].type).toBe('int');
      expect(params[1].name).toBe('name');
      expect(params[1].type).toBe('char');
      expect(params[2].name).toBe('ref');
      expect(params[2].type).toBe('double');
    });

    it('extracts optional parameter with default value', () => {
      const tree = parseCPP(`
        class Config {
        public:
          void set(int value, int priority = 0);
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(2);
      expect(params[0].isOptional).toBe(false);
      expect(params[1].name).toBe('priority');
      expect(params[1].isOptional).toBe(true);
    });

    it('extracts access specifier visibility correctly', () => {
      const tree = parseCPP(`
        class Account {
        public:
          void deposit(int amount);
        private:
          void validate();
        protected:
          void notify();
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(3);
      const deposit = result!.methods.find((m) => m.name === 'deposit');
      const validate = result!.methods.find((m) => m.name === 'validate');
      const notify = result!.methods.find((m) => m.name === 'notify');
      expect(deposit!.visibility).toBe('public');
      expect(validate!.visibility).toBe('private');
      expect(notify!.visibility).toBe('protected');
    });

    it('defaults to private for class without access specifier', () => {
      const tree = parseCPP(`
        class Foo {
          void bar();
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods[0].visibility).toBe('private');
    });

    it('defaults to public for struct without access specifier', () => {
      const tree = parseCPP(`
        struct Foo {
          void bar();
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods[0].visibility).toBe('public');
    });

    it('extracts destructor', () => {
      const tree = parseCPP(`
        class Resource {
        public:
          ~Resource();
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods[0].name).toBe('~Resource');
    });

    it('extracts constructor', () => {
      const tree = parseCPP(`
        class Point {
        public:
          Point(int x, int y);
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('Point');
      expect(result!.methods[0].parameters).toHaveLength(2);
    });

    it('returns empty methods for class with only data members', () => {
      const tree = parseCPP(`
        class Data {
          int x;
          int y;
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      // field_declaration without function_declarator → extractName returns undefined → skipped
      expect(result).not.toBeNull();
      expect(result!.methods).toHaveLength(0);
    });

    it('extracts double-pointer parameter name correctly', () => {
      const tree = parseCPP(`
        class Allocator {
        public:
          void alloc(int** ptr, char** argv);
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(2);
      expect(params[0].name).toBe('ptr');
      expect(params[0].type).toBe('int');
      expect(params[1].name).toBe('argv');
    });

    it('extracts template methods from class body with correct visibility', () => {
      const tree = parseCPP(`
        class Buffer {
        public:
          template<typename T>
          void push(T value);
          template<typename T>
          T get(int index) { return T(); }
        private:
          template<typename T>
          void internal(T x);
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(3);
      const push = result!.methods.find((m) => m.name === 'push');
      const get = result!.methods.find((m) => m.name === 'get');
      const internal = result!.methods.find((m) => m.name === 'internal');
      expect(push).toBeDefined();
      expect(push!.parameters).toHaveLength(1);
      expect(push!.parameters[0].name).toBe('value');
      expect(push!.visibility).toBe('public');
      expect(get).toBeDefined();
      expect(get!.parameters).toHaveLength(1);
      expect(get!.parameters[0].name).toBe('index');
      expect(get!.visibility).toBe('public');
      expect(internal).toBeDefined();
      expect(internal!.visibility).toBe('private');
    });

    it('extracts methods from union_specifier', () => {
      const tree = parseCPP(`
        union Variant {
          void clear();
          int asInt() const;
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Variant');
      expect(result!.methods).toHaveLength(2);
      // Union default visibility is public (like struct)
      expect(result!.methods[0].visibility).toBe('public');
      expect(result!.methods[1].visibility).toBe('public');
    });

    it('suppresses = delete special members from extraction', () => {
      const tree = parseCPP(`
        class NonCopyable {
        public:
          void doWork();
          NonCopyable(const NonCopyable&) = delete;
          NonCopyable& operator=(const NonCopyable&) = delete;
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('doWork');
    });

    it('suppresses = default special members from extraction', () => {
      const tree = parseCPP(`
        class Widget {
        public:
          Widget() = default;
          ~Widget() = default;
          void paint();
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('paint');
    });

    it('does not suppress = 0 (pure virtual) as deleted/defaulted', () => {
      const tree = parseCPP(`
        class Shape {
        public:
          virtual double area() = 0;
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('area');
      expect(result!.methods[0].isAbstract).toBe(true);
    });

    it('extracts operator overloads', () => {
      const tree = parseCPP(`
        class Vec {
        public:
          Vec operator+(const Vec& rhs) const;
          bool operator==(const Vec& rhs) const;
          Vec& operator<<(int val);
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(3);
      const names = result!.methods.map((m) => m.name);
      expect(names).toContain('operator+');
      expect(names).toContain('operator==');
      expect(names).toContain('operator<<');

      const plus = result!.methods.find((m) => m.name === 'operator+')!;
      expect(plus.returnType).toBe('Vec');
      expect(plus.parameters).toHaveLength(1);
      expect(plus.parameters[0].name).toBe('rhs');
    });

    it('extracts method with deep pointer return type', () => {
      const tree = parseCPP(`
        class Matrix {
        public:
          int** getBuffer();
          const char* getName();
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].name).toBe('getBuffer');
      expect(result!.methods[0].returnType).toBe('int');
      expect(result!.methods[1].name).toBe('getName');
    });

    it('defaults to private visibility for class, public for struct', () => {
      const classTree = parseCPP(`
        class Foo {
          void secret();
        };
      `);
      const classResult = extractor.extract(classTree.rootNode.child(0)!, cppCtx);
      expect(classResult!.methods[0].name).toBe('secret');
      expect(classResult!.methods[0].visibility).toBe('private');

      const structTree = parseCPP(`
        struct Bar {
          void open();
        };
      `);
      const structResult = extractor.extract(structTree.rootNode.child(0)!, cppCtx);
      expect(structResult!.methods[0].name).toBe('open');
      expect(structResult!.methods[0].visibility).toBe('public');
    });

    it('tracks visibility across multiple access specifier sections', () => {
      const tree = parseCPP(`
        class Mixed {
        public:
          void pub1();
        private:
          void priv1();
          void priv2();
        protected:
          void prot1();
        public:
          void pub2();
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(5);
      const byName = Object.fromEntries(result!.methods.map((m) => [m.name, m.visibility]));
      expect(byName['pub1']).toBe('public');
      expect(byName['priv1']).toBe('private');
      expect(byName['priv2']).toBe('private');
      expect(byName['prot1']).toBe('protected');
      expect(byName['pub2']).toBe('public');
    });

    it('extracts trailing return type instead of auto', () => {
      const tree = parseCPP(`
        class Container {
        public:
          auto begin() -> iterator;
          auto size() -> size_t;
        };
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, cppCtx);

      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].name).toBe('begin');
      expect(result!.methods[0].returnType).toBe('iterator');
      expect(result!.methods[1].name).toBe('size');
      expect(result!.methods[1].returnType).toBe('size_t');
    });
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const parsePython = (code: string) => {
  parser.setLanguage(Python);
  return parser.parse(code);
};

const pythonCtx: MethodExtractorContext = {
  filePath: 'test.py',
  language: SupportedLanguages.Python,
};

describe('Python MethodExtractor', () => {
  const extractor = createMethodExtractor(pythonMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes class_definition', () => {
      const tree = parsePython('class Foo:\n    pass');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('rejects function_definition', () => {
      const tree = parsePython('def foo():\n    pass');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(false);
    });
  });

  describe('basic class with __init__ and public method', () => {
    it('extracts __init__ and a public method', () => {
      const tree = parsePython(`
class UserService:
    def __init__(self, name: str):
        self.name = name

    def find_by_id(self, user_id: int) -> str:
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('UserService');
      expect(result!.methods).toHaveLength(2);

      const init = result!.methods[0];
      expect(init.name).toBe('__init__');
      expect(init.visibility).toBe('public'); // dunder methods are public
      expect(init.parameters).toHaveLength(1);
      expect(init.parameters[0]).toEqual({
        name: 'name',
        type: 'str',
        isOptional: false,
        isVariadic: false,
      });

      const find = result!.methods[1];
      expect(find.name).toBe('find_by_id');
      expect(find.returnType).toBe('str');
      expect(find.visibility).toBe('public');
      expect(find.parameters).toHaveLength(1);
      expect(find.parameters[0]).toEqual({
        name: 'user_id',
        type: 'int',
        isOptional: false,
        isVariadic: false,
      });
    });
  });

  describe('@abstractmethod', () => {
    it('detects abstract method', () => {
      const tree = parsePython(`
class Shape:
    @abstractmethod
    def area(self) -> float:
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].isAbstract).toBe(true);
      expect(result!.methods[0].name).toBe('area');
      expect(result!.methods[0].returnType).toBe('float');
      expect(result!.methods[0].annotations).toContain('@abstractmethod');
    });
  });

  describe('@staticmethod and @classmethod', () => {
    it('detects @staticmethod as static', () => {
      const tree = parsePython(`
class MathUtils:
    @staticmethod
    def add(a: int, b: int) -> int:
        return a + b
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].isStatic).toBe(true);
      expect(result!.methods[0].name).toBe('add');
      expect(result!.methods[0].parameters).toHaveLength(2);
      expect(result!.methods[0].annotations).toContain('@staticmethod');
    });

    it('detects @classmethod as static', () => {
      const tree = parsePython(`
class Factory:
    @classmethod
    def from_dict(cls, data: dict) -> str:
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].isStatic).toBe(true);
      expect(result!.methods[0].name).toBe('from_dict');
      // cls should be skipped
      expect(result!.methods[0].parameters).toHaveLength(1);
      expect(result!.methods[0].parameters[0].name).toBe('data');
      expect(result!.methods[0].annotations).toContain('@classmethod');
    });
  });

  describe('*args and **kwargs', () => {
    it('detects *args as variadic', () => {
      const tree = parsePython(`
class Logger:
    def log(self, *args):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].parameters).toHaveLength(1);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'args',
        type: null,
        isOptional: false,
        isVariadic: true,
      });
    });

    it('detects **kwargs as variadic', () => {
      const tree = parsePython(`
class Config:
    def update(self, **kwargs):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].parameters).toHaveLength(1);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'kwargs',
        type: null,
        isOptional: false,
        isVariadic: true,
      });
    });

    it('handles typed *args and **kwargs', () => {
      const tree = parsePython(`
class Handler:
    def process(self, *args: str, **kwargs: int):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].parameters).toHaveLength(2);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'args',
        type: 'str',
        isOptional: false,
        isVariadic: true,
      });
      expect(result!.methods[0].parameters[1]).toEqual({
        name: 'kwargs',
        type: 'int',
        isOptional: false,
        isVariadic: true,
      });
    });
  });

  describe('type-hinted parameters with defaults', () => {
    it('extracts types and isOptional for defaults', () => {
      const tree = parsePython(`
class Service:
    def configure(self, host: str, port: int = 8080, debug: bool = False):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(3);
      expect(params[0]).toEqual({
        name: 'host',
        type: 'str',
        isOptional: false,
        isVariadic: false,
      });
      expect(params[1]).toEqual({
        name: 'port',
        type: 'int',
        isOptional: true,
        isVariadic: false,
      });
      expect(params[2]).toEqual({
        name: 'debug',
        type: 'bool',
        isOptional: true,
        isVariadic: false,
      });
    });
  });

  describe('return type annotation', () => {
    it('extracts return type', () => {
      const tree = parsePython(`
class Converter:
    def to_string(self) -> str:
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].returnType).toBe('str');
    });

    it('returns null when no return type annotation', () => {
      const tree = parsePython(`
class Converter:
    def process(self):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].returnType).toBeNull();
    });
  });

  describe('async def', () => {
    it('detects async method', () => {
      const tree = parsePython(`
class Client:
    async def fetch(self, url: str) -> str:
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].isAsync).toBe(true);
      expect(result!.methods[0].name).toBe('fetch');
      expect(result!.methods[0].returnType).toBe('str');
    });
  });

  describe('visibility via naming convention', () => {
    it('detects __private_method as private', () => {
      const tree = parsePython(`
class Foo:
    def __private_method(self):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].visibility).toBe('private');
    });

    it('detects _protected_method as protected', () => {
      const tree = parsePython(`
class Foo:
    def _protected_method(self):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].visibility).toBe('protected');
    });

    it('dunder methods (__init__) are public', () => {
      const tree = parsePython(`
class Foo:
    def __init__(self):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].visibility).toBe('public');
    });
  });

  describe('multiple decorators', () => {
    it('collects all decorator annotations', () => {
      const tree = parsePython(`
class Base:
    @property
    @abstractmethod
    def value(self) -> int:
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].annotations).toEqual(['@property', '@abstractmethod']);
      expect(result!.methods[0].isAbstract).toBe(true);
    });
  });

  describe('no params besides self', () => {
    it('returns empty parameters when only self', () => {
      const tree = parsePython(`
class Empty:
    def do_nothing(self):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].parameters).toEqual([]);
    });
  });

  describe('isFinal', () => {
    it('is always false for Python', () => {
      const tree = parsePython(`
class Foo:
    def bar(self):
        pass
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods[0].isFinal).toBe(false);
    });
  });

  describe('dotted decorators', () => {
    it('detects @abc.abstractmethod as abstract', () => {
      const tree = parsePython(`
import abc

class Shape(abc.ABC):
    @abc.abstractmethod
    def area(self):
        pass
      `);
      const classNode = tree.rootNode.namedChildren.find((c) => c.type === 'class_definition')!;
      const result = extractor.extract(classNode, pythonCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('area');
      expect(result!.methods[0].isAbstract).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

const parseRuby = (code: string) => {
  parser.setLanguage(Ruby);
  return parser.parse(code);
};

const rubyCtx: MethodExtractorContext = {
  filePath: 'test.rb',
  language: SupportedLanguages.Ruby,
};

describe('Ruby MethodExtractor', () => {
  const extractor = createMethodExtractor(rubyMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes class', () => {
      const tree = parseRuby('class Foo; end');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes module', () => {
      const tree = parseRuby('module Bar; end');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('rejects method', () => {
      const tree = parseRuby('def foo; end');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(false);
    });

    it('recognizes singleton_class (class << self)', () => {
      const tree = parseRuby(`
class Foo
  class << self
    def bar; end
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      // singleton_class is a child of body_statement
      const bodyStmt = classNode.namedChildren.find((c) => c.type === 'body_statement')!;
      const singletonClass = bodyStmt.namedChildren.find((c) => c.type === 'singleton_class')!;
      expect(extractor.isTypeDeclaration(singletonClass)).toBe(true);
    });
  });

  describe('visibility modifiers', () => {
    it('defaults to public when no modifier', () => {
      const tree = parseRuby(`
class Foo
  def greet
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].name).toBe('greet');
      expect(result!.methods[0].visibility).toBe('public');
    });

    it('detects private methods after private modifier', () => {
      const tree = parseRuby(`
class Foo
  def public_method
  end

  private

  def secret_method
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].name).toBe('public_method');
      expect(result!.methods[0].visibility).toBe('public');
      expect(result!.methods[1].name).toBe('secret_method');
      expect(result!.methods[1].visibility).toBe('private');
    });

    it('detects protected methods after protected modifier', () => {
      const tree = parseRuby(`
class Foo
  protected

  def guarded_method
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].name).toBe('guarded_method');
      expect(result!.methods[0].visibility).toBe('protected');
    });

    it('handles multiple visibility transitions', () => {
      const tree = parseRuby(`
class Foo
  def a; end

  private

  def b; end

  protected

  def c; end

  public

  def d; end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods).toHaveLength(4);
      expect(result!.methods[0].visibility).toBe('public');
      expect(result!.methods[1].visibility).toBe('private');
      expect(result!.methods[2].visibility).toBe('protected');
      expect(result!.methods[3].visibility).toBe('public');
    });
  });

  describe('singleton_method (def self.method)', () => {
    it('marks singleton_method as static', () => {
      const tree = parseRuby(`
class Foo
  def self.class_method
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].name).toBe('class_method');
      expect(result!.methods[0].isStatic).toBe(true);
    });
  });

  describe('singleton_class (class << self)', () => {
    it('extracts methods from class << self as static', () => {
      const tree = parseRuby(`
class Foo
  class << self
    def from_string(s)
    end
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const bodyStmt = classNode.namedChildren.find((c) => c.type === 'body_statement')!;
      const singletonClass = bodyStmt.namedChildren.find((c) => c.type === 'singleton_class')!;
      const result = extractor.extract(singletonClass, rubyCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Foo');
      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('from_string');
      expect(result!.methods[0].isStatic).toBe(true);
      expect(result!.methods[0].parameters).toHaveLength(1);
      expect(result!.methods[0].parameters[0].name).toBe('s');
    });

    it('extracts multiple methods from class << self', () => {
      const tree = parseRuby(`
class Bar
  class << self
    def create
    end

    def build(name)
    end
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const bodyStmt = classNode.namedChildren.find((c) => c.type === 'body_statement')!;
      const singletonClass = bodyStmt.namedChildren.find((c) => c.type === 'singleton_class')!;
      const result = extractor.extract(singletonClass, rubyCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Bar');
      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].name).toBe('create');
      expect(result!.methods[0].isStatic).toBe(true);
      expect(result!.methods[1].name).toBe('build');
      expect(result!.methods[1].isStatic).toBe(true);
    });

    it('respects visibility modifiers inside class << self', () => {
      const tree = parseRuby(`
class Baz
  class << self
    def public_class_method
    end

    private

    def private_class_method
    end
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const bodyStmt = classNode.namedChildren.find((c) => c.type === 'body_statement')!;
      const singletonClass = bodyStmt.namedChildren.find((c) => c.type === 'singleton_class')!;
      const result = extractor.extract(singletonClass, rubyCtx);

      expect(result).not.toBeNull();
      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].name).toBe('public_class_method');
      expect(result!.methods[0].visibility).toBe('public');
      expect(result!.methods[0].isStatic).toBe(true);
      expect(result!.methods[1].name).toBe('private_class_method');
      expect(result!.methods[1].visibility).toBe('private');
      expect(result!.methods[1].isStatic).toBe(true);
    });
  });

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const tree = parseRuby(`
class Foo
  def bar(x, y)
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].parameters).toHaveLength(2);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'x',
        type: null,
        isOptional: false,
        isVariadic: false,
      });
      expect(result!.methods[0].parameters[1]).toEqual({
        name: 'y',
        type: null,
        isOptional: false,
        isVariadic: false,
      });
    });

    it('detects *args as variadic', () => {
      const tree = parseRuby(`
class Foo
  def bar(*args)
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].parameters).toHaveLength(1);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'args',
        type: null,
        isOptional: false,
        isVariadic: true,
      });
    });

    it('detects **kwargs as variadic', () => {
      const tree = parseRuby(`
class Foo
  def bar(**kwargs)
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].parameters).toHaveLength(1);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'kwargs',
        type: null,
        isOptional: false,
        isVariadic: true,
      });
    });

    it('extracts &block parameter', () => {
      const tree = parseRuby(`
class Foo
  def bar(&block)
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].parameters).toHaveLength(1);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'block',
        type: null,
        isOptional: false,
        isVariadic: false,
      });
    });

    it('detects optional parameter with default', () => {
      const tree = parseRuby(`
class Foo
  def bar(x, y = 10)
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].parameters).toHaveLength(2);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'x',
        type: null,
        isOptional: false,
        isVariadic: false,
      });
      expect(result!.methods[0].parameters[1]).toEqual({
        name: 'y',
        type: null,
        isOptional: true,
        isVariadic: false,
      });
    });

    it('extracts keyword parameters', () => {
      const tree = parseRuby(`
class Foo
  def bar(name:, age: 0)
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].parameters).toHaveLength(2);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'name',
        type: null,
        isOptional: false,
        isVariadic: false,
      });
      expect(result!.methods[0].parameters[1]).toEqual({
        name: 'age',
        type: null,
        isOptional: true,
        isVariadic: false,
      });
    });

    it('handles mixed parameter types', () => {
      const tree = parseRuby(`
class Foo
  def bar(x, y = 10, *args, **kwargs, &block)
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(5);
      expect(params[0]).toEqual({ name: 'x', type: null, isOptional: false, isVariadic: false });
      expect(params[1]).toEqual({ name: 'y', type: null, isOptional: true, isVariadic: false });
      expect(params[2]).toEqual({ name: 'args', type: null, isOptional: false, isVariadic: true });
      expect(params[3]).toEqual({
        name: 'kwargs',
        type: null,
        isOptional: false,
        isVariadic: true,
      });
      expect(params[4]).toEqual({
        name: 'block',
        type: null,
        isOptional: false,
        isVariadic: false,
      });
    });
  });

  describe('initialize method', () => {
    it('extracts initialize as a method', () => {
      const tree = parseRuby(`
class User
  def initialize(name)
    @name = name
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.ownerName).toBe('User');
      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('initialize');
      expect(result!.methods[0].visibility).toBe('public');
      expect(result!.methods[0].parameters).toHaveLength(1);
      expect(result!.methods[0].parameters[0].name).toBe('name');
    });
  });

  describe('return type', () => {
    it('is always null for Ruby', () => {
      const tree = parseRuby(`
class Foo
  def bar
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].returnType).toBeNull();
    });
  });

  describe('isAbstract and isFinal', () => {
    it('are always false for Ruby', () => {
      const tree = parseRuby(`
class Foo
  def bar
  end
end
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, rubyCtx);

      expect(result!.methods[0].isAbstract).toBe(false);
      expect(result!.methods[0].isFinal).toBe(false);
    });
  });

  describe('module methods', () => {
    it('extracts methods from a module', () => {
      const tree = parseRuby(`
module MyModule
  def helper
  end
end
      `);
      const modNode = tree.rootNode.child(0)!;
      const result = extractor.extract(modNode, rubyCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('MyModule');
      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('helper');
    });
  });

  describe('module_function', () => {
    it('marks following methods as private and static', () => {
      const tree = parseRuby(`
module Utils
  module_function

  def helper
  end
end
      `);
      const modNode = tree.rootNode.child(0)!;
      const result = extractor.extract(modNode, rubyCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('helper');
      expect(result!.methods[0].visibility).toBe('private');
      expect(result!.methods[0].isStatic).toBe(true);
    });

    it('private after module_function overrides static', () => {
      const tree = parseRuby(`
module Utils
  module_function

  private

  def secret
  end
end
      `);
      const modNode = tree.rootNode.child(0)!;
      const result = extractor.extract(modNode, rubyCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('secret');
      expect(result!.methods[0].visibility).toBe('private');
      expect(result!.methods[0].isStatic).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Dart
// ---------------------------------------------------------------------------

const parseDart = (code: string) => {
  if (!Dart) throw new Error('tree-sitter-dart not available');
  parser.setLanguage(Dart as Parser.Language);
  return parser.parse(code);
};

const dartCtx: MethodExtractorContext = {
  filePath: 'test.dart',
  language: SupportedLanguages.Dart,
};

const describeDart = Dart ? describe : describe.skip;

describeDart('Dart MethodExtractor', () => {
  const extractor = createMethodExtractor(dartMethodConfig);

  describe('extract from class', () => {
    it('extracts public method with return type', () => {
      const tree = parseDart(`
class UserService {
  String findById(int id) {
    return '';
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('UserService');
      expect(result!.methods).toHaveLength(1);

      const method = result!.methods[0];
      expect(method.name).toBe('findById');
      expect(method.returnType).toBe('String');
      expect(method.visibility).toBe('public');
      expect(method.isStatic).toBe(false);
      expect(method.isAbstract).toBe(false);
      expect(method.parameters).toHaveLength(1);
      expect(method.parameters[0].name).toBe('id');
      expect(method.parameters[0].type).toBe('int');
      expect(method.parameters[0].isOptional).toBe(false);
    });

    it('detects private method via underscore prefix', () => {
      const tree = parseDart(`
class Repo {
  void _internal() {
    return;
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('_internal');
      expect(result!.methods[0].visibility).toBe('private');
    });

    it('detects static method', () => {
      const tree = parseDart(`
class Factory {
  static Factory create() {
    return Factory();
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('create');
      expect(result!.methods[0].isStatic).toBe(true);
    });

    it('detects abstract method (no body)', () => {
      const tree = parseDart(`
abstract class Shape {
  double area();
  double perimeter() {
    return 0;
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      expect(result!.methods).toHaveLength(2);

      const areaMethod = result!.methods.find((m) => m.name === 'area');
      const perimeterMethod = result!.methods.find((m) => m.name === 'perimeter');

      expect(areaMethod!.isAbstract).toBe(true);
      expect(perimeterMethod!.isAbstract).toBe(false);
    });

    it('extracts typed parameters', () => {
      const tree = parseDart(`
class Calculator {
  int add(int a, int b) {
    return a + b;
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(2);
      expect(params[0]).toEqual({ name: 'a', type: 'int', isOptional: false, isVariadic: false });
      expect(params[1]).toEqual({ name: 'b', type: 'int', isOptional: false, isVariadic: false });
    });

    it('extracts return type', () => {
      const tree = parseDart(`
class Converter {
  String convert(int value) {
    return value.toString();
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      expect(result!.methods[0].returnType).toBe('String');
    });

    it('extracts void return type', () => {
      const tree = parseDart(`
class Logger {
  void log(String msg) {
    print(msg);
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      expect(result!.methods[0].returnType).toBe('void');
    });

    it('extracts @override annotation', () => {
      const tree = parseDart(`
class MyClass {
  @override
  String toString() {
    return 'MyClass';
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('toString');
      expect(result!.methods[0].annotations).toContain('@override');
    });

    it('detects optional named parameter with {int? x}', () => {
      const tree = parseDart(`
class Builder {
  void build({int? width, required int height}) {
    return;
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      const params = result!.methods[0].parameters;
      expect(params).toHaveLength(2);

      const widthParam = params.find((p) => p.name === 'width');
      const heightParam = params.find((p) => p.name === 'height');

      expect(widthParam!.isOptional).toBe(true);
      expect(heightParam!.isOptional).toBe(false);
    });

    it('detects async method', () => {
      const tree = parseDart(`
class Api {
  Future<String> fetchData() async {
    return '';
  }
}
      `);
      const classNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(classNode, dartCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].isAsync).toBe(true);
    });
  });

  describe('extract from mixin', () => {
    it('extracts method from mixin_declaration', () => {
      const tree = parseDart(`
mixin Loggable {
  void log(String msg) {
    print(msg);
  }
}
      `);
      const mixinNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(mixinNode, dartCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Loggable');
      expect(result!.methods).toHaveLength(1);

      const method = result!.methods[0];
      expect(method.name).toBe('log');
      expect(method.returnType).toBe('void');
      expect(method.visibility).toBe('public');
      expect(method.isAbstract).toBe(false);
      expect(method.parameters).toHaveLength(1);
      expect(method.parameters[0].name).toBe('msg');
      expect(method.parameters[0].type).toBe('String');
    });
  });

  describe('extract from extension', () => {
    it('extracts methods from named extension_declaration', () => {
      const tree = parseDart(`
extension StringExt on String {
  void log() {
    print(this);
  }
}
      `);
      const extNode = tree.rootNode.firstNamedChild!;
      const result = extractor.extract(extNode, dartCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('StringExt');
      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('log');
      expect(result!.methods[0].returnType).toBe('void');
      expect(result!.methods[0].visibility).toBe('public');
    });
  });
});

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

const parsePHP = (code: string) => {
  parser.setLanguage(PHP.php_only as Parser.Language);
  return parser.parse(code);
};

const phpCtx: MethodExtractorContext = {
  filePath: 'Test.php',
  language: SupportedLanguages.PHP,
};

describe('PHP MethodExtractor', () => {
  const extractor = createMethodExtractor(phpMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parsePHP('<?php class Foo { }');
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      expect(extractor.isTypeDeclaration(cls)).toBe(true);
    });

    it('recognizes interface_declaration', () => {
      const tree = parsePHP('<?php interface Bar { }');
      const iface = tree.rootNode.namedChildren.find((c) => c.type === 'interface_declaration')!;
      expect(extractor.isTypeDeclaration(iface)).toBe(true);
    });

    it('recognizes trait_declaration', () => {
      const tree = parsePHP('<?php trait Cacheable { }');
      const trait = tree.rootNode.namedChildren.find((c) => c.type === 'trait_declaration')!;
      expect(extractor.isTypeDeclaration(trait)).toBe(true);
    });

    it('rejects function_definition', () => {
      const tree = parsePHP('<?php function foo() {}');
      const fn = tree.rootNode.namedChildren.find((c) => c.type === 'function_definition')!;
      expect(extractor.isTypeDeclaration(fn)).toBe(false);
    });
  });

  describe('visibility', () => {
    it('extracts public method', () => {
      const tree = parsePHP(`<?php
class Foo {
    public function bar(): void {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result).not.toBeNull();
      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('bar');
      expect(result!.methods[0].visibility).toBe('public');
    });

    it('extracts private method', () => {
      const tree = parsePHP(`<?php
class Foo {
    private function helper(): void {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].visibility).toBe('private');
    });

    it('extracts protected method', () => {
      const tree = parsePHP(`<?php
class Foo {
    protected function doWork(): void {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].visibility).toBe('protected');
    });

    it('defaults to public when no visibility keyword', () => {
      const tree = parsePHP(`<?php
class Foo {
    function noVis(): void {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].visibility).toBe('public');
    });
  });

  describe('abstract', () => {
    it('detects abstract method via abstract_modifier', () => {
      const tree = parsePHP(`<?php
abstract class Foo {
    abstract protected function process(): string;
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].name).toBe('process');
      expect(result!.methods[0].isAbstract).toBe(true);
      expect(result!.methods[0].visibility).toBe('protected');
    });

    it('detects interface methods as implicitly abstract', () => {
      const tree = parsePHP(`<?php
interface Renderable {
    public function render(): string;
}
      `);
      const iface = tree.rootNode.namedChildren.find((c) => c.type === 'interface_declaration')!;
      const result = extractor.extract(iface, phpCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Renderable');
      expect(result!.methods[0].name).toBe('render');
      expect(result!.methods[0].isAbstract).toBe(true);
    });
  });

  describe('final', () => {
    it('detects final method', () => {
      const tree = parsePHP(`<?php
class Foo {
    final public function execute(): void {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].name).toBe('execute');
      expect(result!.methods[0].isFinal).toBe(true);
    });
  });

  describe('static', () => {
    it('detects static method', () => {
      const tree = parsePHP(`<?php
class Foo {
    public static function create(): self {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].name).toBe('create');
      expect(result!.methods[0].isStatic).toBe(true);
    });
  });

  describe('__construct with typed parameters', () => {
    it('extracts __construct with typed parameters', () => {
      const tree = parsePHP(`<?php
class User {
    public function __construct(string $name, int $age) {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('__construct');
      expect(result!.methods[0].parameters).toHaveLength(2);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'name',
        type: 'string',
        isOptional: false,
        isVariadic: false,
      });
      expect(result!.methods[0].parameters[1]).toEqual({
        name: 'age',
        type: 'int',
        isOptional: false,
        isVariadic: false,
      });
    });

    it('extracts __destruct', () => {
      const tree = parsePHP(`<?php
class Resource {
    public function __destruct() {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].name).toBe('__destruct');
    });
  });

  describe('variadic parameters', () => {
    it('detects variadic parameter with ...$args', () => {
      const tree = parsePHP(`<?php
class Foo {
    public function log(string ...$messages): void {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].parameters).toHaveLength(1);
      expect(result!.methods[0].parameters[0]).toEqual({
        name: 'messages',
        type: 'string',
        isOptional: false,
        isVariadic: true,
      });
    });
  });

  describe('return type', () => {
    it('extracts primitive return type', () => {
      const tree = parsePHP(`<?php
class Foo {
    public function findAll(): array {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].returnType).toBe('array');
    });

    it('extracts named return type', () => {
      const tree = parsePHP(`<?php
class Foo {
    public function create(): self {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].returnType).toBe('self');
    });

    it('returns null when no return type', () => {
      const tree = parsePHP(`<?php
class Foo {
    public function noReturn() {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].returnType).toBeNull();
    });
  });

  describe('optional parameters', () => {
    it('detects optional parameter with default value', () => {
      const tree = parsePHP(`<?php
class Foo {
    public function greet(string $name, string $greeting = "Hello"): string {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].parameters).toHaveLength(2);
      expect(result!.methods[0].parameters[0].isOptional).toBe(false);
      expect(result!.methods[0].parameters[1].isOptional).toBe(true);
    });
  });

  describe('annotations (PHP 8 attributes)', () => {
    it('extracts PHP 8 attributes as annotations', () => {
      const tree = parsePHP(`<?php
class Controller {
    #[Route("/api")]
    #[Deprecated]
    public function index(): void {}
}
      `);
      const cls = tree.rootNode.namedChildren.find((c) => c.type === 'class_declaration')!;
      const result = extractor.extract(cls, phpCtx);

      expect(result!.methods[0].annotations).toEqual(['#Route', '#Deprecated']);
    });
  });

  describe('trait methods', () => {
    it('extracts methods from a trait', () => {
      const tree = parsePHP(`<?php
trait Cacheable {
    public function cache(): void {}
    private function clearCache(): void {}
}
      `);
      const trait = tree.rootNode.namedChildren.find((c) => c.type === 'trait_declaration')!;
      const result = extractor.extract(trait, phpCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Cacheable');
      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].name).toBe('cache');
      expect(result!.methods[0].visibility).toBe('public');
      expect(result!.methods[1].name).toBe('clearCache');
      expect(result!.methods[1].visibility).toBe('private');
    });
  });

  describe('enum methods', () => {
    it('extracts methods from PHP 8.1 enum', () => {
      const tree = parsePHP(`<?php
enum Status: string {
    case Active = 'active';
    case Inactive = 'inactive';

    public function label(): string {
        return match($this) {
            Status::Active => 'Active',
            Status::Inactive => 'Inactive',
        };
    }
}
      `);
      const enumNode = tree.rootNode.namedChildren.find((c) => c.type === 'enum_declaration')!;
      const result = extractor.extract(enumNode, phpCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Status');
      expect(result!.methods.length).toBeGreaterThanOrEqual(1);
      expect(result!.methods[0].name).toBe('label');
    });
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const parseRust = (code: string) => {
  parser.setLanguage(Rust);
  return parser.parse(code);
};

const rustCtx: MethodExtractorContext = {
  filePath: 'test.rs',
  language: SupportedLanguages.Rust,
};

describe('Rust MethodExtractor', () => {
  const extractor = createMethodExtractor(rustMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes impl_item', () => {
      const tree = parseRust('impl MyStruct {}');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes trait_item', () => {
      const tree = parseRust('trait MyTrait {}');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('rejects function_item', () => {
      const tree = parseRust('fn free_function() {}');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(false);
    });
  });

  describe('extract from impl', () => {
    it('extracts pub method with &self receiver', () => {
      const code = [
        'impl UserService {',
        '  pub fn find_by_id(&self, id: u64, active: bool) -> User {',
        '    todo!()',
        '  }',
        '}',
      ].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('UserService');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('find_by_id');
      expect(m.visibility).toBe('public');
      expect(m.isStatic).toBe(false);
      expect(m.receiverType).toBe('&self');
      expect(m.returnType).toBe('User');
      expect(m.parameters).toHaveLength(2);
      expect(m.parameters[0]).toEqual({
        name: 'id',
        type: 'u64',
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

    it('extracts private method (no pub) as private', () => {
      const code = ['impl Foo {', '  fn helper(&self) {}', '}'].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result!.methods[0].visibility).toBe('private');
    });

    it('extracts &mut self receiver', () => {
      const code = ['impl Counter {', '  pub fn increment(&mut self) {}', '}'].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      const m = result!.methods[0];
      expect(m.receiverType).toBe('&mut self');
      expect(m.isStatic).toBe(false);
    });

    it('extracts self (owned) receiver', () => {
      const code = ['impl Builder {', '  pub fn build(self) -> Widget { todo!() }', '}'].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      const m = result!.methods[0];
      expect(m.receiverType).toBe('self');
      expect(m.isStatic).toBe(false);
    });

    it('marks associated function (no self) as static', () => {
      const code = ['impl Config {', '  pub fn new(path: String) -> Config { todo!() }', '}'].join(
        '\n',
      );
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      const m = result!.methods[0];
      expect(m.name).toBe('new');
      expect(m.isStatic).toBe(true);
      expect(m.receiverType).toBeNull();
      expect(m.parameters).toHaveLength(1);
      expect(m.parameters[0].name).toBe('path');
      expect(m.parameters[0].type).toBe('String');
    });

    it('extracts return type', () => {
      const code = [
        'impl Parser {',
        '  pub fn parse(&self, input: &str) -> Result { todo!() }',
        '}',
      ].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result!.methods[0].returnType).toBe('Result');
    });

    it('returns null returnType when absent', () => {
      const code = ['impl Logger {', '  pub fn log(&self, msg: &str) {}', '}'].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result!.methods[0].returnType).toBeNull();
    });

    it('extracts #[inline] attribute', () => {
      const code = [
        'impl Math {',
        '  #[inline]',
        '  pub fn add(&self, a: i32, b: i32) -> i32 { a + b }',
        '}',
      ].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result!.methods[0].annotations).toEqual(['#[inline]']);
    });

    it('extracts async fn as isAsync', () => {
      const code = [
        'impl Client {',
        '  pub async fn fetch(&self, url: &str) -> Response { todo!() }',
        '}',
      ].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result!.methods[0].isAsync).toBe(true);
    });

    it('treats pub(crate) as public (simplified)', () => {
      const code = ['impl Internal {', '  pub(crate) fn helper(&self) {}', '}'].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result!.methods[0].visibility).toBe('public');
    });

    it('impl methods are not abstract', () => {
      const code = ['impl Concrete {', '  pub fn do_work(&self) {}', '}'].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result!.methods[0].isAbstract).toBe(false);
    });

    it('isFinal is always false for Rust', () => {
      const code = ['impl Foo {', '  pub fn bar(&self) {}', '}'].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.child(0)!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result!.methods[0].isFinal).toBe(false);
    });
  });

  describe('extract from trait', () => {
    it('extracts required method (no body) as abstract', () => {
      const code = ['trait Drawable {', '  fn draw(&self);', '}'].join('\n');
      const tree = parseRust(code);
      const traitNode = tree.rootNode.child(0)!;
      const result = extractor.extract(traitNode, rustCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Drawable');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('draw');
      expect(m.isAbstract).toBe(true);
      expect(m.isStatic).toBe(false);
      expect(m.receiverType).toBe('&self');
    });

    it('extracts default method (with body) as not abstract', () => {
      const code = [
        'trait Greet {',
        '  fn greet(&self) -> String {',
        '    String::from("hello")',
        '  }',
        '}',
      ].join('\n');
      const tree = parseRust(code);
      const traitNode = tree.rootNode.child(0)!;
      const result = extractor.extract(traitNode, rustCtx);

      const m = result!.methods[0];
      expect(m.name).toBe('greet');
      expect(m.isAbstract).toBe(false);
      expect(m.returnType).toBe('String');
    });

    it('extracts both required and default methods', () => {
      const code = [
        'trait Shape {',
        '  fn area(&self) -> f64;',
        '  fn name(&self) -> &str { "unknown" }',
        '}',
      ].join('\n');
      const tree = parseRust(code);
      const traitNode = tree.rootNode.child(0)!;
      const result = extractor.extract(traitNode, rustCtx);

      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].name).toBe('area');
      expect(result!.methods[0].isAbstract).toBe(true);
      expect(result!.methods[1].name).toBe('name');
      expect(result!.methods[1].isAbstract).toBe(false);
    });

    it('trait associated function (no self) is static', () => {
      const code = ['trait Factory {', '  fn create() -> Self;', '}'].join('\n');
      const tree = parseRust(code);
      const traitNode = tree.rootNode.child(0)!;
      const result = extractor.extract(traitNode, rustCtx);

      const m = result!.methods[0];
      expect(m.name).toBe('create');
      expect(m.isStatic).toBe(true);
      expect(m.isAbstract).toBe(true);
      expect(m.receiverType).toBeNull();
    });
  });

  describe('impl Trait for Struct owner resolution', () => {
    it('attributes methods to the concrete Struct, not the Trait', () => {
      const code = [
        'trait Animal {',
        '  fn speak(&self) -> String;',
        '}',
        'struct Dog;',
        'impl Animal for Dog {',
        '  fn speak(&self) -> String {',
        '    String::from("woof")',
        '  }',
        '}',
      ].join('\n');
      const tree = parseRust(code);
      // Find the impl_item (not the trait_item)
      const implNode = tree.rootNode.namedChildren.find((c) => c.type === 'impl_item')!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Dog');
      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('speak');
    });

    it('attributes plain impl methods to the Struct', () => {
      const code = ['struct Dog;', 'impl Dog {', '  fn bark(&self) {}', '}'].join('\n');
      const tree = parseRust(code);
      const implNode = tree.rootNode.namedChildren.find((c) => c.type === 'impl_item')!;
      const result = extractor.extract(implNode, rustCtx);

      expect(result!.ownerName).toBe('Dog');
    });
  });
});

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

const parseSwift = (code: string) => {
  if (!Swift) throw new Error('tree-sitter-swift not available');
  parser.setLanguage(Swift as Parser.Language);
  return parser.parse(code);
};

const swiftCtx: MethodExtractorContext = {
  filePath: 'Test.swift',
  language: SupportedLanguages.Swift,
};

const describeSwift = Swift ? describe : describe.skip;

describeSwift('Swift MethodExtractor', () => {
  const extractor = createMethodExtractor(swiftMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parseSwift('class Foo {}');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes protocol_declaration', () => {
      const tree = parseSwift('protocol Bar {}');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('rejects import_declaration', () => {
      const tree = parseSwift('import Foundation');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(false);
    });
  });

  describe('visibility', () => {
    it('extracts public method', () => {
      const tree = parseSwift(`
class Foo {
    public func greet() {}
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].name).toBe('greet');
      expect(result!.methods[0].visibility).toBe('public');
    });

    it('extracts private method', () => {
      const tree = parseSwift(`
class Foo {
    private func secret() {}
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].name).toBe('secret');
      expect(result!.methods[0].visibility).toBe('private');
    });

    it('defaults to internal when no modifier', () => {
      const tree = parseSwift(`
class Foo {
    func doStuff() {}
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].name).toBe('doStuff');
      expect(result!.methods[0].visibility).toBe('internal');
    });
  });

  describe('protocol methods', () => {
    it('marks protocol method as abstract', () => {
      const tree = parseSwift(`
protocol Greetable {
    func greet() -> String
}
      `);
      const protocolNode = tree.rootNode.child(0)!;
      const result = extractor.extract(protocolNode, swiftCtx);

      expect(result!.ownerName).toBe('Greetable');
      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('greet');
      expect(result!.methods[0].isAbstract).toBe(true);
    });
  });

  describe('static and class methods', () => {
    it('detects static func as isStatic', () => {
      const tree = parseSwift(`
class Foo {
    static func helper() {}
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].name).toBe('helper');
      expect(result!.methods[0].isStatic).toBe(true);
    });

    it('detects class func as isStatic', () => {
      const tree = parseSwift(`
class Foo {
    class func overridableHelper() {}
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].name).toBe('overridableHelper');
      expect(result!.methods[0].isStatic).toBe(true);
    });
  });

  describe('parameters', () => {
    it('extracts parameters with types and default values', () => {
      const tree = parseSwift(`
class Foo {
    func greet(name: String, age: Int = 25) -> String {
        return ""
    }
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      const m = result!.methods[0];
      expect(m.name).toBe('greet');
      expect(m.parameters).toHaveLength(2);
      expect(m.parameters[0]).toEqual({
        name: 'name',
        type: 'String',
        isOptional: false,
        isVariadic: false,
      });
      expect(m.parameters[1]).toEqual({
        name: 'age',
        type: 'Int',
        isOptional: true,
        isVariadic: false,
      });
    });
  });

  describe('return type', () => {
    it('extracts return type from -> annotation', () => {
      const tree = parseSwift(`
class Foo {
    func compute() -> Int {
        return 42
    }
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].returnType).toBe('Int');
    });
  });

  describe('annotations', () => {
    it('extracts @objc attribute', () => {
      const tree = parseSwift(`
class Foo {
    @objc func bridgedMethod() {}
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].annotations).toContain('@objc');
    });
  });

  describe('isFinal', () => {
    it('detects final func', () => {
      const tree = parseSwift(`
class Foo {
    final func locked() {}
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].name).toBe('locked');
      expect(result!.methods[0].isFinal).toBe(true);
    });

    it('is false when not final', () => {
      const tree = parseSwift(`
class Foo {
    func open() {}
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].isFinal).toBe(false);
    });
  });

  describe('isAsync', () => {
    it('detects async func', () => {
      const tree = parseSwift(`
class Foo {
    func fetchData() async {}
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods[0].isAsync).toBe(true);
    });
  });

  describe('isOverride', () => {
    it('detects override method', () => {
      const tree = parseSwift(`
class Child {
    override func toString() -> String {
        return ""
    }
}
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, swiftCtx);

      expect(result!.methods).toHaveLength(1);
      expect(result!.methods[0].name).toBe('toString');
      expect(result!.methods[0].isOverride).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const parseGo = (code: string) => {
  parser.setLanguage(Go);
  return parser.parse(code);
};

const goCtx: MethodExtractorContext = {
  filePath: 'main.go',
  language: SupportedLanguages.Go,
};

describe('Go MethodExtractor', () => {
  const extractor = createMethodExtractor(goMethodConfig);

  describe('extractFromNode', () => {
    it('extracts method with receiver', () => {
      const tree = parseGo(`
package main

func (r *Repo) Find(id int) error {
    return nil
}
      `);
      const methodNode = tree.rootNode.namedChildren.find((c) => c.type === 'method_declaration')!;
      const info = extractor.extractFromNode!(methodNode, goCtx);

      expect(info).not.toBeNull();
      expect(info!.name).toBe('Find');
      expect(info!.receiverType).toBe('Repo');
      expect(info!.returnType).toBe('error');
      expect(info!.visibility).toBe('public');
      expect(info!.isStatic).toBe(false);
      expect(info!.parameters).toHaveLength(1);
      expect(info!.parameters[0]).toEqual({
        name: 'id',
        type: 'int',
        isOptional: false,
        isVariadic: false,
      });
    });

    it('extracts function (no receiver) as static', () => {
      const tree = parseGo(`
package main

func helper(msg string) {
}
      `);
      const funcNode = tree.rootNode.namedChildren.find((c) => c.type === 'function_declaration')!;
      const info = extractor.extractFromNode!(funcNode, goCtx);

      expect(info).not.toBeNull();
      expect(info!.name).toBe('helper');
      expect(info!.receiverType).toBeNull();
      expect(info!.isStatic).toBe(true);
      expect(info!.visibility).toBe('private');
    });

    it('extracts multi-return type (first type)', () => {
      const tree = parseGo(`
package main

func (s *Service) Get(id int) (User, error) {
    return User{}, nil
}
      `);
      const methodNode = tree.rootNode.namedChildren.find((c) => c.type === 'method_declaration')!;
      const info = extractor.extractFromNode!(methodNode, goCtx);

      expect(info!.returnType).toBe('User');
    });

    it('extracts variadic parameter', () => {
      const tree = parseGo(`
package main

func Format(pattern string, args ...interface{}) string {
    return ""
}
      `);
      const funcNode = tree.rootNode.namedChildren.find((c) => c.type === 'function_declaration')!;
      const info = extractor.extractFromNode!(funcNode, goCtx);

      expect(info!.parameters).toHaveLength(2);
      expect(info!.parameters[0]).toEqual({
        name: 'pattern',
        type: 'string',
        isOptional: false,
        isVariadic: false,
      });
      expect(info!.parameters[1].name).toBe('args');
      expect(info!.parameters[1].isVariadic).toBe(true);
    });

    it('detects exported (uppercase) vs unexported (lowercase)', () => {
      const tree = parseGo(`
package main

func PublicFunc() {}
func privateFunc() {}
      `);
      const funcs = tree.rootNode.namedChildren.filter((c) => c.type === 'function_declaration');
      const pub = extractor.extractFromNode!(funcs[0], goCtx);
      const priv = extractor.extractFromNode!(funcs[1], goCtx);

      expect(pub!.visibility).toBe('public');
      expect(priv!.visibility).toBe('private');
    });

    it('extracts interface method_elem as abstract', () => {
      const tree = parseGo(`
package animal

type Animal interface {
    Speak() string
}
      `);
      const typeDecl = tree.rootNode.namedChildren.find((c) => c.type === 'type_declaration')!;
      const typeSpec = typeDecl.namedChildren.find((c) => c.type === 'type_spec')!;
      const iface = typeSpec.childForFieldName('type')!;
      const methodElem = iface.namedChildren.find((c) => c.type === 'method_elem')!;
      const info = extractor.extractFromNode!(methodElem, goCtx);

      expect(info).not.toBeNull();
      expect(info!.name).toBe('Speak');
      expect(info!.isAbstract).toBe(true);
      expect(info!.returnType).toBe('string');
      expect(info!.visibility).toBe('public');
    });
  });
});
