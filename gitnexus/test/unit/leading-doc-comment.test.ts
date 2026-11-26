/**
 * Unit tests for `extractLeadingDocComment` (issue #2270, U1).
 *
 * Verifies the shared helper that pulls a `/** ... *\/` leading doc comment
 * (Javadoc / KDoc) off the definition node's preceding named sibling. The
 * helper is grammar-agnostic: it matches on the `/**` text prefix, so it works
 * for both tree-sitter-java (`block_comment`) and tree-sitter-kotlin
 * (`multiline_comment`).
 */
import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';
import {
  extractLeadingDocComment,
  type SyntaxNode,
} from '../../src/core/ingestion/utils/ast-helpers.js';

// Vendored grammar — loaded from vendor/ by absolute path, never node_modules (#2111).
const Kotlin = requireVendoredGrammar('tree-sitter-kotlin');

function firstNode(language: Parser.Language, src: string, type: string): SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(language);
  const node = parser.parse(src).rootNode.descendantsOfType(type)[0];
  expect(node, `expected a ${type} node in source`).toBeDefined();
  return node;
}

describe('extractLeadingDocComment', () => {
  it('extracts a Kotlin KDoc (grammar-agnostic prefix match, multiline_comment)', () => {
    const src = `package demo
class Probe {
  /**
   * Computes the running balance, use computeBalanceV2
   */
  fun computeBalance(userId: Long): String? { return null }
}`;
    const fn = firstNode(Kotlin, src, 'function_declaration');
    const doc = extractLeadingDocComment(fn);
    expect(doc).toContain('Computes the running balance');
    expect(doc).toContain('computeBalanceV2');
  });
});
