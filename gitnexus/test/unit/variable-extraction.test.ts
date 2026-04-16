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
import type { VariableExtractorContext } from '../../src/core/ingestion/variable-types.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import Cpp from 'tree-sitter-cpp';
import C from 'tree-sitter-c';
import Ruby from 'tree-sitter-ruby';

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
    const declNode = exportStatement.namedChildren.find(
      (c) => c.type === 'lexical_declaration',
    );
    if (declNode) {
      const info = extractor.extract(declNode, ctx);
      expect(info).not.toBeNull();
      expect(info!.name).toBe('API_KEY');
      expect(info!.visibility).toBe('public');
    }
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
  it('creates extractor with correct language', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    expect(extractor.language).toBe(SupportedLanguages.TypeScript);
  });

  it('returns null for non-variable nodes', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('class Foo {}');
    const node = tree.rootNode.child(0)!;
    expect(extractor.extract(node, { filePath: 'test.ts', language: SupportedLanguages.TypeScript })).toBeNull();
  });

  it('line number is 1-based', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('const x = 1;');
    const node = tree.rootNode.child(0)!;
    const info = extractor.extract(node, { filePath: 'test.ts', language: SupportedLanguages.TypeScript });
    expect(info).not.toBeNull();
    expect(info!.line).toBe(1);
    expect(info!.sourceFile).toBe('test.ts');
  });

  it('sets scope to module for top-level declarations', () => {
    const extractor = createVariableExtractor(typescriptVariableConfig);
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse('const x = 1;');
    const node = tree.rootNode.child(0)!;
    const info = extractor.extract(node, { filePath: 'test.ts', language: SupportedLanguages.TypeScript });
    expect(info).not.toBeNull();
    // rootNode is 'program' → module scope
    expect(info!.scope).toBe('module');
  });
});
