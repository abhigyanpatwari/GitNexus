import { describe, it, expect, beforeAll } from 'vitest';
import {
  loadParser,
  loadLanguage,
  isLanguageAvailable,
} from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import Parser from 'tree-sitter';

/**
 * Smoke test: verify that every language provider's treeSitterQueries compiles
 * against its tree-sitter grammar without throwing.  A silent Query compilation
 * failure is the #1 cause of "0 nodes extracted for language X" bugs.
 */
describe('Query compilation smoke tests', () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await loadParser();
  });

  const languageFiles: Record<string, string> = {
    [SupportedLanguages.TypeScript]: 'test.ts',
    [SupportedLanguages.JavaScript]: 'test.js',
    [SupportedLanguages.Python]: 'test.py',
    [SupportedLanguages.Java]: 'Test.java',
    [SupportedLanguages.C]: 'test.c',
    [SupportedLanguages.CPlusPlus]: 'test.cpp',
    [SupportedLanguages.CSharp]: 'Test.cs',
    [SupportedLanguages.Go]: 'test.go',
    [SupportedLanguages.Rust]: 'test.rs',
    [SupportedLanguages.PHP]: 'test.php',
    [SupportedLanguages.Kotlin]: 'Test.kt',
    [SupportedLanguages.Swift]: 'test.swift',
    [SupportedLanguages.Dart]: 'test.dart',
  };

  // Known query compilation failures — remove from this set as PRs fix them
  const knownFailures = new Set<string>([]);

  for (const [lang, filename] of Object.entries(languageFiles)) {
    const testFn = knownFailures.has(lang) ? it.fails : it;

    testFn(`compiles query for ${lang}`, async () => {
      if (!isLanguageAvailable(lang as SupportedLanguages)) {
        return; // parser binary not available in this environment
      }

      await loadLanguage(lang as SupportedLanguages, filename);
      const provider = getProvider(lang as SupportedLanguages);
      const queryStr = provider.treeSitterQueries;
      expect(queryStr).toBeTruthy();

      const grammar = parser.getLanguage();
      // This is the line that silently fails in production when queries
      // use node types that don't exist in the grammar.
      const query = new Parser.Query(grammar, queryStr);
      expect(query).toBeDefined();

      // Verify it can actually run against a minimal tree
      const tree = parser.parse('');
      const matches = query.matches(tree.rootNode);
      expect(Array.isArray(matches)).toBe(true);
    });
  }
});
