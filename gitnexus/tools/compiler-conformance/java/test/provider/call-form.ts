import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MixedChainStep } from 'gitnexus-shared';
import {
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  extractMixedChain,
} from '../../../../../src/core/ingestion/utils/call-analysis.js';
import type { SyntaxNode } from '../../../../../src/core/ingestion/utils/ast-helpers.js';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { SupportedLanguages } from '../../../../../src/config/supported-languages.js';
import { getProvider } from '../../../../../src/core/ingestion/languages/index.js';

/**
 * Helper: parse code, run the language query, and return all @call captures
 * as { callNode, nameNode } pairs.
 */
function extractCallCaptures(
  parser: Parser,
  code: string,
  language: string,
): Array<{ callNode: SyntaxNode; nameNode: SyntaxNode; calledName: string }> {
  const provider = getProvider(language as SupportedLanguages);
  const queryStr = provider.treeSitterQueries;
  if (!queryStr) throw new Error(`No query for ${language}`);

  const tree = parser.parse(code);
  const lang = parser.getLanguage();
  const query = new Parser.Query(lang, queryStr);
  const matches = query.matches(tree.rootNode);

  const results: Array<{ callNode: SyntaxNode; nameNode: SyntaxNode; calledName: string }> = [];

  for (const match of matches) {
    const captureMap: Record<string, SyntaxNode> = {};
    for (const c of match.captures) {
      captureMap[c.name] = c.node;
    }
    if (captureMap['call'] && captureMap['call.name']) {
      results.push({
        callNode: captureMap['call'],
        nameNode: captureMap['call.name'],
        calledName: captureMap['call.name'].text,
      });
    }
  }

  return results;
}

describe('inferCallForm', () => {
  const parser = new Parser();

  describe('Java', () => {
    it('detects free call (no object)', () => {
      parser.setLanguage(Java);
      const code = `class Foo { void run() { doStuff(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Java);
      const match = captures.find((c) => c.calledName === 'doStuff');
      assert.notEqual(match, undefined);
      assert.equal(inferCallForm(match!.callNode, match!.nameNode), 'free');
    });

    it('detects member call (with object)', () => {
      parser.setLanguage(Java);
      const code = `class Foo { void run() { user.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Java);
      const match = captures.find((c) => c.calledName === 'save');
      assert.notEqual(match, undefined);
      assert.equal(inferCallForm(match!.callNode, match!.nameNode), 'member');
    });
  });
});

describe('extractReceiverName', () => {
  const parser = new Parser();

  describe('Java', () => {
    it('extracts receiver from method_invocation', () => {
      parser.setLanguage(Java);
      const code = `class Foo { void run() { user.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Java);
      const match = captures.find((c) => c.calledName === 'save');
      assert.notEqual(match, undefined);
      assert.equal(extractReceiverName(match!.nameNode), 'user');
    });
  });
});

// ---------------------------------------------------------------------------
// extractMixedChain: callee and receiver spellings the chain walk has to read
// ---------------------------------------------------------------------------

/** First leaf whose text is `name`, depth-first. */
function findLeaf(node: SyntaxNode, name: string): SyntaxNode | undefined {
  if (node.namedChildCount === 0) return node.text === name ? node : undefined;
  for (const child of node.namedChildren) {
    const hit = findLeaf(child, name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** What `extractMixedChain` reads off the receiver of the call to `member`. */
function receiverChainOf(language: Parser.Language, code: string, member: string) {
  const parser = new Parser();
  parser.setLanguage(language);
  const nameNode = findLeaf(parser.parse(code).rootNode, member);
  const receiver = nameNode === undefined ? undefined : extractReceiverNode(nameNode);
  if (receiver === undefined) throw new Error(`no receiver for ${member} in: ${code}`);
  return extractMixedChain(receiver);
}

const call = (name: string): MixedChainStep => ({ kind: 'call', name });

interface ChainRow {
  readonly label: string;
  /** `undefined` when an optional grammar did not load on this host. */
  readonly language: Parser.Language | undefined;
  readonly code: string;
  readonly member: string;
  readonly expected: ReturnType<typeof extractMixedChain>;
}

/** A row whose grammar did not load is reported skipped, never passed. */

describe('extractMixedChain', () => {
  // Explicit type arguments inside the callee node (#3498 RC3). The step must be
  // named for the member, and Rust's wrapper must not hide the inner receiver.
  const typeArgumentRows: readonly ChainRow[] = [
    {
      label: 'Java type arguments sit beside the name (control)',
      language: Java,
      code: 'class A { void m() { svc.<User>getTyped().save(); } }',
      member: 'save',
      expected: { chain: [call('getTyped')], baseReceiverName: 'svc' },
    },
  ];

  for (const row of typeArgumentRows)
    it(row.label, () => {
      if (!row.language) throw new Error('Java grammar unavailable');
      assert.deepEqual(receiverChainOf(row.language, row.code, row.member), row.expected);
    });
});
