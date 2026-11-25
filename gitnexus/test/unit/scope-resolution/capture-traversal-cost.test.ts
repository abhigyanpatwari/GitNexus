import { describe, expect, it, vi } from 'vitest';
import type Parser from 'tree-sitter';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { getKotlinParser } from '../../../src/core/ingestion/languages/kotlin/query.js';
import { emitKotlinScopeCaptures } from '../../../src/core/ingestion/languages/kotlin/captures.js';

let kotlinAvailable = isLanguageAvailable(SupportedLanguages.Kotlin);
if (kotlinAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Kotlin);
  } catch {
    kotlinAvailable = false;
  }
}

function nodePrototype(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let prototype = Object.getPrototypeOf(node) as Parser.SyntaxNode;
  while (!Object.hasOwn(prototype, 'namedChild')) prototype = Object.getPrototypeOf(prototype);
  return prototype;
}

describe('capture traversal work', () => {
  it.skipIf(!kotlinAvailable)(
    'does not enumerate every descendant for each filtered Kotlin search',
    () => {
      const source = Array.from(
        { length: 30 },
        (_, i) => `fun f${i}(value: Int): Int { return value + 1 }`,
      ).join('\n');
      const tree = getKotlinParser().parse(source);
      expect(tree.rootNode.hasError).toBe(false);
      const child = vi.spyOn(nodePrototype(tree.rootNode), 'namedChild');
      try {
        const captures = emitKotlinScopeCaptures(source, 'fixture.kt', tree);
        expect(captures.filter((match) => match['@declaration.function']).length).toBe(30);
        expect(child.mock.calls.length).toBe(10 * 30);
      } finally {
        child.mockRestore();
      }
    },
  );
});
