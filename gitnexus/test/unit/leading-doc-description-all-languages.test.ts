/**
 * Cross-language coverage for the leading-doc `descriptionExtractor`
 * (issue #2270). Confirms every documentable language registers the hook, and
 * exercises each doc-comment family through the real provider hooks:
 *   - block doc comments (double-star / bang): TypeScript, C++ (Java/Kotlin elsewhere)
 *   - triple-slash line runs: Rust, C#
 *   - godoc double-slash runs: Go
 *   - hash runs: Ruby
 *   - PHPDoc docblock fallback: PHP
 *
 * Dart and Swift share the default block / triple-slash config already exercised
 * their native grammars can fail to load in some environments, so they are
 * covered by the registration check (no parse) rather than a behavior parse.
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import CSharp from 'tree-sitter-c-sharp';
import Ruby from 'tree-sitter-ruby';
import CPP from 'tree-sitter-cpp';
import PHP from 'tree-sitter-php';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { DOC_BEARING_LABELS } from '../../src/core/ingestion/utils/ast-helpers.js';
import { EMBEDDABLE_LABELS } from '../../src/core/embeddings/types.js';
import type { CaptureMap } from '../../src/core/ingestion/language-provider.js';
import type { NodeLabel } from 'gitnexus-shared';

function describeFromProvider(
  language: SupportedLanguages,
  grammar: unknown,
  src: string,
  nodeType: string,
  captureKey: string,
  label: NodeLabel,
  name: string,
): string | undefined {
  const parser = new Parser();
  parser.setLanguage(grammar);
  const node = parser.parse(src).rootNode.descendantsOfType(nodeType)[0];
  expect(node, `expected a ${nodeType} node for ${language}`).toBeDefined();
  const captureMap: CaptureMap = { [captureKey]: node };
  return getProvider(language).descriptionExtractor?.(label, name, captureMap);
}

// Languages that should surface a description (everything except Vue/Cobol).
const DOCUMENTABLE_LANGUAGES: readonly SupportedLanguages[] = [
  SupportedLanguages.JavaScript,
  SupportedLanguages.TypeScript,
  SupportedLanguages.Python,
  SupportedLanguages.Java,
  SupportedLanguages.C,
  SupportedLanguages.CPlusPlus,
  SupportedLanguages.CSharp,
  SupportedLanguages.Go,
  SupportedLanguages.Ruby,
  SupportedLanguages.Rust,
  SupportedLanguages.PHP,
  SupportedLanguages.Kotlin,
  SupportedLanguages.Swift,
  SupportedLanguages.Dart,
];

describe('DOC_BEARING_LABELS is bounded to embeddable labels (issue #2270 review fix)', () => {
  it('every doc-bearing label is in EMBEDDABLE_LABELS so its description is searchable', () => {
    const embeddable = new Set<string>(EMBEDDABLE_LABELS);
    const notEmbeddable = [...DOC_BEARING_LABELS].filter((label) => !embeddable.has(label));
    expect(notEmbeddable).toEqual([]);
  });
});

describe('leading-doc descriptionExtractor — registration coverage', () => {
  it.each(DOCUMENTABLE_LANGUAGES)('%s provider registers descriptionExtractor', (language) => {
    expect(getProvider(language).descriptionExtractor).toBeDefined();
  });
});

describe('leading-doc descriptionExtractor — behavior per comment family', () => {
  it('TypeScript JSDoc block', () => {
    const d = describeFromProvider(
      SupportedLanguages.TypeScript,
      TypeScript.typescript,
      `/** Adds two numbers, marker TSMARK. */\nfunction add(a: number, b: number) { return a + b; }`,
      'function_declaration',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toContain('TSMARK');
  });

  it('Go godoc (// run)', () => {
    const d = describeFromProvider(
      SupportedLanguages.Go,
      Go,
      `package p\n// Add returns the sum, marker GOMARK.\nfunc Add(a int) int { return a }`,
      'function_declaration',
      'definition.function',
      'Function',
      'Add',
    );
    expect(d).toContain('GOMARK');
  });

  it('Rust /// doc comment', () => {
    const d = describeFromProvider(
      SupportedLanguages.Rust,
      Rust,
      `/// Adds things, marker RSMARK.\nfn add(a: i32) -> i32 { a }`,
      'function_item',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toContain('RSMARK');
  });

  it('C# /// XML doc comment', () => {
    const d = describeFromProvider(
      SupportedLanguages.CSharp,
      CSharp,
      `class C {\n/// <summary>Adds, marker CSMARK</summary>\nvoid M() {}\n}`,
      'method_declaration',
      'definition.method',
      'Method',
      'M',
    );
    expect(d).toContain('CSMARK');
  });

  it('Ruby # comment run', () => {
    const d = describeFromProvider(
      SupportedLanguages.Ruby,
      Ruby,
      `# Adds things, marker RBMARK.\ndef add(a)\n a\nend`,
      'method',
      'definition.method',
      'Method',
      'add',
    );
    expect(d).toContain('RBMARK');
  });

  it('C++ Doxygen block', () => {
    const d = describeFromProvider(
      SupportedLanguages.CPlusPlus,
      CPP,
      `/** Adds, marker CPPMARK. */\nint add(int a) { return a; }`,
      'function_definition',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toContain('CPPMARK');
  });

  it('PHP docblock fallback (non-Eloquent prose)', () => {
    const d = describeFromProvider(
      SupportedLanguages.PHP,
      PHP.php,
      `<?php\nclass C {\n/** Adds, marker PHPMARK. */\npublic function add($a) { return $a; }\n}`,
      'method_declaration',
      'definition.method',
      'Method',
      'add',
    );
    expect(d).toContain('PHPMARK');
  });

  it('returns undefined for a function with no leading doc comment (Go)', () => {
    const d = describeFromProvider(
      SupportedLanguages.Go,
      Go,
      `package p\nfunc Bare() {}`,
      'function_declaration',
      'definition.function',
      'Function',
      'Bare',
    );
    expect(d).toBeUndefined();
  });

  it('collects a multi-line /// run (Rust)', () => {
    const d = describeFromProvider(
      SupportedLanguages.Rust,
      Rust,
      `/// First line.\n/// Second line, marker MULTILINE.\nfn add(a: i32) -> i32 { a }`,
      'function_item',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toContain('First line');
    expect(d).toContain('MULTILINE');
  });

  it('does NOT attach a Rust //! inner doc to the following item (inner-doc semantics)', () => {
    const d = describeFromProvider(
      SupportedLanguages.Rust,
      Rust,
      `//! Inner doc, marker INNERMARK.\nfn add(a: i32) -> i32 { a }`,
      'function_item',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toBeUndefined();
  });

  it('does NOT attach a Rust /*! inner block doc to the following item', () => {
    const d = describeFromProvider(
      SupportedLanguages.Rust,
      Rust,
      `/*! Inner block doc, marker INNERBLOCK. */\nfn add(a: i32) -> i32 { a }`,
      'function_item',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toBeUndefined();
  });

  it('collects a /*! Doxygen bang block (C++)', () => {
    const d = describeFromProvider(
      SupportedLanguages.CPlusPlus,
      CPP,
      `/*! Bang block, marker BANGMARK. */\nint add(int a) { return a; }`,
      'function_definition',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toContain('BANGMARK');
  });
});

describe('leading-doc descriptionExtractor — exported TS/JS decls (issue #2270 review fix)', () => {
  it('attaches JSDoc to an exported function (JSDoc precedes export_statement)', () => {
    const d = describeFromProvider(
      SupportedLanguages.TypeScript,
      TypeScript.typescript,
      `/** Exported adder, marker EXPFN. */\nexport function add(a: number) { return a; }`,
      'function_declaration',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toContain('EXPFN');
  });

  it('attaches JSDoc to an exported class', () => {
    const d = describeFromProvider(
      SupportedLanguages.TypeScript,
      TypeScript.typescript,
      `/** Exported widget, marker EXPCLASS. */\nexport class Widget { run() {} }`,
      'class_declaration',
      'definition.class',
      'Class',
      'Widget',
    );
    expect(d).toContain('EXPCLASS');
  });

  it('attaches JSDoc to an export default function', () => {
    const d = describeFromProvider(
      SupportedLanguages.TypeScript,
      TypeScript.typescript,
      `/** Default export, marker EXPDEFAULT. */\nexport default function add(a: number) { return a; }`,
      'function_declaration',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toContain('EXPDEFAULT');
  });

  it('still attaches JSDoc to a bare (non-exported) function', () => {
    const d = describeFromProvider(
      SupportedLanguages.TypeScript,
      TypeScript.typescript,
      `/** Bare adder, marker BAREFN. */\nfunction add(a: number) { return a; }`,
      'function_declaration',
      'definition.function',
      'Function',
      'add',
    );
    expect(d).toContain('BAREFN');
  });
});

describe('leading-doc descriptionExtractor — line-comment adjacency (issue #2270 review fix)', () => {
  it('does NOT attach a // comment separated from the function by a blank line (Go)', () => {
    const d = describeFromProvider(
      SupportedLanguages.Go,
      Go,
      `package p\n// Detached note, marker DETACHED.\n\nfunc Add(a int) int { return a }`,
      'function_declaration',
      'definition.function',
      'Function',
      'Add',
    );
    expect(d).toBeUndefined();
  });

  it('collects only the adjacent // block when an earlier block is blank-separated (Go)', () => {
    const d = describeFromProvider(
      SupportedLanguages.Go,
      Go,
      `package p\n// Unrelated earlier block, marker EARLIER.\n\n// Adjacent doc, marker ADJACENT.\nfunc Add(a int) int { return a }`,
      'function_declaration',
      'definition.function',
      'Function',
      'Add',
    );
    expect(d).toContain('ADJACENT');
    expect(d).not.toContain('EARLIER');
  });

  it('does NOT absorb a Ruby magic comment separated from the first method by a blank line', () => {
    const d = describeFromProvider(
      SupportedLanguages.Ruby,
      Ruby,
      `# frozen_string_literal: true\n\ndef add(a)\n a\nend`,
      'method',
      'definition.method',
      'Method',
      'add',
    );
    expect(d).toBeUndefined();
  });
});

describe('leading-doc descriptionExtractor — directive & magic comments (issue #2270 review fix)', () => {
  it('does NOT absorb a Go //go: build directive directly above a function', () => {
    const d = describeFromProvider(
      SupportedLanguages.Go,
      Go,
      `package p\n//go:build linux\nfunc Add(a int) int { return a }`,
      'function_declaration',
      'definition.function',
      'Function',
      'Add',
    );
    expect(d).toBeUndefined();
  });

  it('keeps a real godoc line and skips an interleaved //go:generate directive', () => {
    const d = describeFromProvider(
      SupportedLanguages.Go,
      Go,
      `package p\n// Add returns the sum, marker GODOC.\n//go:generate stringer -type=T\nfunc Add(a int) int { return a }`,
      'function_declaration',
      'definition.function',
      'Function',
      'Add',
    );
    expect(d).toContain('GODOC');
    expect(d).not.toContain('go:generate');
  });

  it('does NOT absorb a Ruby magic comment directly above the first method (no blank line)', () => {
    const d = describeFromProvider(
      SupportedLanguages.Ruby,
      Ruby,
      `# frozen_string_literal: true\ndef add(a)\n a\nend`,
      'method',
      'definition.method',
      'Method',
      'add',
    );
    expect(d).toBeUndefined();
  });
});

describe('phpDescriptionExtractor — Eloquent metadata wins over PHPDoc fallback', () => {
  it('returns the Eloquent relation, not the docblock prose, when both are present', () => {
    const d = describeFromProvider(
      SupportedLanguages.PHP,
      PHP.php,
      `<?php\nclass User {\n/** Prose docblock, marker DOCPROSE. */\npublic function orders() { return $this->hasMany(Order::class); }\n}`,
      'method_declaration',
      'definition.method',
      'Method',
      'orders',
    );
    expect(d).toBe('hasMany(Order)');
    expect(d).not.toContain('DOCPROSE');
  });
});
