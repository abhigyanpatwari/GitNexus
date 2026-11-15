import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { emitSwiftScopeCaptures } from '../../src/core/ingestion/languages/swift/captures.js';
import { getSwiftParser } from '../../src/core/ingestion/languages/swift/query.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Swift))(
  'Swift parameter signature completeness',
  () => {
    it('preserves an unknown pack slot before a known variadic parameter', () => {
      const source = 'func find<each T>(_ kinds: repeat each T, values: Int...) -> User { User() }';
      expect(getSwiftParser().parse(source).rootNode.hasError).toBe(false);
      const groups = emitSwiftScopeCaptures(source, 'signature.swift').filter(
        (group) => group['@scope.function'],
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]?.['@declaration.parameter-count']).toBeUndefined();
      const types = groups[0]?.['@declaration.parameter-types'];
      expect(types).toBeDefined();
      expect(JSON.parse(types?.text ?? 'null')).toEqual(['', 'Int', 'variadic']);
    });
  },
);
