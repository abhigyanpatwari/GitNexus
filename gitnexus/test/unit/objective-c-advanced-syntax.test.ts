import { describe, expect, it } from 'vitest';

import { objectiveCProvider } from '../../src/core/ingestion/languages/objective-c.js';
import { emitObjectiveCScopeCaptures } from '../../src/core/ingestion/languages/objective-c/captures.js';
import { objectiveCAssumeNonnullRangeContains } from '../../src/core/ingestion/languages/objective-c/declaration-semantics.js';
import { preprocessObjectiveCMacroWrappers } from '../../src/core/ingestion/languages/objective-c/macro-semantics.js';
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

const SELECTOR_SOURCE = `
@interface Store : NSObject
- (void)save:(id)value;
@end
@implementation Store
- (void)configure {
  SEL selector = @selector(save:);
}
@end
`;

const APPLE_DECLARATIONS_SOURCE = `
typedef NS_ENUM(NSInteger, Mode) {
  ModeA,
};
API_AVAILABLE(ios(17.0)) @interface Store : NSObject
@property NSString * _Nullable name;
@end
`;

function declarationMatches(kind: string) {
  return emitObjectiveCScopeCaptures(SOURCE, 'Sources/Store+Testing.m').filter(
    (match) => match[`@declaration.${kind}`] !== undefined,
  );
}

