/**
 * Unit tests for `extractLeadingDocComment` (issue #2270, U1).
 *
 * Verifies the shared helper that pulls a `/** ... *\/` leading doc comment
 * (Javadoc / KDoc) off the definition node's preceding named sibling. The
 * helper is grammar-agnostic: it matches on the `/**` text prefix, so it works
 * for both tree-sitter-java (`block_comment`) and tree-sitter-kotlin
 * (`multiline_comment`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  extractLeadingDocComment,
  type SyntaxNode,
} from '../../../../../src/core/ingestion/utils/ast-helpers.js';

function firstNode(language: Parser.Language, src: string, type: string): SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(language);
  const node = parser.parse(src).rootNode.descendantsOfType(type)[0];
  assert.notEqual(node, undefined, `expected a ${type} node in source`);
  return node;
}

describe('extractLeadingDocComment', () => {
  it('extracts a multi-line Javadoc including tag content (issue #2270 repro)', () => {
    const src = `package demo;
public class Probe {
  /**
   * Computes the running balance across all user accounts.
   * @param userId the unique user identifier
   * @deprecated since 2.0, use computeBalanceV2
   */
  public java.math.BigDecimal computeBalance(Long userId) { return null; }
}`;
    const method = firstNode(Java, src, 'method_declaration');
    const doc = extractLeadingDocComment(method);
    assert.ok(doc.includes('Computes the running balance'));
    assert.ok(doc.includes('userId'));
    assert.ok(doc.includes('computeBalanceV2'));
  });

  it('extracts a class-level Javadoc', () => {
    const cls = firstNode(
      Java,
      `/**\n * A probe class.\n */\npublic class Probe {}`,
      'class_declaration',
    );
    assert.equal(extractLeadingDocComment(cls), 'A probe class.');
  });

  it('returns undefined when there is no preceding comment', () => {
    const method = firstNode(Java, `class P { void m() {} }`, 'method_declaration');
    assert.equal(extractLeadingDocComment(method), undefined);
  });

  it('returns undefined for a non-doc block comment (license header style)', () => {
    const method = firstNode(
      Java,
      `class P {\n/* not a doc comment */\nvoid m() {}\n}`,
      'method_declaration',
    );
    assert.equal(extractLeadingDocComment(method), undefined);
  });

  it('returns undefined for a // line comment', () => {
    const method = firstNode(
      Java,
      `class P {\n// just a line comment\nvoid m() {}\n}`,
      'method_declaration',
    );
    assert.equal(extractLeadingDocComment(method), undefined);
  });

  it('returns undefined for an empty doc comment', () => {
    const method = firstNode(Java, `class P {\n/** */\nvoid m() {}\n}`, 'method_declaration');
    assert.equal(extractLeadingDocComment(method), undefined);
  });

  it('returns undefined for the degenerate empty comment /**/ (no spurious slash)', () => {
    const method = firstNode(Java, `class P {\n/**/\nvoid m() {}\n}`, 'method_declaration');
    assert.equal(extractLeadingDocComment(method), undefined);
  });

  it('strips the */ delimiters and per-line * gutter markers', () => {
    const cls = firstNode(
      Java,
      `/**\n * Line one.\n * Line two.\n */\nclass P {}`,
      'class_declaration',
    );
    const doc = extractLeadingDocComment(cls);
    assert.equal(doc, 'Line one. Line two.');
    assert.ok(!doc.includes('*'));
    assert.ok(!doc.includes('/'));
  });

  it('skips a file-top SPDX license header (no package/import shield)', () => {
    const cls = firstNode(
      Java,
      `/** SPDX-License-Identifier: MIT */\npublic class Foo {}`,
      'class_declaration',
    );
    assert.equal(extractLeadingDocComment(cls), undefined);
  });

  it('skips a file-top copyright header block', () => {
    const cls = firstNode(
      Java,
      `/**\n * Copyright (c) 2026 Acme Corp. All rights reserved.\n * Licensed under the Apache License 2.0.\n */\npublic class Foo {}`,
      'class_declaration',
    );
    assert.equal(extractLeadingDocComment(cls), undefined);
  });

  it('does NOT over-fire: a real doc that merely mentions copyright is preserved', () => {
    const method = firstNode(
      Java,
      `class P {\n/** Returns the copyright owner name, marker KEEPME. */\nString owner() { return null; }\n}`,
      'method_declaration',
    );
    const doc = extractLeadingDocComment(method);
    assert.ok(doc.includes('KEEPME'));
    assert.ok(doc.includes('copyright owner'));
  });

  it('strips bidi-override and zero-width controls from the description', () => {
    const rlo = String.fromCharCode(0x202e); // right-to-left override
    const zwsp = String.fromCharCode(0x200b); // zero-width space
    const cls = firstNode(
      Java,
      `/** Doc ${rlo}with${zwsp} hidden controls, marker BIDIMARK. */\npublic class Foo {}`,
      'class_declaration',
    );
    const doc = extractLeadingDocComment(cls);
    assert.ok(doc.includes('BIDIMARK'));
    assert.ok(!doc.includes(rlo));
    assert.ok(!doc.includes(zwsp));
  });

  it('leaves a plain ASCII doc comment unchanged', () => {
    const cls = firstNode(
      Java,
      `/** Plain doc, marker ASCIIMARK. */\nclass Foo {}`,
      'class_declaration',
    );
    assert.equal(extractLeadingDocComment(cls), 'Plain doc, marker ASCIIMARK.');
  });
});
