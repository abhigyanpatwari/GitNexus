import Parser from 'tree-sitter';
import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

import { preprocessObjectiveCMacroWrappers } from '../../src/core/ingestion/languages/objective-c/macro-semantics.js';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.js';

function parse(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(
    getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
  );
  return parser.parse(source);
}

describe('Objective-C macro preprocessing', () => {
  it('recovers NS_ENUM without changing offsets or newlines', () => {
    const source = 'typedef NS_ENUM(NSInteger, Mode) {\n  ModeA,\n};\n';
    const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Mode.h');

    expect(transformed).toHaveLength(source.length);
    expect([...transformed].filter((character) => character === '\n')).toHaveLength(3);
    expect(transformed).toContain('enum/*E*/ Mode');
    expect(parse(transformed).rootNode.hasError).toBe(false);
    expect(preprocessObjectiveCMacroWrappers(transformed, 'Sources/Mode.h')).toBe(transformed);
  });

  it('leaves strings and malformed macro invocations unchanged', () => {
    const source = '@"NS_ENUM(NSInteger, Mode)"\nNS_UNKNOWN(\n';

    expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Mode.m')).toBe(source);
  });
});
