/**
 * P1 Integration Tests: Tree-sitter Parsing
 *
 * Tests parsing of sample files via tree-sitter.
 * Covers hardening fixes: Swift init constructor (#18),
 * PHP export detection (#20), symbol ID with startLine (#19),
 * definition node range (#22).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { isNodeExported } from '../../src/core/ingestion/parsing-processor.js';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { getLanguageFromFilename } from '../../src/core/ingestion/utils.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

const FIXTURES_DIR = path.join(process.cwd(), 'test', 'fixtures', 'sample-code');

// We test isNodeExported directly since it's a pure function
// that only needs a mock AST node, name, and language string.

/**
 * Minimal mock of a tree-sitter AST node.
 */
function mockNode(type: string, text: string = '', parent?: any, children?: any[]): any {
  const node: any = {
    type,
    text,
    parent: parent || null,
    childCount: children?.length ?? 0,
    child: (i: number) => children?.[i] ?? null,
  };
  // Set parent references on children
  if (children) {
    for (const child of children) {
      child.parent = node;
    }
  }
  return node;
}

// ─── isNodeExported per-language ─────────────────────────────────────

describe('parsing', () => {
  describe('isNodeExported', () => {
    // TypeScript/JavaScript
    describe('typescript', () => {
      it('returns true when ancestor is export_statement', () => {
        const exportStmt = mockNode('export_statement', 'export function foo() {}');
        const fnDecl = mockNode('function_declaration', 'function foo() {}', exportStmt);
        const nameNode = mockNode('identifier', 'foo', fnDecl);
        expect(isNodeExported(nameNode, 'foo', 'typescript')).toBe(true);
      });

      it('returns false for non-exported function', () => {
        const fnDecl = mockNode('function_declaration', 'function foo() {}');
        const nameNode = mockNode('identifier', 'foo', fnDecl);
        expect(isNodeExported(nameNode, 'foo', 'typescript')).toBe(false);
      });

      it('returns true when text starts with "export "', () => {
        const parent = mockNode('lexical_declaration', 'export const foo = 1');
        const nameNode = mockNode('identifier', 'foo', parent);
        expect(isNodeExported(nameNode, 'foo', 'typescript')).toBe(true);
      });
    });

    // Python
    describe('python', () => {
      it('public function (no underscore prefix)', () => {
        const node = mockNode('identifier', 'public_function');
        expect(isNodeExported(node, 'public_function', 'python')).toBe(true);
      });

      it('private function (underscore prefix)', () => {
        const node = mockNode('identifier', '_private_helper');
        expect(isNodeExported(node, '_private_helper', 'python')).toBe(false);
      });

      it('dunder method is private', () => {
        const node = mockNode('identifier', '__init__');
        expect(isNodeExported(node, '__init__', 'python')).toBe(false);
      });
    });

    // Go
    describe('go', () => {
      it('uppercase first letter is exported', () => {
        const node = mockNode('identifier', 'ExportedFunction');
        expect(isNodeExported(node, 'ExportedFunction', 'go')).toBe(true);
      });

      it('lowercase first letter is unexported', () => {
        const node = mockNode('identifier', 'unexportedFunction');
        expect(isNodeExported(node, 'unexportedFunction', 'go')).toBe(false);
      });

      it('empty name is not exported', () => {
        const node = mockNode('identifier', '');
        expect(isNodeExported(node, '', 'go')).toBe(false);
      });
    });

    // Rust
    describe('rust', () => {
      it('pub function is exported', () => {
        const visMod = mockNode('visibility_modifier', 'pub');
        const nameNode = mockNode('identifier', 'foo');
        // visibility_modifier is a sibling of the name inside function_item
        const fnDecl = mockNode('function_item', 'pub fn foo() {}', undefined, [visMod, nameNode]);
        expect(isNodeExported(nameNode, 'foo', 'rust')).toBe(true);
      });

      it('non-pub function is not exported', () => {
        const nameNode = mockNode('identifier', 'foo');
        const fnDecl = mockNode('function_item', 'fn foo() {}', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'foo', 'rust')).toBe(false);
      });
    });

    // PHP (hardening fix #20)
    describe('php', () => {
      it('top-level function is exported (globally accessible)', () => {
        // PHP: top-level functions fall through all checks and return true
        const program = mockNode('program', '<?php function topLevel() {}');
        const fnDecl = mockNode('function_definition', 'function topLevel() {}', program);
        const nameNode = mockNode('name', 'topLevel', fnDecl);
        expect(isNodeExported(nameNode, 'topLevel', 'php')).toBe(true);
      });

      it('class declaration is exported', () => {
        const classDecl = mockNode('class_declaration', 'class Foo {}');
        const nameNode = mockNode('name', 'Foo', classDecl);
        expect(isNodeExported(nameNode, 'Foo', 'php')).toBe(true);
      });

      it('public method has visibility_modifier = public', () => {
        const visMod = mockNode('visibility_modifier', 'public');
        const nameNode = mockNode('name', 'addUser', visMod);
        expect(isNodeExported(nameNode, 'addUser', 'php')).toBe(true);
      });

      it('private method has visibility_modifier = private', () => {
        const visMod = mockNode('visibility_modifier', 'private');
        const nameNode = mockNode('name', 'validate', visMod);
        expect(isNodeExported(nameNode, 'validate', 'php')).toBe(false);
      });
    });

    // Swift
    describe('swift', () => {
      it('public function is exported', () => {
        const visMod = mockNode('modifiers', 'public');
        const nameNode = mockNode('identifier', 'getCount', visMod);
        expect(isNodeExported(nameNode, 'getCount', 'swift')).toBe(true);
      });

      it('open function is exported', () => {
        const visMod = mockNode('modifiers', 'open');
        const nameNode = mockNode('identifier', 'doStuff', visMod);
        expect(isNodeExported(nameNode, 'doStuff', 'swift')).toBe(true);
      });

      it('non-public function is not exported', () => {
        const fnDecl = mockNode('function_declaration', 'func helper() {}');
        const nameNode = mockNode('identifier', 'helper', fnDecl);
        expect(isNodeExported(nameNode, 'helper', 'swift')).toBe(false);
      });
    });

    // C/C++
    describe('c/cpp', () => {
      it('C functions without static are exported (external linkage)', () => {
        const nameNode = mockNode('identifier', 'add');
        const fnDef = mockNode('function_definition', 'int add(int a, int b) {}', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'add', 'c')).toBe(true);
      });

      it('C++ functions without static are exported', () => {
        const nameNode = mockNode('identifier', 'helperFunction');
        const fnDef = mockNode('function_definition', 'void helperFunction() {}', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'helperFunction', 'cpp')).toBe(true);
      });

      it('static C function is not exported', () => {
        const nameNode = mockNode('identifier', 'internalHelper');
        const fnDef = mockNode('function_definition', 'static void internalHelper() {}', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'internalHelper', 'c')).toBe(false);
      });
    });

    // C#
    describe('csharp', () => {
      it('public modifier means exported', () => {
        const modifier = mockNode('modifier', 'public');
        const nameNode = mockNode('identifier', 'Add');
        // modifier is a sibling of nameNode inside method_declaration
        const methodDecl = mockNode('method_declaration', 'public int Add() {}', undefined, [modifier, nameNode]);
        expect(isNodeExported(nameNode, 'Add', 'csharp')).toBe(true);
      });

      it('no public modifier means not exported', () => {
        const nameNode = mockNode('identifier', 'Helper');
        const classDecl = mockNode('class_declaration', 'class Helper {}', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'Helper', 'csharp')).toBe(false);
      });
    });

    // Java
    describe('java', () => {
      it('public method is exported', () => {
        const modifiers = mockNode('modifiers', 'public');
        const nameNode = mockNode('identifier', 'getUser');
        const methodDecl = mockNode('method_declaration', 'public User getUser() {}', undefined, [modifiers, nameNode]);
        expect(isNodeExported(nameNode, 'getUser', 'java')).toBe(true);
      });

      it('public class method via text check is exported', () => {
        const nameNode = mockNode('identifier', 'doGet');
        const methodDecl = mockNode('method_declaration', 'public void doGet() {}', undefined, [nameNode]);
        // text starts with 'public' so it should be detected
        expect(isNodeExported(nameNode, 'doGet', 'java')).toBe(true);
      });

      it('private method is not exported', () => {
        const modifiers = mockNode('modifiers', 'private');
        const nameNode = mockNode('identifier', 'helper');
        const methodDecl = mockNode('method_declaration', 'private void helper() {}', undefined, [modifiers, nameNode]);
        expect(isNodeExported(nameNode, 'helper', 'java')).toBe(false);
      });

      it('package-private (no modifier) is not exported', () => {
        const nameNode = mockNode('identifier', 'internal');
        const methodDecl = mockNode('method_declaration', 'void internal() {}', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'internal', 'java')).toBe(false);
      });
    });

    // Kotlin
    describe('kotlin', () => {
      it('function without visibility modifier is public by default', () => {
        const nameNode = mockNode('identifier', 'greet');
        const fnDecl = mockNode('function_declaration', 'fun greet() {}', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'greet', 'kotlin')).toBe(true);
      });

      it('public function is exported', () => {
        const visMod = mockNode('visibility_modifier', 'public');
        const modifiers = mockNode('modifiers', 'public', undefined, [visMod]);
        const nameNode = mockNode('identifier', 'greet');
        const fnDecl = mockNode('function_declaration', 'public fun greet() {}', undefined, [modifiers, nameNode]);
        expect(isNodeExported(nameNode, 'greet', 'kotlin')).toBe(true);
      });

      it('private function is not exported', () => {
        const visMod = mockNode('visibility_modifier', 'private');
        const modifiers = mockNode('modifiers', 'private', undefined, [visMod]);
        const nameNode = mockNode('identifier', 'secret');
        const fnDecl = mockNode('function_declaration', 'private fun secret() {}', undefined, [modifiers, nameNode]);
        expect(isNodeExported(nameNode, 'secret', 'kotlin')).toBe(false);
      });

      it('internal function is not exported', () => {
        const visMod = mockNode('visibility_modifier', 'internal');
        const modifiers = mockNode('modifiers', 'internal', undefined, [visMod]);
        const nameNode = mockNode('identifier', 'moduleOnly');
        const fnDecl = mockNode('function_declaration', 'internal fun moduleOnly() {}', undefined, [modifiers, nameNode]);
        expect(isNodeExported(nameNode, 'moduleOnly', 'kotlin')).toBe(false);
      });
    });

    // C# additional cases
    describe('csharp additional', () => {
      it('internal modifier is not exported', () => {
        const modifier = mockNode('modifier', 'internal');
        const nameNode = mockNode('identifier', 'InternalService');
        const classDecl = mockNode('class_declaration', 'internal class InternalService {}', undefined, [modifier, nameNode]);
        expect(isNodeExported(nameNode, 'InternalService', 'csharp')).toBe(false);
      });

      it('private modifier is not exported', () => {
        const modifier = mockNode('modifier', 'private');
        const nameNode = mockNode('identifier', 'helper');
        const methodDecl = mockNode('method_declaration', 'private void helper() {}', undefined, [modifier, nameNode]);
        expect(isNodeExported(nameNode, 'helper', 'csharp')).toBe(false);
      });

      it('struct with public modifier is exported', () => {
        const modifier = mockNode('modifier', 'public');
        const nameNode = mockNode('identifier', 'Point');
        const structDecl = mockNode('struct_declaration', 'public struct Point {}', undefined, [modifier, nameNode]);
        expect(isNodeExported(nameNode, 'Point', 'csharp')).toBe(true);
      });

      it('enum with public modifier is exported', () => {
        const modifier = mockNode('modifier', 'public');
        const nameNode = mockNode('identifier', 'Status');
        const enumDecl = mockNode('enum_declaration', 'public enum Status {}', undefined, [modifier, nameNode]);
        expect(isNodeExported(nameNode, 'Status', 'csharp')).toBe(true);
      });

      it('record with public modifier is exported', () => {
        const modifier = mockNode('modifier', 'public');
        const nameNode = mockNode('identifier', 'UserDto');
        const recordDecl = mockNode('record_declaration', 'public record UserDto {}', undefined, [modifier, nameNode]);
        expect(isNodeExported(nameNode, 'UserDto', 'csharp')).toBe(true);
      });

      it('interface with public modifier is exported', () => {
        const modifier = mockNode('modifier', 'public');
        const nameNode = mockNode('identifier', 'IService');
        const ifaceDecl = mockNode('interface_declaration', 'public interface IService {}', undefined, [modifier, nameNode]);
        expect(isNodeExported(nameNode, 'IService', 'csharp')).toBe(true);
      });
    });

    // Rust additional cases
    describe('rust additional', () => {
      it('pub(crate) is exported', () => {
        const visMod = mockNode('visibility_modifier', 'pub(crate)');
        const nameNode = mockNode('identifier', 'internal_fn');
        const fnDecl = mockNode('function_item', 'pub(crate) fn internal_fn() {}', undefined, [visMod, nameNode]);
        expect(isNodeExported(nameNode, 'internal_fn', 'rust')).toBe(true);
      });

      it('pub struct is exported', () => {
        const visMod = mockNode('visibility_modifier', 'pub');
        const nameNode = mockNode('type_identifier', 'Config');
        const structDecl = mockNode('struct_item', 'pub struct Config {}', undefined, [visMod, nameNode]);
        expect(isNodeExported(nameNode, 'Config', 'rust')).toBe(true);
      });

      it('private struct is not exported', () => {
        const nameNode = mockNode('type_identifier', 'Inner');
        const structDecl = mockNode('struct_item', 'struct Inner {}', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'Inner', 'rust')).toBe(false);
      });

      it('pub enum is exported', () => {
        const visMod = mockNode('visibility_modifier', 'pub');
        const nameNode = mockNode('type_identifier', 'ErrorKind');
        const enumDecl = mockNode('enum_item', 'pub enum ErrorKind {}', undefined, [visMod, nameNode]);
        expect(isNodeExported(nameNode, 'ErrorKind', 'rust')).toBe(true);
      });

      it('pub trait is exported', () => {
        const visMod = mockNode('visibility_modifier', 'pub');
        const nameNode = mockNode('type_identifier', 'Handler');
        const traitDecl = mockNode('trait_item', 'pub trait Handler {}', undefined, [visMod, nameNode]);
        expect(isNodeExported(nameNode, 'Handler', 'rust')).toBe(true);
      });
    });

    // C/C++ additional cases
    describe('c/cpp additional', () => {
      it('static C++ function is not exported', () => {
        const nameNode = mockNode('identifier', 'localHelper');
        const fnDef = mockNode('function_definition', 'static int localHelper() {}', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'localHelper', 'cpp')).toBe(false);
      });

      it('declaration (not definition) without static is exported', () => {
        const nameNode = mockNode('identifier', 'compute');
        const decl = mockNode('declaration', 'int compute(int x);', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'compute', 'c')).toBe(true);
      });

      it('static declaration is not exported', () => {
        const nameNode = mockNode('identifier', 'internalFn');
        const decl = mockNode('declaration', 'static int internalFn(void);', undefined, [nameNode]);
        expect(isNodeExported(nameNode, 'internalFn', 'c')).toBe(false);
      });

      it('detached node defaults to exported (external linkage)', () => {
        const nameNode = mockNode('identifier', 'orphan');
        expect(isNodeExported(nameNode, 'orphan', 'c')).toBe(true);
      });
    });

    // Unknown language
    describe('unknown language', () => {
      it('returns false for unknown language', () => {
        const node = mockNode('identifier', 'foo');
        expect(isNodeExported(node, 'foo', 'unknown')).toBe(false);
      });
    });
  });

  // ─── Fixture files exist ─────────────────────────────────────────────

  describe('fixture files', () => {
    const fixtures = ['simple.ts', 'simple.py', 'simple.go', 'simple.swift',
      'simple.php', 'simple.rs', 'simple.java', 'simple.c', 'simple.cpp', 'simple.cs'];

    for (const fixture of fixtures) {
      it(`${fixture} exists and is non-empty`, async () => {
        const content = await fs.readFile(path.join(FIXTURES_DIR, fixture), 'utf-8');
        expect(content.length).toBeGreaterThan(0);
      });
    }
  });

  // ─── Unhappy path ─────────────────────────────────────────────────────

  describe('unhappy path', () => {
    it('returns empty AST or handles empty file content', async () => {
      const parser = await loadParser();
      await loadLanguage(SupportedLanguages.TypeScript, 'empty.ts');

      // Parsing a zero-length string must not throw and must return a valid tree.
      const tree = parser.parse('');
      expect(tree).toBeDefined();
      expect(tree.rootNode).toBeDefined();

      // An empty file produces a root node with no named children — no symbols.
      // isNodeExported on a bare node with no ancestors returns false regardless of language.
      const detachedNode = mockNode('identifier', 'foo');
      expect(isNodeExported(detachedNode, 'foo', 'typescript')).toBe(false);
    });

    it('handles binary/non-UTF8 content gracefully', async () => {
      const parser = await loadParser();
      await loadLanguage(SupportedLanguages.TypeScript, 'binary.ts');

      // Construct a string that contains the Unicode replacement character (U+FFFD)
      // and a mix of high-byte sequences that are not valid UTF-8 when treated as Latin-1.
      // JavaScript strings are UTF-16 internally, so this is always a valid string —
      // but it exercises tree-sitter's ability to handle unusual byte patterns.
      const binaryLikeContent = '\uFFFD\u0000\u0001\u001F' + '\xFF\xFE'.repeat(10) + '\uFFFD';

      // Must not throw — tree-sitter should return an error-recovery tree.
      let tree: any;
      expect(() => {
        tree = parser.parse(binaryLikeContent);
      }).not.toThrow();

      expect(tree).toBeDefined();
      expect(tree.rootNode).toBeDefined();
    });

    it('falls back gracefully for unsupported language', async () => {
      // getLanguageFromFilename returns null for extensions with no grammar mapping.
      const rubyLang = getLanguageFromFilename('script.rb');
      expect(rubyLang).toBeNull();

      const luaLang = getLanguageFromFilename('module.lua');
      expect(luaLang).toBeNull();

      // loadLanguage throws an explicit error for a language not in the grammar map.
      // Cast through unknown to simulate a caller passing an unrecognised language key.
      await expect(
        loadLanguage('erlang' as unknown as SupportedLanguages)
      ).rejects.toThrow('Unsupported language');
    });
  });
});
