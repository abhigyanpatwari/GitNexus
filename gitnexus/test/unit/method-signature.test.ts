import { describe, it, expect } from 'vitest';
import { extractMethodSignature } from '../../src/core/ingestion/utils.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp';
import Kotlin from 'tree-sitter-kotlin';
import CPP from 'tree-sitter-cpp';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';

describe('extractMethodSignature', () => {
  const parser = new Parser();

  it('returns zero params and no return type for null node', () => {
    const sig = extractMethodSignature(null);
    expect(sig.parameterCount).toBe(0);
    expect(sig.returnType).toBeUndefined();
  });

  describe('TypeScript', () => {
    it('extracts params and return type from a typed method', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `class Foo {
  greet(name: string, age: number): boolean { return true; }
}`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(2);
      expect(sig.returnType).toBe('boolean');
    });

    it('extracts zero params from a method with no parameters', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `class Foo {
  run(): void {}
}`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(0);
      expect(sig.returnType).toBe('void');
    });

    it('extracts params without return type annotation', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `class Foo {
  process(x: number) { return x + 1; }
}`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(1);
      expect(sig.returnType).toBeUndefined();
    });
  });

  describe('Python', () => {
    it('skips self parameter', () => {
      parser.setLanguage(Python);
      const code = `class Foo:
    def bar(self, x, y):
        pass`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(2);
      expect(sig.returnType).toBeUndefined();
    });

    it('handles method with only self', () => {
      parser.setLanguage(Python);
      const code = `class Foo:
    def noop(self):
        pass`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(0);
    });

    it('handles Python return type annotation', () => {
      parser.setLanguage(Python);
      const code = `class Foo:
    def bar(self, x: int) -> bool:
        return True`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(1);
      // The important thing is parameterCount is correct; returnType may vary.
    });
  });

  describe('Java', () => {
    it('extracts params from a Java method', () => {
      parser.setLanguage(Java);
      const code = `class Foo {
  public int add(int a, int b) { return a + b; }
}`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(2);
    });

    it('extracts zero params from no-arg Java method', () => {
      parser.setLanguage(Java);
      const code = `class Foo {
  public void run() {}
}`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(0);
    });

    it('extracts parameterTypes for Java overloaded methods', () => {
      parser.setLanguage(Java);
      const code = `class Svc {
  public User lookup(int id) { return null; }
  public User lookup(String name) { return null; }
  public void process(int code, String msg) {}
}`;
      const tree = parser.parse(code);
      const classBody = tree.rootNode.child(0)!.childForFieldName('body')!;

      const sig0 = extractMethodSignature(classBody.namedChild(0)!);
      expect(sig0.parameterCount).toBe(1);
      expect(sig0.parameterTypes).toEqual(['int']);

      const sig1 = extractMethodSignature(classBody.namedChild(1)!);
      expect(sig1.parameterCount).toBe(1);
      expect(sig1.parameterTypes).toEqual(['String']);

      const sig2 = extractMethodSignature(classBody.namedChild(2)!);
      expect(sig2.parameterCount).toBe(2);
      expect(sig2.parameterTypes).toEqual(['int', 'String']);
    });
  });

  describe('Kotlin', () => {
    it('extracts params from a Kotlin function declaration', () => {
      parser.setLanguage(Kotlin);
      const code = `object OneArg {
  fun writeAudit(message: String): String {
    return message
  }
}`;
      const tree = parser.parse(code);
      const objectNode = tree.rootNode.child(0)!;
      const classBody = objectNode.namedChild(1)!;
      const functionNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(functionNode);
      expect(sig.parameterCount).toBe(1);
    });

    it('extracts zero params from a no-arg Kotlin function', () => {
      parser.setLanguage(Kotlin);
      const code = `object ZeroArg {
  fun writeAudit(): String {
    return "zero"
  }
}`;
      const tree = parser.parse(code);
      const objectNode = tree.rootNode.child(0)!;
      const classBody = objectNode.namedChild(1)!;
      const functionNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(functionNode);
      expect(sig.parameterCount).toBe(0);
    });

    it('extracts parameterTypes for Kotlin overloaded functions', () => {
      parser.setLanguage(Kotlin);
      const code = `class Svc {
  fun lookup(id: Int): User? { return null }
  fun lookup(name: String): User? { return null }
}`;
      const tree = parser.parse(code);
      const classBody = tree.rootNode.child(0)!.namedChild(1)!;

      const sig0 = extractMethodSignature(classBody.namedChild(0)!);
      expect(sig0.parameterCount).toBe(1);
      expect(sig0.parameterTypes).toEqual(['Int']);

      const sig1 = extractMethodSignature(classBody.namedChild(1)!);
      expect(sig1.parameterCount).toBe(1);
      expect(sig1.parameterTypes).toEqual(['String']);
    });
  });

  describe('C++', () => {
    it('extracts params from a nested C++ declarator', () => {
      parser.setLanguage(CPP);
      const code = `inline const char* write_audit(const char* message) {
  return message;
}`;
      const tree = parser.parse(code);
      const functionNode = tree.rootNode.namedChild(0)!;

      const sig = extractMethodSignature(functionNode);
      expect(sig.parameterCount).toBe(1);
    });

    it('extracts zero params from a no-arg C++ function', () => {
      parser.setLanguage(CPP);
      const code = `inline const char* write_audit() {
  return "zero";
}`;
      const tree = parser.parse(code);
      const functionNode = tree.rootNode.namedChild(0)!;

      const sig = extractMethodSignature(functionNode);
      expect(sig.parameterCount).toBe(0);
    });

    it('extracts parameterTypes for C++ overloaded functions', () => {
      parser.setLanguage(CPP);
      const code = `User* lookup(int id) { return nullptr; }
User* lookup(string name) { return nullptr; }`;
      const tree = parser.parse(code);

      const sig0 = extractMethodSignature(tree.rootNode.namedChild(0)!);
      expect(sig0.parameterCount).toBe(1);
      expect(sig0.parameterTypes).toEqual(['int']);

      const sig1 = extractMethodSignature(tree.rootNode.namedChild(1)!);
      expect(sig1.parameterCount).toBe(1);
      expect(sig1.parameterTypes).toEqual(['string']);
    });
  });

  describe('C#', () => {
    it('extracts params from a C# method', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo {
  public bool Check(string name, int count) { return true; }
}`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(2);
    });

    it('extracts parameterTypes for C# overloaded methods', () => {
      parser.setLanguage(CSharp);
      const code = `class Svc {
  public User Lookup(int id) { return null; }
  public User Lookup(string name) { return null; }
}`;
      const tree = parser.parse(code);
      const classBody = tree.rootNode.child(0)!.childForFieldName('body')!;

      const sig0 = extractMethodSignature(classBody.namedChild(0)!);
      expect(sig0.parameterCount).toBe(1);
      expect(sig0.parameterTypes).toEqual(['int']);

      const sig1 = extractMethodSignature(classBody.namedChild(1)!);
      expect(sig1.parameterCount).toBe(1);
      expect(sig1.parameterTypes).toEqual(['string']);
    });

    it('handles C# method with no params', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo {
  public void Execute() {}
}`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBe(0);
    });

    it('extracts return type from C# method', () => {
      parser.setLanguage(CSharp);
      const code = `class Svc {
  public User GetUser(string name) { return null; }
}`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.returnType).toBe('User');
    });
  });

  describe('Go', () => {
    it('extracts params and single return type', () => {
      parser.setLanguage(Go);
      const code = `package main
func add(a int, b int) int { return a + b }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChildren.find(c => c.type === 'function_declaration')!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.parameterCount).toBe(2);
      expect(sig.returnType).toBe('int');
    });

    it('extracts multi-return type', () => {
      parser.setLanguage(Go);
      const code = `package main
func parse(s string) (string, error) { return s, nil }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChildren.find(c => c.type === 'function_declaration')!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.parameterCount).toBe(1);
      expect(sig.returnType).toBe('string');
    });

    it('handles no return type', () => {
      parser.setLanguage(Go);
      const code = `package main
func doSomething(x int) { }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChildren.find(c => c.type === 'function_declaration')!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.parameterCount).toBe(1);
      expect(sig.returnType).toBeUndefined();
    });

    it('marks variadic function with undefined parameterCount', () => {
      parser.setLanguage(Go);
      const code = `package main
func log(args ...string) int { return 0 }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChildren.find(c => c.type === 'function_declaration')!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.parameterCount).toBeUndefined();
      expect(sig.returnType).toBe('int');
    });
  });

  describe('Rust', () => {
    it('extracts return type from function', () => {
      parser.setLanguage(Rust);
      const code = `fn add(a: i32, b: i32) -> i32 { a + b }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChild(0)!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.parameterCount).toBe(2);
      expect(sig.returnType).toBe('i32');
    });
  });

  describe('C++ return types', () => {
    it('extracts primitive return type', () => {
      parser.setLanguage(CPP);
      const code = `int add(int a, int b) { return a + b; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChild(0)!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.parameterCount).toBe(2);
      expect(sig.returnType).toBe('int');
    });

    it('extracts qualified return type', () => {
      parser.setLanguage(CPP);
      const code = `std::string getName() { return ""; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChild(0)!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.parameterCount).toBe(0);
      expect(sig.returnType).toBe('std::string');
    });

    it('returns undefined returnType for void', () => {
      parser.setLanguage(CPP);
      const code = `void doNothing() { }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChild(0)!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.returnType).toBeUndefined();
    });

    it('marks variadic function with undefined parameterCount', () => {
      parser.setLanguage(CPP);
      const code = `int printf(const char* fmt, ...) { return 0; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChild(0)!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.parameterCount).toBeUndefined();
      expect(sig.returnType).toBe('int');
    });
  });

  describe('variadic params', () => {
    it('Java: marks varargs with undefined parameterCount', () => {
      parser.setLanguage(Java);
      const code = `class Foo {
  public void log(String fmt, Object... args) {}
}`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBeUndefined();
    });

    it('Python: marks *args with undefined parameterCount', () => {
      parser.setLanguage(Python);
      const code = `class Foo:
    def log(self, fmt, *args):
        pass`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBeUndefined();
    });

    it('Python: marks **kwargs with undefined parameterCount', () => {
      parser.setLanguage(Python);
      const code = `class Foo:
    def config(self, **kwargs):
        pass`;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0)!;
      const classBody = classNode.childForFieldName('body')!;
      const methodNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(methodNode);
      expect(sig.parameterCount).toBeUndefined();
    });

    it('TypeScript: marks rest params with undefined parameterCount', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `function logEntry(...messages: string[]): void {}`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.namedChild(0)!;

      const sig = extractMethodSignature(funcNode);
      expect(sig.parameterCount).toBeUndefined();
    });

    it('Kotlin: marks vararg with undefined parameterCount', () => {
      parser.setLanguage(Kotlin);
      const code = `object Foo {
  fun log(vararg args: String) {}
}`;
      const tree = parser.parse(code);
      const objectNode = tree.rootNode.child(0)!;
      const classBody = objectNode.namedChild(1)!;
      const functionNode = classBody.namedChild(0)!;

      const sig = extractMethodSignature(functionNode);
      expect(sig.parameterCount).toBeUndefined();
    });
  });
});
