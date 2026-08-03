import Parser from 'tree-sitter';
import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.js';
import {
  extractObjectiveCMessageSend,
  extractObjectiveCMethodSignature,
} from '../../src/core/ingestion/languages/objective-c/selector.js';

function parse(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(
    getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
  );
  return parser.parse(source);
}

describe('Objective-C selector normalization', () => {
  it('preserves every selector segment, method kind, arity, and signature type', () => {
    const tree = parse(`
      @interface Store : NSObject
      - (void)save:(id)value completion:(void (^)(BOOL))completion;
      + (instancetype)shared;
      @end
    `);
    const methods = tree.rootNode.descendantsOfType('method_declaration');

    expect(extractObjectiveCMethodSignature(methods[0])).toEqual({
      selector: 'save:completion:',
      signedSelector: '-save:completion:',
      kind: 'instance',
      arity: 2,
      returnType: 'void',
      parameters: [
        { name: 'value', type: 'id' },
        { name: 'completion', type: 'void (^)(BOOL)' },
      ],
    });
    expect(extractObjectiveCMethodSignature(methods[1])).toMatchObject({
      selector: 'shared',
      signedSelector: '+shared',
      kind: 'class',
      arity: 0,
      returnType: 'instancetype',
    });
  });

  it('normalizes message sends using the receiver and enclosing method kind', () => {
    const tree = parse(`
      @implementation Store
      - (void)save:(id)value completion:(id)block {
        [service save:value completion:block];
        [Store shared];
      }
      + (instancetype)factory { return [self shared]; }
      @end
    `);
    const messages = tree.rootNode.descendantsOfType('message_expression');

    expect(extractObjectiveCMessageSend(messages[0])).toEqual({
      selector: 'save:completion:',
      signedSelector: '-save:completion:',
      candidateNames: ['-save:completion:', '+save:completion:'],
      receiver: 'service',
      kind: 'instance',
      arity: 2,
    });
    expect(extractObjectiveCMessageSend(messages[1])).toMatchObject({
      signedSelector: '-shared',
      candidateNames: ['-shared', '+shared'],
      receiver: 'Store',
      kind: 'instance',
      arity: 0,
    });
    expect(extractObjectiveCMessageSend(messages[2])).toMatchObject({
      signedSelector: '+shared',
      candidateNames: ['+shared'],
      receiver: 'self',
      kind: 'class',
      arity: 0,
    });
  });

  it('keeps both dispatch candidates for a receiver whose type is not lexical', () => {
    const tree = parse(`
      @implementation Store
      - (void)run {
        [lowercaseReceiver work];
        [UppercaseReceiver work];
      }
      @end
    `);
    const messages = tree.rootNode.descendantsOfType('message_expression');

    expect(extractObjectiveCMessageSend(messages[0])).toMatchObject({
      selector: 'work',
      candidateNames: ['-work', '+work'],
    });
    expect(extractObjectiveCMessageSend(messages[1])).toMatchObject({
      selector: 'work',
      candidateNames: ['-work', '+work'],
    });
  });
});
