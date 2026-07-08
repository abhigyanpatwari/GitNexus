import { describe, it, expect } from 'vitest';
import { createVariableExtractor } from '../../src/core/ingestion/variable-extractors/generic.js';
import {
  typescriptVariableConfig,
  javascriptVariableConfig,
} from '../../src/core/ingestion/variable-extractors/configs/typescript-javascript.js';
import { pythonVariableConfig } from '../../src/core/ingestion/variable-extractors/configs/python.js';
import { goVariableConfig } from '../../src/core/ingestion/variable-extractors/configs/go.js';
import { rustVariableConfig } from '../../src/core/ingestion/variable-extractors/configs/rust.js';
import {
  cVariableConfig,
  cppVariableConfig,
} from '../../src/core/ingestion/variable-extractors/configs/c-cpp.js';
import { rubyVariableConfig } from '../../src/core/ingestion/variable-extractors/configs/ruby.js';
import { dartVariableConfig } from '../../src/core/ingestion/variable-extractors/configs/dart.js';
import { kotlinVariableConfig } from '../../src/core/ingestion/variable-extractors/configs/jvm.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import type { VariableExtractorContext } from '../../src/core/ingestion/variable-types.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import Cpp from 'tree-sitter-cpp';
import Ruby from 'tree-sitter-ruby';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';

// Vendored grammars — loaded from vendor/ by absolute path, never node_modules (#2111).
const C = requireVendoredGrammar('tree-sitter-c');
const Dart = requireVendoredGrammar('tree-sitter-dart');

let Kotlin: unknown;
try {
  Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
} catch {
  // Kotlin grammar may not have a prebuild for this platform
}

const parser = new Parser();

// ---------------------------------------------------------------------------
// TypeScript config
// ---------------------------------------------------------------------------

