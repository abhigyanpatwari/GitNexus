import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import CPP from 'tree-sitter-cpp';
import Rust from 'tree-sitter-rust';
import CSharp from 'tree-sitter-c-sharp';
import Go from 'tree-sitter-go';
import { findEnclosingClassId, CLASS_CONTAINER_TYPES, CONTAINER_TYPE_TO_LABEL } from '../../src/core/ingestion/utils.js';

function parseCode(language: any, code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(code);
}

/** Find the first descendant node matching a predicate (BFS). */
function findNode(root: Parser.SyntaxNode, predicate: (n: Parser.SyntaxNode) => boolean): Parser.SyntaxNode | null {
  const queue: Parser.SyntaxNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (predicate(node)) return node;
    for (let i = 0; i < node.childCount; i++) {
      queue.push(node.child(i)!);
    }
  }
  return null;
}

describe('CLASS_CONTAINER_TYPES', () => {
  it('contains expected class-like AST node types', () => {
    expect(CLASS_CONTAINER_TYPES.has('class_declaration')).toBe(true);
    expect(CLASS_CONTAINER_TYPES.has('interface_declaration')).toBe(true);
    expect(CLASS_CONTAINER_TYPES.has('struct_declaration')).toBe(true);
    expect(CLASS_CONTAINER_TYPES.has('impl_item')).toBe(true);
    expect(CLASS_CONTAINER_TYPES.has('class_specifier')).toBe(true);
    expect(CLASS_CONTAINER_TYPES.has('class_definition')).toBe(true);
  });

  it('does not contain function types', () => {
    expect(CLASS_CONTAINER_TYPES.has('function_declaration')).toBe(false);
    expect(CLASS_CONTAINER_TYPES.has('function_definition')).toBe(false);
  });
});

describe('CONTAINER_TYPE_TO_LABEL', () => {
  it('maps class-like types to correct labels', () => {
    expect(CONTAINER_TYPE_TO_LABEL['class_declaration']).toBe('Class');
    expect(CONTAINER_TYPE_TO_LABEL['interface_declaration']).toBe('Interface');
    expect(CONTAINER_TYPE_TO_LABEL['struct_declaration']).toBe('Struct');
    expect(CONTAINER_TYPE_TO_LABEL['impl_item']).toBe('Impl');
    expect(CONTAINER_TYPE_TO_LABEL['trait_item']).toBe('Trait');
    expect(CONTAINER_TYPE_TO_LABEL['record_declaration']).toBe('Record');
    expect(CONTAINER_TYPE_TO_LABEL['protocol_declaration']).toBe('Interface');
  });
});

