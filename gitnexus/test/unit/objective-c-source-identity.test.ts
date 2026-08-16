import Parser from 'tree-sitter';
import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

import { extractObjectiveCDefinitionMetadata } from '../../src/core/ingestion/languages/objective-c/metadata.js';
import {
  objectiveCKeyV1,
  objectiveCSourceIdentity,
} from '../../src/core/ingestion/languages/objective-c/identity.js';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.js';

function parse(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(
    getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
  );
  return parser.parse(source);
}

describe('Objective-C source identity', () => {
  it('uses deterministic NFC-normalized, delimiter-safe keys', () => {
    expect(objectiveCKeyV1(['type', 'Cafe\u0301'])).toBe(objectiveCKeyV1(['type', 'Café']));
    expect(
      objectiveCSourceIdentity({
        label: 'Method',
        owner: 'Store',
        declarationScope: '<primary>',
        sourceRole: 'implementation',
        member: '-save:completion:',
      }),
    ).toBe('objc:v1:["source","Method","Store","<primary>","implementation","-save:completion:"]');
  });

  it('separates primary declaration, implementation, extension, and categories', () => {
    const tree = parse(`
      @interface Store
      - (void)run;
      @end
      @implementation Store
      - (void)run {}
      @end
      @interface Store ()
      - (void)run;
      @end
      @implementation Store (Testing)
      - (void)run {}
      @end
    `);
    const methods = [
      ...tree.rootNode.descendantsOfType('method_declaration'),
      ...tree.rootNode.descendantsOfType('method_definition'),
    ].sort((left, right) => left.startIndex - right.startIndex);
    const identities = methods.map(
      (method) => extractObjectiveCDefinitionMetadata(method, '-run', 'Method').sourceIdentity,
    );

    expect(new Set(identities).size).toBe(4);
    expect(identities.every((identity) => identity?.startsWith('objc:v1:'))).toBe(true);
  });
});
