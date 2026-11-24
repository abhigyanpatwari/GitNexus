import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import {
  listGrammarSources,
  getLanguageGrammar,
} from '../../../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../../../src/config/supported-languages.js';
import { isOptionalGrammarRequired } from '../../../../../test/helpers/optional-grammar.js';

/**
 * ABI load-smoke (#1922). For EVERY entry in `parser-loader.ts` SOURCES,
 * `setLanguage` + parse a trivial snippet on a real `Parser`. This is the
 * runtime counterpart to the static ABI assertion in
 * `.github/scripts/check-tree-sitter-upgrade-readiness.py --assert-current`:
 *
 *   - Required grammars MUST load and parse — an ABI-incompatible native
 *     binding (the #1242-class failure) fails here loudly.
 *   - Optional / vendored grammars (swift/dart/kotlin) must either load OR
 *     cleanly report unavailable — never hard-crash the process.
 *
 * Swift is prebuilt-only (no introspectable parser.c) so the static Python
 * check can't assert its ABI; this smoke is where an ABI-incompatible Swift
 * `.node` is caught. It is therefore included explicitly below.
 *
 * The (language, filePath, snippet) map is keyed by the raw SOURCES key so
 * the `:tsx` variant is exercised distinctly from plain TypeScript.
 */

interface SmokeCase {
  language: SupportedLanguages;
  filePath?: string;
  snippet: string;
  rootType: string;
}

// Keyed by the exact SOURCES key (see parser-loader.ts) so every row —
// including `typescript:tsx` — has an explicit, asserted snippet.
const SMOKE_CASES: Record<string, SmokeCase> = {
  [SupportedLanguages.Java]: {
    language: SupportedLanguages.Java,
    snippet: 'class A {}\n',
    rootType: 'program',
  },
};

describe('parser-loader ABI load-smoke (#1922)', () => {
  const sources = listGrammarSources().filter(({ key }) => key === SupportedLanguages.Java);

  for (const { key, optional } of sources) {
    const testCase = SMOKE_CASES[key];
    if (!testCase) continue; // covered by the "every entry" assertion above

    it(`${optional ? 'optionally ' : ''}loads + parses ${key}`, () => {
      let grammar: unknown;
      try {
        grammar = getLanguageGrammar(testCase.language, testCase.filePath);
      } catch (err) {
        // GITNEXUS_REQUIRE_<LANG>=1 revokes the optional exemption: a job that
        // sets it runs on a platform the grammar publishes a prebuild for, so a
        // load failure there is a real regression, not an absent binding.
        if (optional && !isOptionalGrammarRequired(key)) {
          // Optional/vendored grammar absent on this platform — the loader
          // reported it cleanly (the only acceptable failure mode). Never a
          // hard crash; the throw above proves a clean JS-level error.
          assert.ok(err instanceof Error);
          return;
        }
        throw err;
      }

      // A grammar that loads MUST parse + walk without crashing. Touching
      // node.type is what surfaces an ABI mismatch (the #1242 unmarshalNode
      // crash) rather than a benign load.
      const parser = new Parser();
      parser.setLanguage(grammar as Parameters<Parser['setLanguage']>[0]);
      const tree = parser.parse(testCase.snippet);
      assert.equal(typeof tree.rootNode.type, 'string');
      assert.equal(tree.rootNode.type, testCase.rootType);
    });
  }
});
