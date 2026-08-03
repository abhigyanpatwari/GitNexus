import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';

import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.js';
import * as ingestionQueries from '../../src/core/ingestion/tree-sitter-queries.js';

const SOURCE = `
@protocol Saving
- (void)save:(id)value;
@end

@interface Store : NSObject <Saving>
@property (nonatomic, strong) id value;
- (void)save:(id)value;
@end

@implementation Store
- (void)save:(id)value {
  [self setValue:value];
}
@end
`;

const CORE_QUERY = `
(protocol_declaration) @protocol
(class_interface) @class.interface
(property_declaration) @property
(method_declaration) @method.declaration
(class_implementation) @class.implementation
(method_definition) @method.definition
(message_expression) @message
`;

describe('vendored Objective-C grammar', () => {
  it('is available through the guarded parser-loader registry', () => {
    expect(getLanguageGrammar(SupportedLanguages.ObjectiveC)).toBeTruthy();
  });

  it('loads, compiles the core query, and parses Objective-C with tree-sitter 0.21', () => {
    const language = requireVendoredGrammar(
      'tree-sitter-objc',
    ) as ConstructorParameters<typeof Parser.Query>[0];
    const parser = new Parser();
    parser.setLanguage(language);

    const tree = parser.parse(SOURCE);
    expect(tree.rootNode.type).toBe('translation_unit');
    expect(tree.rootNode.hasError).toBe(false);

    const query = new Parser.Query(language, CORE_QUERY);
    const captureCounts = query.captures(tree.rootNode).reduce<Record<string, number>>(
      (counts, capture) => {
        counts[capture.name] = (counts[capture.name] ?? 0) + 1;
        return counts;
      },
      {},
    );

    expect(captureCounts).toEqual({
      protocol: 1,
      'method.declaration': 2,
      'class.interface': 1,
      property: 1,
      'class.implementation': 1,
      'method.definition': 1,
      message: 1,
    });
  });

  it('compiles the registered ingestion query and captures Objective-C definitions', () => {
    const querySource = (
      ingestionQueries as unknown as { OBJECTIVE_C_QUERIES?: string }
    ).OBJECTIVE_C_QUERIES;
    expect(querySource).toBeTypeOf('string');
    if (!querySource) return;

    const language = getLanguageGrammar(
      SupportedLanguages.ObjectiveC,
    ) as ConstructorParameters<typeof Parser.Query>[0];
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(SOURCE);
    const captures = new Parser.Query(language, querySource).captures(tree.rootNode);

    expect(captures.some((capture) => capture.name === 'definition.interface')).toBe(true);
    expect(captures.some((capture) => capture.name === 'definition.class')).toBe(true);
    expect(captures.some((capture) => capture.name === 'definition.property')).toBe(true);
    expect(captures.some((capture) => capture.name === 'definition.method')).toBe(true);
    expect(captures.some((capture) => capture.name === 'call')).toBe(true);
  });
});
