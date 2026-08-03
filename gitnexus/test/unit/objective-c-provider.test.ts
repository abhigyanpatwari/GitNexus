import Parser from 'tree-sitter';
import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

import { getProvider, getProviderForFile } from '../../src/core/ingestion/languages/index.js';
import { OBJECTIVE_C_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.js';

function parse(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(
    getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
  );
  return parser.parse(source);
}

describe('Objective-C language provider registration', () => {
  it('registers .m without stealing ambiguous .h from filename fallback', () => {
    const provider = getProvider(SupportedLanguages.ObjectiveC);
    expect(provider.id).toBe(SupportedLanguages.ObjectiveC);
    expect(provider.extensions).toEqual(['.m']);
    expect(provider.treeSitterQueries).toBe(OBJECTIVE_C_QUERIES);
    expect(getProviderForFile('Sources/Store.m')?.id).toBe(SupportedLanguages.ObjectiveC);
    expect(getProviderForFile('Sources/Store.h')?.id).toBe(SupportedLanguages.CPlusPlus);
    expect(getProviderForFile('Sources/Store.mm')).toBeNull();
  });

  it('provides canonical class, method, property, and message extractors', () => {
    const provider = getProvider(SupportedLanguages.ObjectiveC);
    const tree = parse(`
      @protocol StoreDelegate <NSObject>
      - (void)didSave:(id)value;
      @end
      @interface Store : NSObject <StoreDelegate>
      @property (nonatomic, strong, readonly) NSString *name;
      + (instancetype)shared;
      - (void)save:(id)value completion:(id)completion;
      @end
      @implementation Store
      - (void)save:(id)value completion:(id)completion {
        [Store shared];
      }
      @end
    `);
    const interfaceNode = tree.rootNode.descendantsOfType('class_interface')[0];
    const protocolNode = tree.rootNode.descendantsOfType('protocol_declaration')[0];
    const implementationNode = tree.rootNode.descendantsOfType('class_implementation')[0];

    expect(provider.classExtractor?.extract(interfaceNode)).toMatchObject({
      name: 'Store',
      type: 'Class',
      qualifiedName: 'Store',
    });
    expect(provider.classExtractor?.extract(protocolNode)).toMatchObject({
      name: 'StoreDelegate',
      type: 'Interface',
    });
    expect(
      provider.methodExtractor
        ?.extract(interfaceNode, {
          filePath: 'Store.h',
          language: SupportedLanguages.ObjectiveC,
        })
        ?.methods.map((method) => [method.name, method.isStatic, method.parameters.length]),
    ).toEqual([
      ['+shared', true, 0],
      ['-save:completion:', false, 2],
    ]);
    expect(
      provider.methodExtractor?.extract(implementationNode, {
        filePath: 'Store.m',
        language: SupportedLanguages.ObjectiveC,
      })?.methods[0],
    ).toMatchObject({
      name: '-save:completion:',
      returnType: 'void',
    });
    expect(
      provider.fieldExtractor?.extract(interfaceNode, {
        filePath: 'Store.h',
        language: SupportedLanguages.ObjectiveC,
        typeEnv: {} as never,
        symbolTable: {} as never,
      })?.fields[0],
    ).toMatchObject({
      name: 'name',
      type: 'NSString',
      isReadonly: true,
    });

    const message = tree.rootNode.descendantsOfType('message_expression')[0];
    expect(provider.callExtractor?.extract(message, undefined)).toEqual({
      calledName: '+shared',
      callForm: 'member',
      receiverName: 'Store',
      argCount: 0,
      typeAsReceiverHeuristic: true,
    });
  });
});
