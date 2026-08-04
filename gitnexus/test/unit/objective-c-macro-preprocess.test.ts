import Parser from 'tree-sitter';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

import {
  objectiveCMacroAnnotation,
  objectiveCMacroUnderlyingType,
  preprocessObjectiveCMacroWrappers,
} from '../../src/core/ingestion/languages/objective-c/macro-semantics.js';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.js';

function parse(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(
    getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
  );
  return parser.parse(source);
}

function lineBreaks(source: string): Array<readonly [number, '\r' | '\n']> {
  const offsets: Array<readonly [number, '\r' | '\n']> = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\r' || character === '\n') offsets.push([index, character]);
  }
  return offsets;
}

describe('Objective-C macro preprocessing', () => {
  it('recovers NS_ENUM without changing offsets or newlines', () => {
    const source = 'typedef NS_ENUM(NSInteger, Mode) {\n  ModeA,\n};\n';
    const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Mode.h');
    const tree = parse(transformed);
    const enumSpecifier = tree.rootNode.descendantsOfType('enum_specifier')[0];

    expect(transformed).toHaveLength(source.length);
    expect([...transformed].filter((character) => character === '\n')).toHaveLength(3);
    expect(tree.rootNode.hasError).toBe(false);
    expect(objectiveCMacroAnnotation(enumSpecifier?.text ?? '')).toBe('objc:ns-enum');
    expect(objectiveCMacroUnderlyingType(enumSpecifier?.text ?? '')).toBe('NSInteger');
    expect(preprocessObjectiveCMacroWrappers(transformed, 'Sources/Mode.h')).toBe(transformed);
  });

  it('recovers declarations wrapped by NS_ASSUME_NONNULL without changing line positions', () => {
    const source = [
      'NS_ASSUME_NONNULL_BEGIN\r',
      '@interface Store : NSObject\r',
      '@property NSString *title;\r',
      '- (NSString *)lookup:(NSString *)key;\r',
      '@end\r',
      'NS_ASSUME_NONNULL_END\r',
      '',
    ].join('\n');
    const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Store.h');
    const tree = parse(transformed);

    expect(transformed).not.toBe(source);
    expect(transformed).toHaveLength(source.length);
    expect(lineBreaks(transformed)).toEqual(lineBreaks(source));
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('class_interface')).toHaveLength(1);
    expect(tree.rootNode.descendantsOfType('property_declaration')).toHaveLength(1);
    expect(tree.rootNode.descendantsOfType('method_declaration')).toHaveLength(1);
    expect(preprocessObjectiveCMacroWrappers(transformed, 'Sources/Store.h')).toBe(transformed);
  });

  it('leaves comments, strings, and malformed macro invocations unchanged', () => {
    const source = [
      '@"NS_ENUM(NSInteger, Mode)"',
      '// typedef NS_ENUM(NSInteger, Commented)',
      '/* typedef NS_OPTIONS(NSUInteger, BlockCommented) */',
      '/* NS_ASSUME_NONNULL_BEGIN */',
      '@"NS_ASSUME_NONNULL_END"',
      'NS_UNKNOWN(',
      '',
    ].join('\n');

    expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Mode.m')).toBe(source);
  });

  it('ends a C block comment at the first closing delimiter', () => {
    const source = '/* outer /* inner */ typedef NS_OPTIONS(NSUInteger, Flags) { FlagA = 1 };\n';
    const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Flags.h');
    const tree = parse(transformed);
    const enumSpecifier = tree.rootNode.descendantsOfType('enum_specifier')[0];

    expect(transformed).not.toBe(source);
    expect(transformed).toHaveLength(source.length);
    expect(tree.rootNode.hasError).toBe(false);
    expect(objectiveCMacroAnnotation(enumSpecifier?.text ?? '')).toBe('objc:ns-options');
    expect(objectiveCMacroUnderlyingType(enumSpecifier?.text ?? '')).toBe('NSUInteger');
  });

  it('does not rewrite macro names declared by preprocessor directives', () => {
    const source = [
      '#define NS_ASSUME_NONNULL_BEGIN _Pragma("clang assume_nonnull begin")',
      '#define NS_ASSUME_NONNULL_END _Pragma("clang assume_nonnull end")',
      '#define WRAPPED_ENUM NS_ENUM',
      '',
    ].join('\n');

    expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Macros.h')).toBe(source);
  });

  it.each([
    [
      'a leading block comment',
      '/* lead */ #define MODE_ENUM typedef NS_ENUM(NSInteger, Mode) { ModeA };',
    ],
    [
      'a leading block comment containing CRLF',
      '/* lead\r\n */ #define MODE_ENUM typedef NS_ENUM(NSInteger, Mode) { ModeA };',
    ],
    [
      'a leading line comment ending in CRLF',
      '// lead\r\n#define MODE_ENUM typedef NS_ENUM(NSInteger, Mode) { ModeA };',
    ],
  ])('treats %s as logical-line-start trivia', (_label, source) => {
    expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Macros.h')).toBe(source);
  });

  it('continues a preprocessor directive when two backslashes precede the newline', () => {
    const source = [
      '#define MODE_ENUM \\\\',
      '  typedef NS_ENUM(NSInteger, Mode) { ModeA };',
      '',
    ].join('\n');

    expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Macros.h')).toBe(source);
  });

  it('preserves UTF-16 offsets when a non-BMP character precedes the macro', () => {
    const source = '// 😀\ntypedef NS_ENUM(NSInteger, Mode) {\n  ModeA,\n};\n';
    const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Mode.h');
    const tree = parse(transformed);

    expect(transformed).toHaveLength(source.length);
    expect(transformed.startsWith('// 😀\n')).toBe(true);
    expect(tree.rootNode.hasError).toBe(false);
    expect(
      tree.rootNode.descendantsOfType('enum_specifier')[0]?.childForFieldName('name')?.text,
    ).toBe('Mode');
    expect(
      objectiveCMacroAnnotation(tree.rootNode.descendantsOfType('enum_specifier')[0]?.text ?? ''),
    ).toBe('objc:ns-enum');
  });

  it('fails open when a non-ASCII character is inside the elided wrapper', () => {
    const source = 'typedef /* 😀 */ NS_ENUM(NSInteger, Mode) { ModeA };\n';

    expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Mode.h')).toBe(source);
  });

  it('keeps scanning bounded when many macro candidates have no closing parenthesis', () => {
    const source = `typedef ${'NS_ENUM('.repeat(98_304)}`;
    const startedAt = performance.now();

    const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Malformed.h');
    const elapsedMs = performance.now() - startedAt;

    expect(transformed).toBe(source);
    expect(elapsedMs).toBeLessThan(300);
  });

  it('scans repeated unterminated block-comment openers with linear growth', () => {
    const elapsed = (openerCount: number): number => {
      const source = '/*x'.repeat(openerCount);
      const startedAt = performance.now();

      expect(objectiveCMacroAnnotation(source)).toBeNull();
      return performance.now() - startedAt;
    };

    elapsed(100);
    const smallMs = Math.min(elapsed(12_000), elapsed(12_000));
    const largeMs = Math.min(elapsed(24_000), elapsed(24_000));

    expect(largeMs).toBeLessThan(smallMs * 3.5 + 5);
  });

  it('retains the options underlying type in a recoverable representation', () => {
    const source = 'typedef NS_OPTIONS(NSUInteger, Flags) { FlagA = 1 };\n';
    const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Flags.h');
    const tree = parse(transformed);
    const enumSpecifier = tree.rootNode.descendantsOfType('enum_specifier')[0];

    expect(transformed).toHaveLength(source.length);
    expect(objectiveCMacroAnnotation(enumSpecifier?.text ?? '')).toBe('objc:ns-options');
    expect(objectiveCMacroUnderlyingType(enumSpecifier?.text ?? '')).toBe('NSUInteger');
    expect(tree.rootNode.hasError).toBe(false);
    expect(
      tree.rootNode.descendantsOfType('enum_specifier')[0]?.childForFieldName('name')?.text,
    ).toBe('Flags');
  });

  it.each([
    ['enum', '/*E*/'],
    ['options', '/*O*/'],
  ])('does not infer NS_%s semantics from ordinary enum comments', (_label, marker) => {
    const ordinaryEnum = `enum Plain ${marker} /*T:NSInteger*/ { PlainA }`;

    expect(objectiveCMacroAnnotation(ordinaryEnum)).toBeNull();
    expect(objectiveCMacroUnderlyingType(ordinaryEnum)).toBeNull();
  });

  it.each([
    ['a string literal', 'enum Plain { PlainA = sizeof("/*GN$E:NSInteger*/") }'],
    ['a trailing comment', 'enum Plain { PlainA } /*GN$O:NSUInteger*/'],
    ['whitespace-spliced marker text', 'enum /* G N $ E : NSInteger */ Plain { PlainA }'],
  ])('does not infer macro semantics from %s', (_label, ordinaryEnum) => {
    expect.soft(objectiveCMacroAnnotation(ordinaryEnum)).toBeNull();
    expect(objectiveCMacroUnderlyingType(ordinaryEnum)).toBeNull();
  });

  it.each([
    [
      'block comments',
      'typedef /* before */ NS_ENUM /* invocation */ (NSInteger, Mode) { ModeA };\n',
      'Mode',
      'NSInteger',
      'objc:ns-enum',
    ],
    [
      'line comments and newlines',
      'typedef // before\r\n NS_OPTIONS\r\n /* invocation */ (NSUInteger, Flags) { FlagA = 1 };\r\n',
      'Flags',
      'NSUInteger',
      'objc:ns-options',
    ],
  ])(
    'recovers macro trivia across %s while preserving every line break',
    (_label, source, name, underlyingType, annotation) => {
      const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Trivia.h');
      const tree = parse(transformed);
      const enumSpecifier = tree.rootNode.descendantsOfType('enum_specifier')[0];

      expect(transformed).not.toBe(source);
      expect(transformed).toHaveLength(source.length);
      expect(lineBreaks(transformed)).toEqual(lineBreaks(source));
      expect(tree.rootNode.hasError).toBe(false);
      expect(enumSpecifier?.childForFieldName('name')?.text).toBe(name);
      expect(objectiveCMacroUnderlyingType(enumSpecifier?.text ?? '')).toBe(underlyingType);
      expect(objectiveCMacroAnnotation(enumSpecifier?.text ?? '')).toBe(annotation);
      expect(preprocessObjectiveCMacroWrappers(transformed, 'Sources/Trivia.h')).toBe(transformed);
    },
  );

  it.each([
    [
      'underlying type',
      'typedef NS_ENUM(unsigned\n long, Mode) { ModeA };\n',
      'Mode',
      'unsigned long',
      'objc:ns-enum',
    ],
    [
      'type name',
      'typedef NS_OPTIONS(NSUInteger,\n Flags) { FlagA = 1 };\n',
      'Flags',
      'NSUInteger',
      'objc:ns-options',
    ],
  ])(
    'recovers a wrapper with a multiline %s',
    (_label, source, name, underlyingType, annotation) => {
      const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Multiline.h');
      const tree = parse(transformed);
      const enumSpecifier = tree.rootNode.descendantsOfType('enum_specifier')[0];

      expect(transformed).not.toBe(source);
      expect(transformed).toHaveLength(source.length);
      expect(lineBreaks(transformed)).toEqual(lineBreaks(source));
      expect(tree.rootNode.hasError).toBe(false);
      expect(enumSpecifier?.childForFieldName('name')?.text).toBe(name);
      expect(objectiveCMacroUnderlyingType(enumSpecifier?.text ?? '')).toBe(underlyingType);
      expect(objectiveCMacroAnnotation(enumSpecifier?.text ?? '')).toBe(annotation);
    },
  );

  it.each(['NS_ENUM', 'NS_OPTIONS'])(
    'fails open for the whole input when a later code-state %s is unterminated',
    (macro) => {
      const source = [
        'typedef NS_ENUM(NSInteger, Mode) { ModeA };',
        `void broken(void) { ${macro}(NSInteger, Broken`,
      ].join('\n');

      expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Broken.h')).toBe(source);
    },
  );

  it.each([
    ['string', 'const char *broken = "unterminated'],
    ['character', "const char broken = 'x"],
  ])(
    'fails open for the whole input when a later %s literal is unterminated',
    (_label, malformedDeclaration) => {
      const source = ['typedef NS_ENUM(NSInteger, Mode) { ModeA };', malformedDeclaration].join(
        '\r\n',
      );

      expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Broken.m')).toBe(source);
    },
  );

  it('fails open for the whole input when the source size cap is exceeded', () => {
    const source = `typedef NS_ENUM(NSInteger, Mode) { ModeA };${' '.repeat(1024 * 1024)}`;

    expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Oversized.h')).toBe(source);
  });

  it('fails open for the whole input when the code-state candidate cap is exceeded', () => {
    const candidates = Array.from(
      { length: 4_097 },
      (_, index) => `NS_ENUM(NSInteger, Candidate${index})`,
    ).join(';');
    const source = `typedef NS_ENUM(NSInteger, Mode) { ModeA };\n${candidates}`;

    expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Generated.h')).toBe(source);
  });

  it('does not count unterminated macro text in comments or strings as fail-open candidates', () => {
    const commentedCandidates = Array.from({ length: 4_097 }, () => '// NS_ENUM(').join('\n');
    const source = [
      'typedef NS_OPTIONS(NSUInteger, Flags) { FlagA = 1 };',
      commentedCandidates,
      '@"NS_OPTIONS("',
    ].join('\n');
    const transformed = preprocessObjectiveCMacroWrappers(source, 'Sources/Comments.m');

    expect(transformed).not.toBe(source);
    expect(objectiveCMacroAnnotation(transformed)).toBe('objc:ns-options');
  });

  it('fails open when every reserved assume-nonnull sentinel slot is occupied', () => {
    const source = [
      '/*GN$A0 occupied*/',
      '/*GN$A1 occupied*/',
      '/*GN$A2 occupied*/',
      '/*GN$A3 occupied*/',
      'NS_ASSUME_NONNULL_BEGIN',
      '@interface Store : NSObject',
      '@end',
      'NS_ASSUME_NONNULL_END',
      '',
    ].join('\n');

    expect(preprocessObjectiveCMacroWrappers(source, 'Sources/Occupied.h')).toBe(source);
  });
});
