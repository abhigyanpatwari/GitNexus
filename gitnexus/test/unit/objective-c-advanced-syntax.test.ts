import { describe, expect, it } from 'vitest';

import { objectiveCProvider } from '../../src/core/ingestion/languages/objective-c.js';
import { emitObjectiveCScopeCaptures } from '../../src/core/ingestion/languages/objective-c/captures.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';

const SOURCE = `
@class Foo, Bar;
@protocol Forward;
@import Foundation;

typedef void (^Completion)(BOOL ok);

@interface Store (Testing)
@property (class, nonatomic, readonly, getter=currentName) NSString *name;
- (void)exercise;
@end

@interface Store () {
  NSString *_token;
  int count;
}
@property (copy, setter=setCallback:) Completion callback;
@end

@implementation Store (Testing)
- (void)exercise {
  void (^handler)(BOOL) = ^(BOOL ok) {
    NSLog(@"ok");
  };
  handler(YES);
}
@end
`;

const PROPERTY_IMPLEMENTATION_SOURCE = `
@protocol Runnable
@optional
@property (readonly) NSString *optionalName;
- (void)maybeRun;
@required
- (void)mustRun;
@end

@interface Store : NSObject
@property NSString *runtimeValue;
@property NSString *alias;
@end

@implementation Store
@dynamic runtimeValue;
@synthesize alias = _aliasStorage;
@end
`;

function declarationMatches(kind: string) {
  return emitObjectiveCScopeCaptures(SOURCE, 'Sources/Store+Testing.m').filter(
    (match) => match[`@declaration.${kind}`] !== undefined,
  );
}

describe('Objective-C advanced syntax captures', () => {
  it('models categories and class extensions as source-site code elements', () => {
    const categories = declarationMatches('code-element');

    expect(categories.map((match) => match['@declaration.name']?.text)).toEqual(
      expect.arrayContaining(['Store(Testing)', 'Store(<extension>)']),
    );
    expect(
      categories.map((match) => JSON.parse(match['@declaration.annotations']?.text ?? '[]')),
    ).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['objc:category:Testing', 'objc:owner:Store']),
        expect.arrayContaining(['objc:class-extension', 'objc:owner:Store']),
      ]),
    );
    expect(categories.every((match) => match['@declaration.source-identity']?.text)).toBe(true);
  });

  it('captures forward declarations, module imports, ivars, and property metadata', () => {
    expect(declarationMatches('class').map((match) => match['@declaration.name']?.text)).toEqual(
      expect.arrayContaining(['Foo', 'Bar']),
    );
    expect(
      declarationMatches('interface').map((match) => match['@declaration.name']?.text),
    ).toContain('Forward');

    const moduleImport = emitObjectiveCScopeCaptures(SOURCE, 'Sources/Store+Testing.m').find(
      (match) => match['@import.module'] !== undefined,
    );
    expect(moduleImport?.['@import.source']?.text).toBe('Foundation');

    expect(
      declarationMatches('variable').map((match) => [
        match['@declaration.name']?.text,
        match['@declaration.field-type']?.text,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['_token', 'NSString *'],
        ['count', 'int'],
      ]),
    );

    const properties = declarationMatches('property');
    const nameProperty = properties.find((match) => match['@declaration.name']?.text === 'name');
    expect(nameProperty?.['@declaration.is-static']?.text).toBe('true');
    expect(JSON.parse(nameProperty?.['@declaration.annotations']?.text ?? '[]')).toEqual(
      expect.arrayContaining([
        'objc:property:class',
        'objc:property:nonatomic',
        'objc:property:readonly',
        'objc:property:getter=currentName',
      ]),
    );
  });

  it('emits property accessor contracts and position-stable block functions', () => {
    const methods = declarationMatches('method').map((match) => ({
      name: match['@declaration.name']?.text,
      annotations: JSON.parse(match['@declaration.annotations']?.text ?? '[]') as string[],
    }));
    expect(methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '+currentName' }),
        expect.objectContaining({ name: '-callback' }),
        expect.objectContaining({ name: '-setCallback:' }),
      ]),
    );
    expect(
      methods
        .filter((method) =>
          ['+currentName', '-callback', '-setCallback:'].includes(method.name ?? ''),
        )
        .every((method) => method.annotations.includes('objc:site:declaration')),
    ).toBe(true);

    const blocks = declarationMatches('function').filter((match) =>
      match['@declaration.name']?.text.startsWith('block@'),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.['@declaration.parameter-count']?.text).toBe('1');
    expect(blocks[0]?.['@declaration.parameter-types']?.text).toBe('["BOOL"]');
  });

  it('preserves advanced metadata through ParsedFile extraction', () => {
    const parsed = extractParsedFile(objectiveCProvider, SOURCE, 'Sources/Store+Testing.m');
    const category = parsed?.localDefs.find(
      (definition) =>
        definition.type === 'CodeElement' && definition.qualifiedName === 'Store(Testing)',
    );
    const classProperty = parsed?.localDefs.find(
      (definition) => definition.type === 'Property' && definition.qualifiedName === 'name',
    );

    expect(category).toMatchObject({
      annotations: expect.arrayContaining(['objc:category:Testing', 'objc:owner:Store']),
    });
    expect(category?.sourceIdentity).toMatch(/^objc:v1:/);
    expect(classProperty).toMatchObject({ isStatic: true });
  });

  it('preserves protocol requirement and property implementation directives', () => {
    const parsed = extractParsedFile(
      objectiveCProvider,
      PROPERTY_IMPLEMENTATION_SOURCE,
      'Sources/Store.m',
    );
    const methods = parsed?.localDefs.filter((definition) => definition.type === 'Method') ?? [];
    const directiveProperties =
      parsed?.localDefs.filter((definition) =>
        definition.annotations?.some((annotation) =>
          annotation.startsWith('objc:property-implementation:'),
        ),
      ) ?? [];

    expect(methods.find((method) => method.qualifiedName === '-maybeRun')?.annotations).toContain(
      'objc:protocol:optional',
    );
    expect(methods.find((method) => method.qualifiedName === '-mustRun')?.annotations).toContain(
      'objc:protocol:required',
    );
    expect(
      parsed?.localDefs.find(
        (definition) =>
          definition.type === 'Property' && definition.qualifiedName === 'optionalName',
      )?.annotations,
    ).toContain('objc:protocol:optional');
    expect(
      methods.find((method) => method.qualifiedName === '-optionalName')?.annotations,
    ).toContain('objc:protocol:optional');
    expect(directiveProperties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualifiedName: 'runtimeValue',
          annotations: expect.arrayContaining(['objc:property-implementation:dynamic']),
        }),
        expect.objectContaining({
          qualifiedName: 'alias',
          annotations: expect.arrayContaining([
            'objc:property-implementation:synthesize',
            'objc:backing-ivar:_aliasStorage',
          ]),
        }),
      ]),
    );
  });
});
