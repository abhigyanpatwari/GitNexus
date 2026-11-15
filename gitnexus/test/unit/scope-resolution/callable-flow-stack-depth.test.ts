import { describe, expect, it } from 'vitest';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Dart))(
  'callable operand search stack',
  () => {
    it('keeps every scope in a deeply nested argument closure', () => {
      const depth = 500;
      const source =
        'void f(Address cs, List<int> xs) {\n' +
        Array.from({ length: depth }, (_, i) => `xs.forEach((x${i}) { cs.save(x${i});\n`).join('') +
        '});\n'.repeat(depth) +
        '}\n';
      const matches = emitDartScopeCaptures(source, 'nest.dart');
      expect(matches.filter((match) => match['@scope.function']).length).toBe(depth + 1);
    });

    // The tree walk keeps its pending nodes on the heap, so the nesting it
    // accepts does not depend on the call stack: a frame per syntax node gave
    // out near 700 closures with a default stack, lower inside a test runner.
    it('keeps every scope four times deeper than a frame per syntax node allows', () => {
      const depth = 2000;
      const source =
        'void f(Address cs, List<int> xs) {\n' +
        Array.from({ length: depth }, (_, i) => `xs.forEach((x${i}) { cs.save(x${i});\n`).join('') +
        '});\n'.repeat(depth) +
        '}\n';
      const matches = emitDartScopeCaptures(source, 'deep-nest.dart');
      expect(matches.filter((match) => match['@scope.function']).length).toBe(depth + 1);
      expect(
        matches.filter((match) => match['@reference.call.member']?.text === 'save').length,
      ).toBe(depth);
    });
  },
);
