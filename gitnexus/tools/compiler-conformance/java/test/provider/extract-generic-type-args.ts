import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import { extractGenericTypeArgs } from '../../../../../src/core/ingestion/type-extractors/shared.js';
import { getLanguageGrammar } from '../../../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../../../src/config/supported-languages.js';
import type { SyntaxNode } from '../../../../../src/core/ingestion/utils/ast-helpers.js';

describe('extractGenericTypeArgs', () => {
  // Ground the extractor against the REAL node types each shipped grammar emits
  // for a generic — no mocks. This is what catches grammar drift / wrong guesses
  // (e.g. the never-emitted `parameterized_type` the extractor used to special-
  // case): Java/TypeScript/Rust → generic_type, C# → generic_name, Kotlin →
  // user_type (List<User> → user_type > [type_identifier, type_arguments]). #1920
  describe('real grammar generic types (parsed, not mocked)', () => {
    // Return the smallest parsed node whose text is exactly `typeText`.
    function parseTypeNode(
      lang: SupportedLanguages,
      file: string,
      code: string,
      typeText: string,
    ): SyntaxNode {
      const parser = new Parser();
      parser.setLanguage(getLanguageGrammar(lang, file) as Parameters<Parser['setLanguage']>[0]);
      const tree = parser.parse(code);
      let best: SyntaxNode | null = null;
      const walk = (n: SyntaxNode): void => {
        if (n.text === typeText && (best === null || n.text.length <= best.text.length)) best = n;
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (c) walk(c as unknown as SyntaxNode);
        }
      };
      walk(tree.rootNode as unknown as SyntaxNode);
      if (best === null) throw new Error(`no node with text "${typeText}" parsed for ${lang}`);
      return best;
    }

    const cases: Array<{
      lang: SupportedLanguages;
      file: string;
      code: string;
      typeText: string;
      expected: string[];
    }> = [
      {
        lang: SupportedLanguages.Java,
        file: 'C.java',
        code: 'class C { List<User> f; }',
        typeText: 'List<User>',
        expected: ['User'],
      },
      {
        lang: SupportedLanguages.Java,
        file: 'C.java',
        code: 'class C { Map<String, User> f; }',
        typeText: 'Map<String, User>',
        expected: ['String', 'User'],
      },
    ];

    for (const { lang, file, code, typeText, expected } of cases) {
      it(`captures [${expected.join(', ')}] from a real ${lang} \`${typeText}\``, () => {
        const node = parseTypeNode(lang, file, code, typeText);
        assert.deepEqual(extractGenericTypeArgs(node), expected);
      });
    }
  });
});