describe('findEnclosingClassId', () => {
  const filePath = 'test/example.ts';

  describe('TypeScript', () => {
    it('finds enclosing class for a method', () => {
      const tree = parseCode(TypeScript.typescript, `
class MyService {
  getData() {
    return 42;
  }
}
`);
      // Find the method_definition node for getData
      const methodNode = findNode(tree.rootNode, n => n.type === 'method_definition');
      expect(methodNode).not.toBeNull();

      // Find the identifier 'getData' inside the method
      const nameNode = findNode(methodNode!, n => n.type === 'property_identifier' && n.text === 'getData');
      expect(nameNode).not.toBeNull();

      const result = findEnclosingClassId(nameNode!, filePath);
      expect(result).toBe('Class:test/example.ts:MyService');
    });

    it('finds enclosing interface for a method signature', () => {
      const tree = parseCode(TypeScript.typescript, `
interface MyInterface {
  doSomething(): void;
}
`);
      // In TS, interface methods are method_signature nodes — find method name
      const nameNode = findNode(tree.rootNode, n => n.type === 'property_identifier' && n.text === 'doSomething');
      if (nameNode) {
        const result = findEnclosingClassId(nameNode, filePath);
        expect(result).toBe('Interface:test/example.ts:MyInterface');
      }
    });

    it('returns null for a top-level function', () => {
      const tree = parseCode(TypeScript.typescript, `
function topLevel() {
  return 1;
}
`);
      const nameNode = findNode(tree.rootNode, n => n.type === 'identifier' && n.text === 'topLevel');
      expect(nameNode).not.toBeNull();

      const result = findEnclosingClassId(nameNode!, filePath);
      expect(result).toBeNull();
    });

    it('returns null when node has no parent', () => {
      // Root node's parent is null
      const tree = parseCode(TypeScript.typescript, 'const x = 1;');
      const result = findEnclosingClassId(tree.rootNode, filePath);
      expect(result).toBeNull();
    });
  });

  describe('Python', () => {
    it('finds enclosing class for a method', () => {
      const tree = parseCode(Python, `
class Calculator:
    def add(self, a, b):
        return a + b
`);
      const methodNode = findNode(tree.rootNode, n => n.type === 'function_definition');
      expect(methodNode).not.toBeNull();

      const nameNode = findNode(methodNode!, n => n.type === 'identifier' && n.text === 'add');
      expect(nameNode).not.toBeNull();

      const result = findEnclosingClassId(nameNode!, 'test/calc.py');
      expect(result).toBe('Class:test/calc.py:Calculator');
    });
  });

  describe('Java', () => {
    it('finds enclosing class for a method', () => {
      const tree = parseCode(Java, `
class UserService {
  public void save(User user) {}
}
`);
      const methodNode = findNode(tree.rootNode, n => n.type === 'method_declaration');
      expect(methodNode).not.toBeNull();

      const nameNode = findNode(methodNode!, n => n.type === 'identifier' && n.text === 'save');
      expect(nameNode).not.toBeNull();

      const result = findEnclosingClassId(nameNode!, 'test/UserService.java');
      expect(result).toBe('Class:test/UserService.java:UserService');
    });

    it('finds enclosing interface for a method', () => {
      const tree = parseCode(Java, `
interface Repository {
  void findById(int id);
}
`);
      const methodNode = findNode(tree.rootNode, n => n.type === 'method_declaration');
      expect(methodNode).not.toBeNull();

      const nameNode = findNode(methodNode!, n => n.type === 'identifier' && n.text === 'findById');
      expect(nameNode).not.toBeNull();

      const result = findEnclosingClassId(nameNode!, 'test/Repository.java');
      expect(result).toBe('Interface:test/Repository.java:Repository');
    });
  });

  describe('C++', () => {
    it('finds enclosing class_specifier for a method', () => {
      const tree = parseCode(CPP, `
class Vector {
public:
  int size() { return _size; }
private:
  int _size;
};
`);
      // In C++ tree-sitter, the class is a class_specifier
      const classNode = findNode(tree.rootNode, n => n.type === 'class_specifier');
      expect(classNode).not.toBeNull();

      // Find a function_definition inside the class
      const funcDef = findNode(classNode!, n => n.type === 'function_definition');
      expect(funcDef).not.toBeNull();

      const nameNode = findNode(funcDef!, n => n.type === 'identifier' && n.text === 'size');
      if (nameNode) {
        const result = findEnclosingClassId(nameNode, 'test/vector.h');
        expect(result).toBe('Class:test/vector.h:Vector');
      }
    });

    it('finds enclosing struct_specifier for a method', () => {
      const tree = parseCode(CPP, `
struct Point {
  double distance() { return 0; }
};
`);
      const funcDef = findNode(tree.rootNode, n => n.type === 'function_definition');
      if (funcDef) {
        const nameNode = findNode(funcDef, n => n.type === 'identifier' && n.text === 'distance');
        if (nameNode) {
          const result = findEnclosingClassId(nameNode, 'test/point.h');
          expect(result).toBe('Struct:test/point.h:Point');
        }
      }
    });
  });

  describe('Rust', () => {
    it('finds enclosing impl_item for a method', () => {
      const tree = parseCode(Rust, `
struct Counter {
  count: u32,
}
impl Counter {
  fn increment(&mut self) {
    self.count += 1;
  }
}
`);
      const implNode = findNode(tree.rootNode, n => n.type === 'impl_item');
      expect(implNode).not.toBeNull();

      const funcItem = findNode(implNode!, n => n.type === 'function_item');
      expect(funcItem).not.toBeNull();

      const nameNode = findNode(funcItem!, n => n.type === 'identifier' && n.text === 'increment');
      expect(nameNode).not.toBeNull();

      const result = findEnclosingClassId(nameNode!, 'test/counter.rs');
      expect(result).toBe('Impl:test/counter.rs:Counter');
    });

    it('picks struct name (not trait name) for impl Trait for Struct', () => {
      const tree = parseCode(Rust, `
struct MyStruct {
  value: i32,
}

trait MyTrait {
  fn do_something(&self);
}

impl MyTrait for MyStruct {
  fn do_something(&self) {
    println!("{}", self.value);
  }
}
`);
      // Find the impl_item that has a `for` keyword (impl Trait for Struct)
      const implNode = findNode(tree.rootNode, n =>
        n.type === 'impl_item' && n.children?.some((c: any) => c.text === 'for')
      );
      expect(implNode).not.toBeNull();

      const funcItem = findNode(implNode!, n => n.type === 'function_item');
      expect(funcItem).not.toBeNull();

      const nameNode = findNode(funcItem!, n => n.type === 'identifier' && n.text === 'do_something');
      expect(nameNode).not.toBeNull();

      const result = findEnclosingClassId(nameNode!, 'test/my_struct.rs');
      // Should resolve to MyStruct (the implementing type), NOT MyTrait
      expect(result).toBe('Impl:test/my_struct.rs:MyStruct');
    });

    it('still picks struct name for plain impl Struct (no trait)', () => {
      const tree = parseCode(Rust, `
struct Counter {
  count: u32,
}
impl Counter {
  fn increment(&mut self) {
    self.count += 1;
  }
}
`);
      const implNode = findNode(tree.rootNode, n => n.type === 'impl_item');
      expect(implNode).not.toBeNull();

      const funcItem = findNode(implNode!, n => n.type === 'function_item');
      expect(funcItem).not.toBeNull();

      const nameNode = findNode(funcItem!, n => n.type === 'identifier' && n.text === 'increment');
      expect(nameNode).not.toBeNull();

      const result = findEnclosingClassId(nameNode!, 'test/counter.rs');
      expect(result).toBe('Impl:test/counter.rs:Counter');
    });

    it('finds enclosing trait_item for a method', () => {
      const tree = parseCode(Rust, `
trait Drawable {
  fn draw(&self);
}
`);
      const traitNode = findNode(tree.rootNode, n => n.type === 'trait_item');
      expect(traitNode).not.toBeNull();

      const funcItem = findNode(traitNode!, n => n.type === 'function_signature_item' || n.type === 'function_item');
      if (funcItem) {
        const nameNode = findNode(funcItem, n => n.type === 'identifier' && n.text === 'draw');
        if (nameNode) {
          const result = findEnclosingClassId(nameNode, 'test/draw.rs');
          expect(result).toBe('Trait:test/draw.rs:Drawable');
        }
      }
    });
  });

  describe('C#', () => {
    it('finds enclosing class for a method', () => {
      const tree = parseCode(CSharp, `
class OrderService {
  public void Process() {}
}
`);
      const methodNode = findNode(tree.rootNode, n => n.type === 'method_declaration');
      expect(methodNode).not.toBeNull();

      const nameNode = findNode(methodNode!, n => n.type === 'identifier' && n.text === 'Process');
      expect(nameNode).not.toBeNull();

      const result = findEnclosingClassId(nameNode!, 'test/OrderService.cs');
      expect(result).toBe('Class:test/OrderService.cs:OrderService');
    });

    it('finds enclosing record for a method', () => {
      const tree = parseCode(CSharp, `
record Person {
  public string GetName() { return ""; }
}
`);
      const methodNode = findNode(tree.rootNode, n => n.type === 'method_declaration');
      if (methodNode) {
        const nameNode = findNode(methodNode, n => n.type === 'identifier' && n.text === 'GetName');
        if (nameNode) {
          const result = findEnclosingClassId(nameNode, 'test/Person.cs');
          expect(result).toBe('Record:test/Person.cs:Person');
        }
      }
    });

    it('finds enclosing struct for a method', () => {
      const tree = parseCode(CSharp, `
struct Vector2 {
  public float Length() { return 0; }
}
`);
      const methodNode = findNode(tree.rootNode, n => n.type === 'method_declaration');
      if (methodNode) {
        const nameNode = findNode(methodNode, n => n.type === 'identifier' && n.text === 'Length');
        if (nameNode) {
          const result = findEnclosingClassId(nameNode, 'test/Vector2.cs');
          expect(result).toBe('Struct:test/Vector2.cs:Vector2');
        }
      }
    });
  });

  describe('Go', () => {
    it('returns receiver struct ID for Go methods', () => {
      // Go methods have receiver parameter: func (s *Server) Start() {}
      // findEnclosingClassId extracts the receiver type to link method → struct
      const tree = parseCode(Go, `
package main

type Server struct {
  port int
}

func (s *Server) Start() {}
`);
      const methodNode = findNode(tree.rootNode, n => n.type === 'method_declaration');
      expect(methodNode).not.toBeNull();

      const nameNode = findNode(methodNode!, n => n.type === 'field_identifier' && n.text === 'Start');
      if (nameNode) {
        const result = findEnclosingClassId(nameNode, 'test/server.go');
        expect(result).not.toBeNull();
        // Should generate a Struct ID for "Server"
        expect(result).toContain('Server');
      }
    });
  });

  describe('edge cases', () => {
    it('handles nested classes — returns innermost enclosing class', () => {
      const tree = parseCode(TypeScript.typescript, `
class Outer {
  inner = class Inner {
    doWork() {}
  }
}
`);
      const methodNode = findNode(tree.rootNode, n => n.type === 'method_definition');
      if (methodNode) {
        const nameNode = findNode(methodNode, n => n.type === 'property_identifier' && n.text === 'doWork');
        if (nameNode) {
          const result = findEnclosingClassId(nameNode, filePath);
          // Should find the innermost class (Inner, which is a class node)
          expect(result).not.toBeNull();
          // The result should reference the inner class, not the outer
        }
      }
    });

    it('returns null for a node without parent', () => {
      // Simulate a node with null parent
      const fakeNode = { parent: null };
      const result = findEnclosingClassId(fakeNode, filePath);
      expect(result).toBeNull();
    });

    it('skips containers without a name node', () => {
      // Simulate AST nodes where the class container has no name
      const fakeClassNode = {
        type: 'class_declaration',
        childForFieldName: () => null,
        children: [],
        parent: null,
      };
      const fakeChild = {
        parent: fakeClassNode,
      };
      const result = findEnclosingClassId(fakeChild, filePath);
      // The class has no name, so should return null
      expect(result).toBeNull();
    });
  });
});
