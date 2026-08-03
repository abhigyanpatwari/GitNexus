import { describe, expect, it } from 'vitest';

import { objectiveCProvider } from '../../src/core/ingestion/languages/objective-c.js';
import { emitObjectiveCScopeCaptures } from '../../src/core/ingestion/languages/objective-c/captures.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';

const SOURCE = `
#import "StoreDelegate.h"
@protocol StoreDelegate <NSObject>
- (void)didSave:(id)value;
@end
@interface Store : NSObject <StoreDelegate>
@property (nonatomic, readonly) NSString *name;
+ (instancetype)shared;
- (void)save:(id)value completion:(id)completion;
@end
@implementation Store
- (void)save:(id)value completion:(id)completion {
  [self didSave:value];
}
+ (instancetype)shared { return nil; }
@end
`;

describe('Objective-C scope captures', () => {
  it('emits canonical declarations, receiver bindings, imports, heritage, and calls', () => {
    const captures = emitObjectiveCScopeCaptures(SOURCE, 'Sources/Store.m');

    expect(
      captures
        .filter((match) => match['@declaration.method'] !== undefined)
        .map((match) => match['@declaration.name']?.text),
    ).toEqual([
      '-didSave:',
      '-name',
      '+shared',
      '-save:completion:',
      '-save:completion:',
      '+shared',
    ]);
    expect(
      captures
        .filter((match) => match['@reference.call.member'] !== undefined)
        .map((match) => ({
          name: match['@reference.name']?.text,
          receiver: match['@reference.receiver']?.text,
          arity: match['@reference.arity']?.text,
        })),
    ).toEqual([{ name: '-didSave:', receiver: 'self', arity: '1' }]);
    expect(
      captures
        .filter((match) => match['@reference.inherits'] !== undefined)
        .map((match) => match['@reference.name']?.text),
    ).toEqual(expect.arrayContaining(['NSObject', 'StoreDelegate']));
    expect(
      captures.find((match) => match['@import.statement'] !== undefined)?.['@import.source']
        ?.text,
    ).toBe('StoreDelegate.h');
    expect(
      captures.some(
        (match) =>
          match['@type-binding.self'] !== undefined &&
          match['@type-binding.name']?.text === 'self' &&
          match['@type-binding.type']?.text === 'Store',
      ),
    ).toBe(true);
  });

  it('feeds the shared scope extractor without losing Objective-C semantics', () => {
    const parsed = extractParsedFile(objectiveCProvider, SOURCE, 'Sources/Store.m');

    expect(parsed?.localDefs.map((definition) => [definition.type, definition.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['Class', 'Store'],
        ['Interface', 'StoreDelegate'],
        ['Property', 'name'],
        ['Method', '-save:completion:'],
        ['Method', '+shared'],
      ]),
    );
    expect(parsed?.referenceSites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'call',
          name: '-didSave:',
          explicitReceiver: { name: 'self' },
          arity: 1,
        }),
      ]),
    );
    expect(parsed?.parsedImports).toContainEqual({
      kind: 'wildcard',
      targetRaw: 'StoreDelegate.h',
    });
    expect(
      parsed?.scopes.some(
        (scope) => scope.kind === 'Function' && scope.typeBindings.get('self')?.rawName === 'Store',
      ),
    ).toBe(true);
  });
});
