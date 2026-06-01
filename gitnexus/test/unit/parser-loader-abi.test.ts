import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import {
  listGrammarSources,
  getLanguageGrammar,
} from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

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
  [SupportedLanguages.JavaScript]: {
    language: SupportedLanguages.JavaScript,
    snippet: 'const x = 1;\n',
    rootType: 'program',
  },
  [SupportedLanguages.TypeScript]: {
    language: SupportedLanguages.TypeScript,
    filePath: 'a.ts',
    snippet: 'const x: number = 1;\n',
    rootType: 'program',
  },
  [`${SupportedLanguages.TypeScript}:tsx`]: {
    language: SupportedLanguages.TypeScript,
    filePath: 'a.tsx',
    snippet: 'const x = <div />;\n',
    rootType: 'program',
  },
  [SupportedLanguages.Python]: {
    language: SupportedLanguages.Python,
    snippet: 'x = 1\n',
    rootType: 'module',
  },
  [SupportedLanguages.Java]: {
    language: SupportedLanguages.Java,
    snippet: 'class A {}\n',
    rootType: 'program',
  },
  [SupportedLanguages.CSharp]: {
    language: SupportedLanguages.CSharp,
    snippet: 'class A {}\n',
    rootType: 'compilation_unit',
  },
  [SupportedLanguages.CPlusPlus]: {
    language: SupportedLanguages.CPlusPlus,
    snippet: 'int main() { return 0; }\n',
    rootType: 'translation_unit',
  },
  [SupportedLanguages.Go]: {
    language: SupportedLanguages.Go,
    snippet: 'package main\nfunc main() {}\n',
    rootType: 'source_file',
  },
  [SupportedLanguages.Rust]: {
    language: SupportedLanguages.Rust,
    snippet: 'fn main() {}\n',
    rootType: 'source_file',
  },
  [SupportedLanguages.PHP]: {
    language: SupportedLanguages.PHP,
    snippet: '<?php $x = 1;\n',
    rootType: 'program',
  },
  [SupportedLanguages.Ruby]: {
    language: SupportedLanguages.Ruby,
    snippet: 'x = 1\n',
    rootType: 'program',
  },
  [SupportedLanguages.Vue]: {
    language: SupportedLanguages.Vue,
    snippet: 'const x = 1;\n',
    rootType: 'program',
  },
  [SupportedLanguages.C]: {
    language: SupportedLanguages.C,
    snippet: 'int main(void) { return 0; }\n',
    rootType: 'translation_unit',
  },
  [SupportedLanguages.Swift]: {
    language: SupportedLanguages.Swift,
    snippet: 'class Foo { func bar() {} }\n',
    rootType: 'source_file',
  },
  [SupportedLanguages.Dart]: {
    language: SupportedLanguages.Dart,
    snippet: 'void main() {}\n',
    rootType: 'program',
  },
  [SupportedLanguages.Kotlin]: {
    language: SupportedLanguages.Kotlin,
    snippet: 'fun main() {}\n',
    rootType: 'source_file',
  },
};

describe('parser-loader ABI load-smoke (#1922)', () => {
  const sources = listGrammarSources();

  it('has a smoke case for every registered grammar SOURCES entry', () => {
    const missing = sources.map((s) => s.key).filter((key) => !(key in SMOKE_CASES));
    expect(missing, `add a SMOKE_CASES entry for: ${missing.join(', ')}`).toEqual([]);
  });

  // Explicit guard: Swift must be in the matrix so an ABI-incompatible
  // prebuilt .node is caught here (the static Python check can't introspect
  // a binary-only vendor).
  it('includes Swift in the smoke matrix', () => {
    expect(sources.some((s) => s.key === SupportedLanguages.Swift)).toBe(true);
  });

  for (const { key, optional } of sources) {
    const testCase = SMOKE_CASES[key];
    if (!testCase) continue; // covered by the "every entry" assertion above

    it(`${optional ? 'optionally ' : ''}loads + parses ${key}`, () => {
      let grammar: unknown;
      try {
        grammar = getLanguageGrammar(testCase.language, testCase.filePath);
      } catch (err) {
        if (optional) {
          // Optional/vendored grammar absent on this platform — the loader
          // reported it cleanly (the only acceptable failure mode). Never a
          // hard crash; the throw above proves a clean JS-level error.
          expect(err).toBeInstanceOf(Error);
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
      expect(typeof tree.rootNode.type).toBe('string');
      expect(tree.rootNode.type).toBe(testCase.rootType);
    });
  }
});
