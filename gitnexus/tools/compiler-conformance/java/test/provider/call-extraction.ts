import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCallExtractor } from '../../../../../src/core/ingestion/call-extractors/generic.js';
import { javaCallConfig } from '../../../../../src/core/ingestion/call-extractors/configs/jvm.js';
import type { SyntaxNode } from '../../../../../src/core/ingestion/utils/ast-helpers.js';
import { SupportedLanguages } from '../../../../../src/config/supported-languages.js';
import { getProvider } from '../../../../../src/core/ingestion/languages/index.js';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse code with a tree-sitter language and run the language's query to find
 * @call / @call.name captures.
 */
function extractCallCaptures(
  parser: Parser,
  code: string,
  language: SupportedLanguages,
): Array<{
  callNode: SyntaxNode;
  nameNode: SyntaxNode | undefined;
  calledName: string | undefined;
}> {
  const provider = getProvider(language);
  const queryStr = provider.treeSitterQueries;
  if (!queryStr) throw new Error(`No query for ${language}`);

  const tree = parser.parse(code);
  const lang = parser.getLanguage();
  const query = new Parser.Query(lang, queryStr);
  const matches = query.matches(tree.rootNode);

  const results: Array<{
    callNode: SyntaxNode;
    nameNode: SyntaxNode | undefined;
    calledName: string | undefined;
  }> = [];

  for (const match of matches) {
    const captureMap: Record<string, SyntaxNode> = {};
    for (const c of match.captures) {
      captureMap[c.name] = c.node;
    }
    if (captureMap['call']) {
      results.push({
        callNode: captureMap['call'],
        nameNode: captureMap['call.name'],
        calledName: captureMap['call.name']?.text,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Generic extraction via @call.name
// ---------------------------------------------------------------------------

describe('generic call extraction', () => {
  const parser = new Parser();

  describe('Java', () => {
    const extractor = createCallExtractor(javaCallConfig);

    it('extracts free function call', () => {
      parser.setLanguage(Java);
      const captures = extractCallCaptures(
        parser,
        'class A { void m() { doStuff(); } }',
        SupportedLanguages.Java,
      );
      const match = captures.find((c) => c.calledName === 'doStuff');
      assert.notEqual(match, undefined);
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      assert.notEqual(result, null);
      assert.equal(result!.calledName, 'doStuff');
      assert.equal(result!.callForm, 'free');
    });

    it('extracts member call with receiver', () => {
      parser.setLanguage(Java);
      const captures = extractCallCaptures(
        parser,
        'class A { void m() { user.save(); } }',
        SupportedLanguages.Java,
      );
      const match = captures.find((c) => c.calledName === 'save');
      assert.notEqual(match, undefined);
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      assert.notEqual(result, null);
      assert.equal(result!.callForm, 'member');
      assert.equal(result!.receiverName, 'user');
    });

    it('sets typeAsReceiverHeuristic', () => {
      parser.setLanguage(Java);
      const captures = extractCallCaptures(
        parser,
        'class A { void m() { User.find(); } }',
        SupportedLanguages.Java,
      );
      const match = captures.find((c) => c.calledName === 'find');
      assert.notEqual(match, undefined);
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      assert.notEqual(result, null);
      assert.equal(result!.typeAsReceiverHeuristic, true);
    });
  });
});

// ---------------------------------------------------------------------------
// Language-specific call site extraction (Java :: method references)
// ---------------------------------------------------------------------------

describe('Java method_reference extraction', () => {
  const parser = new Parser();
  parser.setLanguage(Java);
  const extractor = createCallExtractor(javaCallConfig);

  it('extracts Type::new as constructor', () => {
    const captures = extractCallCaptures(
      parser,
      'class A { void m() { stream.map(User::new); } }',
      SupportedLanguages.Java,
    );
    // The method_reference should be captured as @call
    const match = captures.find((c) => c.callNode.type === 'method_reference');
    if (match) {
      const result = extractor.extract(match.callNode, undefined);
      assert.notEqual(result, null);
      assert.equal(result!.calledName, 'User');
      assert.equal(result!.callForm, 'constructor');
    }
  });

  it('extracts Type::method as member call', () => {
    const captures = extractCallCaptures(
      parser,
      'class A { void m() { stream.map(User::getName); } }',
      SupportedLanguages.Java,
    );
    const match = captures.find((c) => c.callNode.type === 'method_reference');
    if (match) {
      const result = extractor.extract(match.callNode, undefined);
      assert.notEqual(result, null);
      assert.equal(result!.calledName, 'getName');
      assert.equal(result!.callForm, 'member');
      assert.equal(result!.receiverName, 'User');
      assert.equal(result!.typeAsReceiverHeuristic, true);
    }
  });

  it('extracts this::method as member call', () => {
    const captures = extractCallCaptures(
      parser,
      'class A { void m() { stream.map(this::process); } }',
      SupportedLanguages.Java,
    );
    const match = captures.find((c) => c.callNode.type === 'method_reference');
    if (match) {
      const result = extractor.extract(match.callNode, undefined);
      assert.notEqual(result, null);
      assert.equal(result!.calledName, 'process');
      assert.equal(result!.callForm, 'member');
      assert.equal(result!.receiverName, 'this');
    }
  });

  it('extractLanguageCallSite returns null for non-method_reference nodes', () => {
    const captures = extractCallCaptures(
      parser,
      'class A { void m() { doStuff(); } }',
      SupportedLanguages.Java,
    );
    const match = captures.find((c) => c.calledName === 'doStuff');
    assert.notEqual(match, undefined);
    // Language seed should be null for regular calls
    const langSeed = extractor.extract(match!.callNode, undefined);
    assert.equal(langSeed, null);
    // But full extraction with callNameNode should work
    const full = extractor.extract(match!.callNode, match!.nameNode!);
    assert.notEqual(full, null);
    assert.equal(full!.calledName, 'doStuff');
  });
});
