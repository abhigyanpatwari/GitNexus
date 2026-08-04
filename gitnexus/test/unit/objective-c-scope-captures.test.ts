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
      captures.find((match) => match['@import.statement'] !== undefined)?.['@import.source']?.text,
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

    expect(
      parsed?.localDefs.map((definition) => [definition.type, definition.qualifiedName]),
    ).toEqual(
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

  it('keeps ordinary receiver selectors unsigned until receiver resolution', () => {
    const captures = emitObjectiveCScopeCaptures(
      [
        '@interface Worker : NSObject',
        '- (void)work;',
        '@end',
        'void run(Worker *worker) {',
        '  [worker work];',
        '}',
      ].join('\n'),
      'Sources/Worker.m',
    );
    const call = captures.find((match) => match['@reference.call.member'] !== undefined);

    expect(call?.['@reference.name']?.text).toBe('work');
    expect(JSON.parse(call?.['@reference.candidate-names']?.text ?? '[]')).toEqual([
      '-work',
      '+work',
    ]);
  });

  it('does not treat lightweight generic parameters as adopted protocols', () => {
    const captures = emitObjectiveCScopeCaptures(
      `
      @protocol ObjectType
      @end
      @protocol Trackable
      @end
      @interface VariantRoot<__covariant ObjectType>
      @end
      @interface Box<__covariant ObjectType> : NSObject <Trackable>
      @end
      @interface InvariantBox<ObjectType> : NSObject <Trackable>
      @end
      `,
      'Sources/Box.h',
    );

    expect(
      captures
        .filter((match) => match['@reference.inherits'] !== undefined)
        .map((match) => match['@reference.name']?.text),
    ).toEqual(['NSObject', 'Trackable', 'NSObject', 'Trackable']);
  });

  it('captures protocols adopted with no superclass, after a superclass, and by a category', () => {
    const captures = emitObjectiveCScopeCaptures(
      [
        '@protocol Trackable',
        '@end',
        '@interface Root <Trackable>',
        '@end',
        '@interface Store : NSObject <Trackable>',
        '@end',
        '@interface Store (Extras) <Trackable>',
        '@end',
      ].join('\n'),
      'Sources/Adoption.h',
    );

    expect(
      captures
        .filter((match) => match['@reference.inherits'] !== undefined)
        .map((match) => match['@reference.name']?.text),
    ).toEqual(['Trackable', 'NSObject', 'Trackable', 'Trackable']);
  });

  it('emits one lexical callable-flow invoke for each shadowed block binding', () => {
    const captures = emitObjectiveCScopeCaptures(
      [
        'void first(void) {',
        '  void (^handler)(void) = ^{ };',
        '  handler();',
        '}',
        'void second(void) {',
        '  void (^handler)(void) = ^{ };',
        '  handler();',
        '}',
      ].join('\n'),
      'Sources/Blocks.m',
    );
    const seeds = captures.filter((match) => match['@callable-flow.seed'] !== undefined);
    const invokes = captures.filter(
      (match) =>
        match['@callable-flow.invoke'] !== undefined &&
        match['@callable-flow.callee']?.text === 'handler',
    );

    expect(seeds).toHaveLength(2);
    expect(new Set(seeds.map((match) => match['@callable-flow.target-name']?.text))).toHaveLength(
      2,
    );
    expect(invokes.map((match) => match['@callable-flow.invoke']?.range.startLine)).toEqual([3, 7]);
  });
});