function countedAssumeNonnullRanges(count: number) {
  let reads = 0;
  const backing = Array.from({ length: count }, (_, index) => ({
    start: index * 4,
    end: index * 4 + 2,
  }));
  const ranges = new Proxy(backing, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { ranges, reads: () => reads };
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

  it('records @selector as a source fact without creating a method reference', () => {
    const parsed = extractParsedFile(objectiveCProvider, SELECTOR_SOURCE, 'Sources/Store.m');

    expect(parsed?.localDefs).toContainEqual(
      expect.objectContaining({
        type: 'CodeElement',
        qualifiedName: '@selector(save:)',
        annotations: expect.arrayContaining(['objc:selector-reference', 'objc:selector:save:']),
      }),
    );
    expect(parsed?.referenceSites).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '-save:' })]),
    );
  });

  it.each([
    ['save: completion:', 'save:completion:'],
    ['save: /* gap */ completion:', 'save:completion:'],
    ['save:\n completion:', 'save:completion:'],
    ['foo::', 'foo::'],
    [':bar:', ':bar:'],
  ])('canonicalizes valid selector literal %s', (body, expected) => {
    const source = `@implementation Store\n- (void)run { SEL value = @selector(${body}); }\n@end\n`;
    const selectors = emitObjectiveCScopeCaptures(source, 'Sources/Store.m').filter((match) =>
      JSON.parse(match['@declaration.annotations']?.text ?? '[]').includes(
        'objc:selector-reference',
      ),
    );

    expect(selectors).toHaveLength(1);
    expect(selectors[0]?.['@declaration.name']?.text).toBe(`@selector(${expected})`);
    expect(JSON.parse(selectors[0]?.['@declaration.annotations']?.text ?? '[]')).toContain(
      `objc:selector:${expected}`,
    );
  });

  it.each(['@selector (save:)', '@selector/* wrapper */(save:)', '@selector\n(save:)'])(
    'accepts legal trivia before selector parentheses in %s',
    (literal) => {
      const source = `@implementation Store\n- (void)run { SEL value = ${literal}; }\n@end\n`;
      const selectors = emitObjectiveCScopeCaptures(source, 'Sources/Store.m').filter((match) =>
        JSON.parse(match['@declaration.annotations']?.text ?? '[]').includes(
          'objc:selector-reference',
        ),
      );

      expect(selectors).toHaveLength(1);
      expect(selectors[0]?.['@declaration.name']?.text).toBe('@selector(save:)');
    },
  );

  it.each(['123', 'foo bar', 'foo,bar', 'foo/**/bar', 'foo/*'])(
    'skips malformed selector literal %s',
    (body) => {
      const source = `@implementation Store\n- (void)run { SEL value = @selector(${body}); }\n@end\n`;
      const selectors = emitObjectiveCScopeCaptures(source, 'Sources/Store.m').filter((match) =>
        JSON.parse(match['@declaration.annotations']?.text ?? '[]').includes(
          'objc:selector-reference',
        ),
      );

      expect(selectors).toHaveLength(0);
    },
  );

  it('records Apple macro, availability, and nullability declaration facts', () => {
    const parsed = extractParsedFile(
      objectiveCProvider,
      APPLE_DECLARATIONS_SOURCE,
      'Sources/Store.h',
    );

    expect(parsed?.localDefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualifiedName: 'Mode',
          annotations: expect.arrayContaining(['objc:ns-enum']),
        }),
        expect.objectContaining({
          qualifiedName: 'Store',
          annotations: expect.arrayContaining(['objc:availability:API_AVAILABLE(ios(17.0))']),
        }),
        expect.objectContaining({
          qualifiedName: 'name',
          annotations: expect.arrayContaining(['objc:nullability:_Nullable']),
        }),
      ]),
    );
  });

  it('applies assumed nonnull to declarations and synthesized accessors unless explicit nullability wins', () => {
    const source = [
      '#define NS_ASSUME_NONNULL_BEGIN _Pragma("clang assume_nonnull begin")',
      '#define NS_ASSUME_NONNULL_END _Pragma("clang assume_nonnull end")',
      'NS_ASSUME_NONNULL_BEGIN',
      '@interface AssumedStore : NSObject',
      '@property NSString *title;',
      '@property NSString * _Nullable nickname;',
      '- (NSString *)lookup:(NSString *)key;',
      '- (NSString * _Nullable)optionalLookup;',
      '@end',
      'NS_ASSUME_NONNULL_END',
      '@interface OutsideStore : NSObject',
      '@property NSString *outside;',
      '@end',
      '',
    ].join('\n');
    const parsed = extractParsedFile(objectiveCProvider, source, 'Sources/AssumedStore.h');
    const annotationsFor = (name: string): readonly string[] =>
      parsed?.localDefs.find((definition) => definition.qualifiedName === name)?.annotations ?? [];

    for (const name of ['title', '-title', '-setTitle:', '-lookup:']) {
      expect(annotationsFor(name), name).toContain('objc:nullability:assumed-nonnull');
    }
    for (const name of ['nickname', '-nickname', '-setNickname:', '-optionalLookup']) {
      expect(annotationsFor(name), name).toContain('objc:nullability:_Nullable');
      expect(annotationsFor(name), name).not.toContain('objc:nullability:assumed-nonnull');
    }
    expect(annotationsFor('outside')).not.toContain('objc:nullability:assumed-nonnull');
  });

  it('canonicalizes contextual nullability and lets it override assumed nonnull', () => {
    const source = [
      'NS_ASSUME_NONNULL_BEGIN',
      '@interface ContextualStore : NSObject',
      '- (nullable NSString *)lookup:(nonnull NSString *)key fallback:(null_unspecified id)value;',
      '@property (nullable) NSString *nickname;',
      '@property (null_resettable) NSString *token;',
      '@end',
      'NS_ASSUME_NONNULL_END',
      '',
    ].join('\n');
    const parsed = extractParsedFile(objectiveCProvider, source, 'Sources/ContextualStore.h');
    const annotationsFor = (name: string): readonly string[] =>
      parsed?.localDefs.find((definition) => definition.qualifiedName === name)?.annotations ?? [];

    expect(annotationsFor('-lookup:fallback:')).toEqual(
      expect.arrayContaining([
        'objc:nullability:_Nullable',
        'objc:nullability:_Nonnull',
        'objc:nullability:_Null_unspecified',
      ]),
    );
    expect(annotationsFor('-lookup:fallback:')).not.toContain('objc:nullability:assumed-nonnull');
    for (const name of ['nickname', '-nickname', '-setNickname:']) {
      expect(annotationsFor(name), name).toContain('objc:nullability:_Nullable');
      expect(annotationsFor(name), name).not.toContain('objc:nullability:assumed-nonnull');
    }
    for (const name of ['token', '-token', '-setToken:']) {
      expect(annotationsFor(name), name).toContain('objc:nullability:null_resettable');
      expect(annotationsFor(name), name).not.toContain('objc:nullability:assumed-nonnull');
    }
  });

  it('keeps assumed-nonnull containment work logarithmic when the range count doubles', () => {
    const readsByRangeCount = [2_048, 4_096].map((rangeCount) => {
      const counted = countedAssumeNonnullRanges(rangeCount);
      const lastRangeStart = (rangeCount - 1) * 4;

      expect(
        objectiveCAssumeNonnullRangeContains(counted.ranges, lastRangeStart, lastRangeStart + 2),
      ).toBe(true);
      return counted.reads();
    });

    expect(readsByRangeCount[1]).toBeLessThanOrEqual((readsByRangeCount[0] ?? 0) + 2);
    expect(readsByRangeCount[1]).toBeLessThan(32);
  });

  it('supports nested assumed-nonnull regions and rejects a malformed marker sequence conservatively', () => {
    const balancedSource = [
      'NS_ASSUME_NONNULL_BEGIN',
      '@interface NestedStore : NSObject',
      '@property NSString *outer;',
      'NS_ASSUME_NONNULL_BEGIN',
      '@property NSString *inner;',
      'NS_ASSUME_NONNULL_END',
      '@property NSString *after;',
      '@end',
      'NS_ASSUME_NONNULL_END',
      '',
    ].join('\n');
    const malformedSource = [
      'NS_ASSUME_NONNULL_BEGIN',
      '@interface MalformedStore : NSObject',
      '@property NSString *value;',
      '@end',
      'NS_ASSUME_NONNULL_END',
      'NS_ASSUME_NONNULL_END',
      '',
    ].join('\n');
    const unclosedSource = [
      'NS_ASSUME_NONNULL_BEGIN',
      '@interface UnclosedStore : NSObject',
      '@property NSString *value;',
      '@end',
      '',
    ].join('\n');
    const balanced = extractParsedFile(objectiveCProvider, balancedSource, 'Sources/NestedStore.h');
    const malformed = extractParsedFile(
      objectiveCProvider,
      malformedSource,
      'Sources/MalformedStore.h',
    );
    const unclosed = extractParsedFile(
      objectiveCProvider,
      unclosedSource,
      'Sources/UnclosedStore.h',
    );

    for (const name of ['outer', 'inner', 'after']) {
      expect(
        balanced?.localDefs.find((definition) => definition.qualifiedName === name)?.annotations ??
          [],
        name,
      ).toContain('objc:nullability:assumed-nonnull');
    }
    expect(
      malformed?.localDefs.find((definition) => definition.qualifiedName === 'value')
        ?.annotations ?? [],
    ).not.toContain('objc:nullability:assumed-nonnull');
    expect(
      unclosed?.localDefs.find((definition) => definition.qualifiedName === 'value')?.annotations ??
        [],
    ).not.toContain('objc:nullability:assumed-nonnull');
  });

  it('does not treat copied internal sentinel comments as assumed-nonnull markers', () => {
    const generated = preprocessObjectiveCMacroWrappers(
      [
        'NS_ASSUME_NONNULL_BEGIN',
        '@interface GeneratedStore : NSObject',
        '@property NSString *generated;',
        '@end',
        'NS_ASSUME_NONNULL_END',
        '',
      ].join('\n'),
      'Sources/GeneratedStore.h',
    );
    const sentinels = generated.match(/\/\*GN\$A[^*]*\*\//g) ?? [];
    const forged = [
      '// copied internal markers must not establish provenance',
      sentinels[0] ?? '',
      '@interface ForgedStore : NSObject',
      '@property NSString *value;',
      '@end',
      sentinels[1] ?? '',
      '',
    ].join('\n');
    const parsed = extractParsedFile(objectiveCProvider, forged, 'Sources/ForgedStore.h');
    const annotations =
      parsed?.localDefs.find((definition) => definition.qualifiedName === 'value')?.annotations ??
      [];

    expect(sentinels).toHaveLength(2);
    expect(annotations).not.toContain('objc:nullability:assumed-nonnull');
  });
});
