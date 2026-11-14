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
  },
);