describe('VariableExtractor — TypeScript', () => {
  const extractor = createVariableExtractor(typescriptVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.ts',
    language: SupportedLanguages.TypeScript,
  };

  it('extracts const declaration', () => {
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('const MAX_SIZE = 100;');
    const node = tree.rootNode.child(0)!;
    expect(extractor.isVariableDeclaration(node)).toBe(true);

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('MAX_SIZE');
    expect(info!.isConst).toBe(true);
    expect(info!.isMutable).toBe(false);
    expect(info!.visibility).toBe('private');
  });

  it('extracts let declaration as mutable', () => {
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('let counter = 0;');
    const node = tree.rootNode.child(0)!;
    expect(extractor.isVariableDeclaration(node)).toBe(true);

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('counter');
    expect(info!.isConst).toBe(false);
    expect(info!.isMutable).toBe(true);
  });

  it('extracts typed const declaration', () => {
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('const name: string = "hello";');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('name');
    expect(info!.type).toBe('string');
    expect(info!.isConst).toBe(true);
  });

  it('detects export as public visibility', () => {
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('export const API_KEY = "abc";');
    // export_statement wraps lexical_declaration
    const exportStatement = tree.rootNode.child(0)!;
    // The lexical_declaration is the child of export_statement
    const declNode = exportStatement.namedChildren.find((c) => c.type === 'lexical_declaration');
    expect(declNode).toBeDefined();
    const info = extractor.extract(declNode!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('API_KEY');
    expect(info!.visibility).toBe('public');
  });

  it('rejects non-variable nodes', () => {
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('function foo() {}');
    const node = tree.rootNode.child(0)!;
    expect(extractor.isVariableDeclaration(node)).toBe(false);
    expect(extractor.extract(node, ctx)).toBeNull();
  });

  it('extracts var declaration as mutable variable', () => {
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('var x = 5;');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('x');
    expect(info!.isMutable).toBe(true);
    expect(info!.isConst).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JavaScript config
// ---------------------------------------------------------------------------

describe('VariableExtractor — JavaScript', () => {
  const extractor = createVariableExtractor(javascriptVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.js',
    language: SupportedLanguages.JavaScript,
  };

  it('extracts const declaration', () => {
    parser.setLanguage(TypeScript.typescript); // JS subset of TS grammar
    const tree = parser.parse('const PORT = 3000;');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('PORT');
    expect(info!.isConst).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Python config
// ---------------------------------------------------------------------------

describe('VariableExtractor — Python', () => {
  const extractor = createVariableExtractor(pythonVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.py',
    language: SupportedLanguages.Python,
  };

  it('extracts UPPER_CASE constant', () => {
    parser.setLanguage(Python);
    const tree = parser.parse('MAX_SIZE = 100');
    const node = tree.rootNode.child(0)!;
    expect(extractor.isVariableDeclaration(node)).toBe(true);

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('MAX_SIZE');
    expect(info!.isConst).toBe(true);
    expect(info!.isMutable).toBe(false);
    expect(info!.visibility).toBe('public');
  });

  it('extracts regular assignment as mutable', () => {
    parser.setLanguage(Python);
    const tree = parser.parse('counter = 0');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('counter');
    expect(info!.isConst).toBe(false);
    expect(info!.isMutable).toBe(true);
  });

  it('extracts annotated assignment with type', () => {
    parser.setLanguage(Python);
    const tree = parser.parse('name: str = "hello"');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('name');
    expect(info!.type).toBe('str');
  });

  it('detects underscore prefix as protected', () => {
    parser.setLanguage(Python);
    const tree = parser.parse('_internal = 42');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.visibility).toBe('protected');
  });

  it('detects double underscore prefix as private', () => {
    parser.setLanguage(Python);
    const tree = parser.parse('__secret = 42');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.visibility).toBe('private');
  });

  it('does not treat dunder names as private', () => {
    parser.setLanguage(Python);
    const tree = parser.parse('__name__ = "main"');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.visibility).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// Go config
// ---------------------------------------------------------------------------

describe('VariableExtractor — Go', () => {
  const extractor = createVariableExtractor(goVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.go',
    language: SupportedLanguages.Go,
  };

  it('extracts const declaration', () => {
    parser.setLanguage(Go);
    const tree = parser.parse('package main\nconst MaxSize = 100');
    // Find const_declaration
    let constNode = null;
    for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
      const child = tree.rootNode.namedChild(i);
      if (child?.type === 'const_declaration') {
        constNode = child;
        break;
      }
    }
    expect(constNode).not.toBeNull();
    expect(extractor.isVariableDeclaration(constNode!)).toBe(true);

    const info = extractor.extract(constNode!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('MaxSize');
    expect(info!.isConst).toBe(true);
    expect(info!.isMutable).toBe(false);
    expect(info!.visibility).toBe('public'); // uppercase = exported
  });

  it('extracts var declaration', () => {
    parser.setLanguage(Go);
    const tree = parser.parse('package main\nvar counter int = 0');
    let varNode = null;
    for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
      const child = tree.rootNode.namedChild(i);
      if (child?.type === 'var_declaration') {
        varNode = child;
        break;
      }
    }
    expect(varNode).not.toBeNull();

    const info = extractor.extract(varNode!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('counter');
    expect(info!.isConst).toBe(false);
    expect(info!.isMutable).toBe(true);
    expect(info!.type).toBe('int');
  });

  it('extracts every name from multi-name const declarations', () => {
    parser.setLanguage(Go);
    const tree = parser.parse('package main\nconst X, Y,Z,A,B = 1, 2,3,4,5');
    const constNode = tree.rootNode.namedChildren.find(
      (child) => child.type === 'const_declaration',
    );
    expect(constNode).toBeDefined();

    const infos = extractor.extractAll(constNode!, ctx);
    expect(infos.map((info) => info.name)).toEqual(['X', 'Y', 'Z', 'A', 'B']);
    for (const info of infos) {
      expect(info.isConst).toBe(true);
      expect(info.isMutable).toBe(false);
      expect(info.visibility).toBe('public');
      expect(info.type).toBeNull();
    }
  });

  it('extracts every name from multi-name var declarations with a shared type', () => {
    parser.setLanguage(Go);
    const tree = parser.parse('package main\nvar a, b int');
    const varNode = tree.rootNode.namedChildren.find((child) => child.type === 'var_declaration');
    expect(varNode).toBeDefined();

    const infos = extractor.extractAll(varNode!, ctx);
    expect(infos.map((info) => info.name)).toEqual(['a', 'b']);
    for (const info of infos) {
      expect(info.isConst).toBe(false);
      expect(info.isMutable).toBe(true);
      expect(info.visibility).toBe('package');
      expect(info.type).toBe('int');
    }
  });

  it('preserves per-spec types in grouped multi-name var declarations', () => {
    parser.setLanguage(Go);
    const tree = parser.parse('package main\nvar (\n  a, b int\n  c string\n)');
    const varNode = tree.rootNode.namedChildren.find((child) => child.type === 'var_declaration');
    expect(varNode).toBeDefined();

    const infos = extractor.extractAll(varNode!, ctx);
    expect(infos.map((info) => [info.name, info.type])).toEqual([
      ['a', 'int'],
      ['b', 'int'],
      ['c', 'string'],
    ]);

    const cInfo = infos.find((info) => info.name === 'c');
    expect(cInfo).toBeDefined();
    expect(cInfo!.isConst).toBe(false);
    expect(cInfo!.isMutable).toBe(true);
    expect(cInfo!.visibility).toBe('package');
  });

  it('matches parse-worker nodeName selection for grouped multi-name vars', () => {
    parser.setLanguage(Go);
    const tree = parser.parse('package main\nvar (\n  a, b int\n  c string\n)');
    const varNode = tree.rootNode.namedChildren.find((child) => child.type === 'var_declaration');
    expect(varNode).toBeDefined();

    const selected = extractor.extractAll(varNode!, ctx).find((info) => info.name === 'c');
    expect(selected).toMatchObject({
      name: 'c',
      type: 'string',
      visibility: 'package',
      isConst: false,
      isMutable: true,
    });
  });

  it('detects lowercase as package-private', () => {
    parser.setLanguage(Go);
    const tree = parser.parse('package main\nconst maxSize = 100');
    let constNode = null;
    for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
      const child = tree.rootNode.namedChild(i);
      if (child?.type === 'const_declaration') {
        constNode = child;
        break;
      }
    }
    expect(constNode).not.toBeNull();

    const info = extractor.extract(constNode!, ctx);
    expect(info).not.toBeNull();
    expect(info!.visibility).toBe('package');
  });
});

// ---------------------------------------------------------------------------
// Rust config
// ---------------------------------------------------------------------------

describe('VariableExtractor — Rust', () => {
  const extractor = createVariableExtractor(rustVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.rs',
    language: SupportedLanguages.Rust,
  };

  it('extracts const_item', () => {
    parser.setLanguage(Rust);
    const tree = parser.parse('const MAX_SIZE: usize = 100;');
    const node = tree.rootNode.child(0)!;
    expect(extractor.isVariableDeclaration(node)).toBe(true);

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('MAX_SIZE');
    expect(info!.isConst).toBe(true);
    expect(info!.isStatic).toBe(false);
    expect(info!.isMutable).toBe(false);
    expect(info!.type).toBe('usize');
    expect(info!.visibility).toBe('private');
  });

  it('extracts static_item', () => {
    parser.setLanguage(Rust);
    const tree = parser.parse('static COUNTER: i32 = 0;');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('COUNTER');
    expect(info!.isStatic).toBe(true);
    expect(info!.isConst).toBe(false);
    expect(info!.isMutable).toBe(false);
  });

  it('extracts pub const as public', () => {
    parser.setLanguage(Rust);
    const tree = parser.parse('pub const API_VERSION: &str = "v1";');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.visibility).toBe('public');
    expect(info!.isConst).toBe(true);
  });

  it('extracts static mut as mutable', () => {
    parser.setLanguage(Rust);
    const tree = parser.parse('static mut BUFFER: Vec<u8> = Vec::new();');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.isStatic).toBe(true);
    expect(info!.isMutable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C/C++ config
// ---------------------------------------------------------------------------

describe('VariableExtractor — C', () => {
  const extractor = createVariableExtractor(cVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.c',
    language: SupportedLanguages.C,
  };

  it('extracts const declaration', () => {
    parser.setLanguage(C);
    const tree = parser.parse('const int MAX_SIZE = 100;');
    const node = tree.rootNode.child(0)!;
    expect(extractor.isVariableDeclaration(node)).toBe(true);

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('MAX_SIZE');
    expect(info!.isConst).toBe(true);
    expect(info!.isMutable).toBe(false);
  });

  it('extracts static variable', () => {
    parser.setLanguage(C);
    const tree = parser.parse('static int counter = 0;');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('counter');
    expect(info!.isStatic).toBe(true);
    expect(info!.visibility).toBe('private'); // static = file-private
  });
});

describe('VariableExtractor — C++', () => {
  const extractor = createVariableExtractor(cppVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.cpp',
    language: SupportedLanguages.CPlusPlus,
  };

  it('extracts constexpr declaration', () => {
    parser.setLanguage(Cpp);
    const tree = parser.parse('constexpr int SIZE = 10;');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('SIZE');
    expect(info!.isConst).toBe(true);
  });

  // F9 — structured binding declarations emit one Variable per bound name.
  it('emits a Variable per name for `auto [a, b] = make_pair();`', () => {
    parser.setLanguage(Cpp);
    const tree = parser.parse('auto [a, b] = make_pair();');
    const node = tree.rootNode.child(0)!;
    expect(extractor.isVariableDeclaration(node)).toBe(true);

    const infos = extractor.extractAll(node, ctx);
    expect(infos.map((i) => i.name)).toEqual(['a', 'b']);
    // Top-level declaration → module scope (C++ is in the safe set re: the
    // determineScope class-body block hazard).
    for (const info of infos) expect(info.scope).toBe('module');
  });

  it('emits a Variable per name for the reference form `auto& [x, y, z] = tup;`', () => {
    parser.setLanguage(Cpp);
    const tree = parser.parse('auto& [x, y, z] = tup;');
    const node = tree.rootNode.child(0)!;

    const infos = extractor.extractAll(node, ctx);
    expect(infos.map((i) => i.name)).toEqual(['x', 'y', 'z']);
    for (const info of infos) expect(info.scope).toBe('module');
  });

  it('does not double-emit for an ordinary single-name declaration `int n = 0;`', () => {
    parser.setLanguage(Cpp);
    const tree = parser.parse('int n = 0;');
    const node = tree.rootNode.child(0)!;

    const infos = extractor.extractAll(node, ctx);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.name).toBe('n');
    expect(infos[0]!.scope).toBe('module');
  });
});

// ---------------------------------------------------------------------------
// Ruby config
// ---------------------------------------------------------------------------

describe('VariableExtractor — Ruby', () => {
  const extractor = createVariableExtractor(rubyVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.rb',
    language: SupportedLanguages.Ruby,
  };

  it('extracts Ruby constant assignment', () => {
    parser.setLanguage(Ruby);
    const tree = parser.parse('MAX_SIZE = 100');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('MAX_SIZE');
    expect(info!.isConst).toBe(true);
    expect(info!.isMutable).toBe(false);
    expect(info!.visibility).toBe('public');
  });

  it('extracts regular variable assignment', () => {
    parser.setLanguage(Ruby);
    const tree = parser.parse('counter = 0');
    const node = tree.rootNode.child(0)!;

    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('counter');
    expect(info!.isConst).toBe(false);
    expect(info!.isMutable).toBe(true);
    expect(info!.visibility).toBe('private');
  });
});

// ---------------------------------------------------------------------------
// Factory generic tests
// ---------------------------------------------------------------------------

describe('createVariableExtractor — factory', () => {
  const factoryCtx: VariableExtractorContext = {
    filePath: 'test.ts',
    language: SupportedLanguages.TypeScript,
  };

  it('creates extractor with correct language', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    expect(extractor.language).toBe(SupportedLanguages.TypeScript);
  });

  it('returns null for non-variable nodes', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('class Foo {}');
    const node = tree.rootNode.child(0)!;
    expect(extractor.extract(node, factoryCtx)).toBeNull();
  });

  it('line number is 1-based', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('const x = 1;');
    const node = tree.rootNode.child(0)!;
    const info = extractor.extract(node, factoryCtx);
    expect(info).not.toBeNull();
    expect(info!.line).toBe(1);
    expect(info!.sourceFile).toBe('test.ts');
  });

  it('sets scope to module for top-level declarations', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('const x = 1;');
    const node = tree.rootNode.child(0)!;
    const info = extractor.extract(node, factoryCtx);
    expect(info).not.toBeNull();
    // rootNode is 'program' → module scope
    expect(info!.scope).toBe('module');
  });
});

// ---------------------------------------------------------------------------
// Block-scoped variable extraction tests
// ---------------------------------------------------------------------------

describe('VariableExtractor — block-scoped declarations', () => {
  it('TypeScript: detects block scope for const inside function', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    const ctx: VariableExtractorContext = {
      filePath: 'test.ts',
      language: SupportedLanguages.TypeScript,
    };
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('function foo() { const x = 5; }');
    // program > function_declaration > statement_block > lexical_declaration
    const fnBody = tree.rootNode.child(0)!.childForFieldName('body')!;
    const constDecl = fnBody.namedChildren.find((c) => c.type === 'lexical_declaration');
    expect(constDecl).toBeDefined();
    const info = extractor.extract(constDecl!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('x');
    expect(info!.scope).toBe('block');
    expect(info!.isConst).toBe(true);
    expect(info!.isMutable).toBe(false);
  });

  it('TypeScript: detects block scope for let inside arrow function', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    const ctx: VariableExtractorContext = {
      filePath: 'test.ts',
      language: SupportedLanguages.TypeScript,
    };
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('const fn = () => { let y = 10; };');
    // program > lexical_declaration > variable_declarator > arrow_function > statement_block
    const lexDecl = tree.rootNode.child(0)!;
    const varDeclarator = lexDecl.namedChildren.find((c) => c.type === 'variable_declarator')!;
    const arrowFn = varDeclarator.childForFieldName('value')!;
    const body = arrowFn.childForFieldName('body')!;
    const letDecl = body.namedChildren.find((c) => c.type === 'lexical_declaration');
    expect(letDecl).toBeDefined();
    const info = extractor.extract(letDecl!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('y');
    expect(info!.scope).toBe('block');
    expect(info!.isMutable).toBe(true);
    expect(info!.isConst).toBe(false);
  });

  it('Go: detects block scope for short var declaration inside function', () => {
    const extractor = createVariableExtractor(goVariableConfig);
    const ctx: VariableExtractorContext = {
      filePath: 'test.go',
      language: SupportedLanguages.Go,
    };
    parser.setLanguage(Go);
    const tree = parser.parse('package main\nfunc foo() { x := 5 }');
    // source_file > function_declaration > block > short_var_declaration
    const funcDecl = tree.rootNode.namedChildren.find((c) => c.type === 'function_declaration')!;
    const body = funcDecl.childForFieldName('body')!;
    const shortVarDecl = body.namedChildren.find((c) => c.type === 'short_var_declaration');
    expect(shortVarDecl).toBeDefined();
    const info = extractor.extract(shortVarDecl!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('x');
    expect(info!.scope).toBe('block');
    expect(info!.isMutable).toBe(true);
  });

  it('Rust: detects block scope for let inside function', () => {
    const extractor = createVariableExtractor(rustVariableConfig);
    const ctx: VariableExtractorContext = {
      filePath: 'test.rs',
      language: SupportedLanguages.Rust,
    };
    parser.setLanguage(Rust);
    const tree = parser.parse('fn foo() { let mut x = 5; }');
    // source_file > function_item > block > let_declaration
    const funcItem = tree.rootNode.namedChildren.find((c) => c.type === 'function_item')!;
    const body = funcItem.childForFieldName('body')!;
    const letDecl = body.namedChildren.find((c) => c.type === 'let_declaration');
    expect(letDecl).toBeDefined();
    const info = extractor.extract(letDecl!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('x');
    expect(info!.scope).toBe('block');
    expect(info!.isMutable).toBe(true);
  });

  it('C: detects block scope for declaration inside function', () => {
    const extractor = createVariableExtractor(cVariableConfig);
    const ctx: VariableExtractorContext = {
      filePath: 'test.c',
      language: SupportedLanguages.C,
    };
    parser.setLanguage(C);
    const tree = parser.parse('void foo() { int x = 5; }');
    // translation_unit > function_definition > compound_statement > declaration
    const funcDef = tree.rootNode.namedChildren.find((c) => c.type === 'function_definition')!;
    const body = funcDef.childForFieldName('body')!;
    const decl = body.namedChildren.find((c) => c.type === 'declaration');
    expect(decl).toBeDefined();
    const info = extractor.extract(decl!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('x');
    expect(info!.scope).toBe('block');
    expect(info!.isMutable).toBe(true);
  });

  it('Python: detects block scope for assignment inside function', () => {
    const extractor = createVariableExtractor(pythonVariableConfig);
    const ctx: VariableExtractorContext = {
      filePath: 'test.py',
      language: SupportedLanguages.Python,
    };
    parser.setLanguage(Python);
    const tree = parser.parse('def foo():\n    x = 5');
    // module > function_definition > block > expression_statement > assignment
    const funcDef = tree.rootNode.namedChildren.find((c) => c.type === 'function_definition')!;
    const body = funcDef.childForFieldName('body')!;
    const exprStmt = body.namedChildren.find((c) => c.type === 'expression_statement');
    expect(exprStmt).toBeDefined();
    const info = extractor.extract(exprStmt!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('x');
    expect(info!.scope).toBe('block');
  });

  it('Python: class-body attribute is not block-scoped (class body is a `block` node)', () => {
    // Regression: tree-sitter-python models the class body as a `block` node, the
    // same node type as a function body. A class attribute must NOT be classified
    // as a function-local block, or the pruner would silently drop it.
    const extractor = createVariableExtractor(pythonVariableConfig);
    const ctx: VariableExtractorContext = {
      filePath: 'test.py',
      language: SupportedLanguages.Python,
    };
    parser.setLanguage(Python);
    const tree = parser.parse('class Settings:\n    MAX_SIZE = 100');
    // module > class_definition > block > expression_statement > assignment
    const classDef = tree.rootNode.namedChildren.find((c) => c.type === 'class_definition')!;
    const body = classDef.childForFieldName('body')!;
    const exprStmt = body.namedChildren.find((c) => c.type === 'expression_statement');
    expect(exprStmt).toBeDefined();
    const info = extractor.extract(exprStmt!, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('MAX_SIZE');
    expect(info!.scope).not.toBe('block');
    expect(info!.scope).toBe('module');
  });

  it('Python: rejects non-assignment expression statements (e.g. function calls)', () => {
    const extractor = createVariableExtractor(pythonVariableConfig);
    const ctx: VariableExtractorContext = {
      filePath: 'test.py',
      language: SupportedLanguages.Python,
    };
    parser.setLanguage(Python);
    const tree = parser.parse('print("hello")');
    const exprStmt = tree.rootNode.child(0)!;
    expect(exprStmt.type).toBe('expression_statement');
    // extract() should return null because this is a call, not an assignment
    const info = extractor.extract(exprStmt, ctx);
    expect(info).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dart config — F29: top-level variable declarations
//
// Top-level Dart vars are loose siblings under `program` (no `declaration`
// wrapper). The structure query captures the container node
// (initialized_identifier_list / static_final_declaration_list) as
// @definition.variable, so the extractor is fed that container. The previous
// config read a `type_identifier` that does not exist as a direct child of the
// captured node — a dead read. These tests feed the real captured container.
// ---------------------------------------------------------------------------

describe('VariableExtractor — Dart (F29 top-level)', () => {
  const extractor = createVariableExtractor(dartVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.dart',
    language: SupportedLanguages.Dart,
  };

  /** The top-level variable container the structure query captures. */
  function captureContainer(src: string): SyntaxNode {
    parser.setLanguage(Dart);
    const tree = parser.parse(src);
    let found: SyntaxNode | undefined;
    const walk = (n: SyntaxNode) => {
      if (
        (n.type === 'initialized_identifier_list' || n.type === 'static_final_declaration_list') &&
        n.parent?.type === 'program'
      ) {
        found ??= n;
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) walk(c);
      }
    };
    walk(tree.rootNode);
    if (!found) throw new Error('no top-level variable container found');
    return found;
  }

  it('extracts a typed final top-level variable with the real type (F29)', () => {
    const node = captureContainer('final int count = 3;');
    expect(extractor.isVariableDeclaration(node)).toBe(true);
    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('count');
    expect(info!.type).toBe('int');
    expect(info!.isConst).toBe(true);
    expect(info!.isMutable).toBe(false);
    expect(info!.scope).toBe('module');
  });

  it('extracts an inferred var as untyped (not from a phantom field) (F29)', () => {
    const node = captureContainer("var name = 'x';");
    const info = extractor.extract(node, ctx);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('name');
    // `var` is inferred → no type annotation, so type is null (not a phantom).
    expect(info!.type).toBeNull();
    expect(info!.isMutable).toBe(true);
    expect(info!.isConst).toBe(false);
  });

  it('extracts both names from a multi-name top-level const (F29)', () => {
    const node = captureContainer('const a = 1, b = 2;');
    const infos = extractor.extractAll(node, ctx);
    expect(infos.map((i) => i.name).sort()).toEqual(['a', 'b']);
    for (const i of infos) {
      expect(i.isConst).toBe(true);
      expect(i.isMutable).toBe(false);
    }
  });

  it('does not let a neighbouring declaration’s type/modifier bleed in', () => {
    // Three declarations under one program. The `var name` container sits after
    // `final int count` — its type/modifier must NOT leak onto `name`.
    parser.setLanguage(Dart);
    const tree = parser.parse("final int count = 3;\nvar name = 'x';\nconst a = 1, b = 2;");
    const containers: SyntaxNode[] = [];
    const walk = (n: SyntaxNode) => {
      if (
        (n.type === 'initialized_identifier_list' || n.type === 'static_final_declaration_list') &&
        n.parent?.type === 'program'
      ) {
        containers.push(n);
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) walk(c);
      }
    };
    walk(tree.rootNode);

    const byName = new Map<string, ReturnType<typeof extractor.extractAll>[number]>();
    for (const c of containers)
      for (const info of extractor.extractAll(c, ctx)) byName.set(info.name, info);

    expect(byName.get('name')!.type).toBeNull(); // not 'int' from count
    expect(byName.get('name')!.isConst).toBe(false); // not final from count
    expect(byName.get('count')!.type).toBe('int');
    expect(byName.get('a')!.isConst).toBe(true);
    expect(byName.get('b')!.isConst).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Kotlin destructuring declarations (F51, issue #1919)
// ---------------------------------------------------------------------------

const describeKotlin = Kotlin ? describe : describe.skip;

describeKotlin('VariableExtractor — Kotlin (F51 destructuring)', () => {
  const extractor = createVariableExtractor(kotlinVariableConfig);
  const ctx: VariableExtractorContext = {
    filePath: 'test.kt',
    language: SupportedLanguages.Kotlin,
  };

  /** The first property_declaration whose text starts with `prefix`. */
  function propertyDecl(src: string, prefix: string): SyntaxNode {
    parser.setLanguage(Kotlin as Parser.Language);
    const tree = parser.parse(src);
    let found: SyntaxNode | undefined;
    const walk = (n: SyntaxNode) => {
      if (n.type === 'property_declaration' && n.text.trimStart().startsWith(prefix)) {
        found ??= n;
      }
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) walk(c);
      }
    };
    walk(tree.rootNode);
    if (!found) throw new Error(`no property_declaration starting with ${prefix}`);
    return found;
  }

  it('emits one Variable per destructured name (`val (a, b) = pair`)', () => {
    const node = propertyDecl('fun f() { val (a, b) = pair }', 'val (a');
    const infos = extractor.extractAll(node, ctx);
    expect(infos.map((i) => i.name)).toEqual(['a', 'b']);
  });

  it('skips the `_` discard placeholder (`val (_, second) = pair`)', () => {
    const node = propertyDecl('fun f() { val (_, second) = pair }', 'val (_');
    const infos = extractor.extractAll(node, ctx);
    expect(infos.map((i) => i.name)).toEqual(['second']);
  });

  it('still emits exactly one name for a plain `val x = 1` (no double-count)', () => {
    const node = propertyDecl('fun f() { val x = 1 }', 'val x');
    const infos = extractor.extractAll(node, ctx);
    expect(infos.map((i) => i.name)).toEqual(['x']);
  });
});
