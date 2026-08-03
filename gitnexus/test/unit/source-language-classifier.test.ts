import { describe, expect, it } from 'vitest';
import * as shared from 'gitnexus-shared';

type Candidate =
  | {
      kind: 'language';
      language: string;
      requiresContentClassification: boolean;
    }
  | { kind: 'unsupported'; reason: 'objective-cpp' };

type Classification = {
  language: string | null;
  confidence: number;
  reason:
    | 'fixed-extension'
    | 'objective-c-syntax'
    | 'xcode-context'
    | 'c-family-header-fallback'
    | 'matlab-syntax'
    | 'ambiguous-m'
    | 'unsupported-objective-cpp';
  classifierVersion: number;
};

const api = shared as unknown as {
  SupportedLanguages: Record<string, string>;
  getLanguageCandidateFromFilename?: (filePath: string) => Candidate | null;
  classifySourceLanguage?: (input: {
    filePath: string;
    content: string;
    projectContext: { hasXcodeProject: boolean };
  }) => Classification;
  getSyntaxLanguageFromFilename?: (filePath: string, language?: string) => string;
};

const classify = (filePath: string, content: string, hasXcodeProject = false): Classification => {
  expect(api.classifySourceLanguage).toBeTypeOf('function');
  return api.classifySourceLanguage!({ filePath, content, projectContext: { hasXcodeProject } });
};

describe('source-language filename candidates', () => {
  it('marks .h/.m as content-sensitive and .mm as explicitly unsupported', () => {
    expect(api.SupportedLanguages.ObjectiveC).toBe('objective-c');
    expect(api.getLanguageCandidateFromFilename).toBeTypeOf('function');
    if (!api.getLanguageCandidateFromFilename) return;

    expect(api.getLanguageCandidateFromFilename('Sources/Store.m')).toEqual({
      kind: 'language',
      language: 'objective-c',
      requiresContentClassification: true,
    });
    expect(api.getLanguageCandidateFromFilename('Sources/Store.h')).toEqual({
      kind: 'language',
      language: 'cpp',
      requiresContentClassification: true,
    });
    expect(api.getLanguageCandidateFromFilename('Sources/Store.mm')).toEqual({
      kind: 'unsupported',
      reason: 'objective-cpp',
    });
    expect(api.getLanguageCandidateFromFilename('Sources/Store.SWIFT')).toEqual({
      kind: 'language',
      language: 'swift',
      requiresContentClassification: false,
    });
    expect(api.getLanguageCandidateFromFilename('resources/view.blade.php')).toBeNull();
  });
});

describe('authoritative source-language classification', () => {
  it('keeps unambiguous extensions deterministic', () => {
    expect(classify('Sources/Store.swift', 'struct Store {}')).toEqual({
      language: 'swift',
      confidence: 1,
      reason: 'fixed-extension',
      classifierVersion: 1,
    });
  });

  it('classifies Objective-C headers from syntax and otherwise preserves the C++ baseline', () => {
    expect(classify('Sources/Store.h', '@interface Store : NSObject\n@end')).toEqual({
      language: 'objective-c',
      confidence: 0.99,
      reason: 'objective-c-syntax',
      classifierVersion: 1,
    });
    expect(
      classify(
        'Sources/Plain.h',
        '// @interface Fake\nconst char *text = "@protocol AlsoFake";\ntypedef struct Item { int id; } Item;',
      ),
    ).toEqual({
      language: 'cpp',
      confidence: 0.8,
      reason: 'c-family-header-fallback',
      classifierVersion: 1,
    });
  });

  it('recognises Objective-C declarations, method signatures, and imports in .m files', () => {
    for (const content of [
      '@implementation Store\n@end',
      '- (void)save:(id)value { }',
      '#import "Store.h"\nvoid run(void) {}',
      '@import Foundation;\nvoid run(void) {}',
    ]) {
      expect(classify('Sources/Store.m', content).language).toBe('objective-c');
      expect(classify('Sources/Store.m', content).reason).toBe('objective-c-syntax');
    }
  });

  it('rejects MATLAB primary and independent secondary signals', () => {
    expect(classify('analysis/model.m', 'function y = model(x)\ny = x;\nend')).toMatchObject({
      language: null,
      confidence: 0.99,
      reason: 'matlab-syntax',
    });
    expect(
      classify('analysis/matrix.m', '% vectorised calculation\nx = [1, 2];\ny = x .* 2;'),
    ).toMatchObject({ language: null, confidence: 0.99, reason: 'matlab-syntax' });
  });

  it('treats postfix single quotes as MATLAB transpose instead of character literals', () => {
    expect(
      classify('analysis/transpose.m', "A = [1, 2]';\nB = A .* 2;\n", true),
    ).toMatchObject({ language: null, confidence: 0.99, reason: 'matlab-syntax' });

    expect(
      classify(
        'analysis/control-transpose.m',
        "A = rand(2)';\nif A(1)\nB = [1 2] .* A;\nend\n",
        true,
      ),
    ).toMatchObject({ language: null, confidence: 0.99, reason: 'matlab-syntax' });
  });

  it('gives Objective-C primary syntax priority over MATLAB secondary signals', () => {
    expect(
      classify('Sources/Store.m', '% generated note\n...\n@interface Store : NSObject\n@end'),
    ).toMatchObject({ language: 'objective-c', reason: 'objective-c-syntax' });
  });

  it('uses Xcode context only for otherwise ambiguous .m files', () => {
    expect(classify('Sources/Values.m', 'value = 1;', true)).toEqual({
      language: 'objective-c',
      confidence: 0.9,
      reason: 'xcode-context',
      classifierVersion: 1,
    });
    expect(classify('Sources/Values.m', 'value = 1;', false)).toEqual({
      language: null,
      confidence: 0.5,
      reason: 'ambiguous-m',
      classifierVersion: 1,
    });
  });

  it('does not treat Objective-C tokens inside comments or strings as evidence', () => {
    expect(
      classify(
        'analysis/notes.m',
        '/* @implementation Fake */\ntext = "@interface AlsoFake";\nvalue = 1;',
      ),
    ).toMatchObject({ language: null, reason: 'ambiguous-m' });
  });

  it('fails closed for Objective-C++', () => {
    expect(classify('Sources/Store.MM', '@implementation Store\n@end')).toEqual({
      language: null,
      confidence: 1,
      reason: 'unsupported-objective-cpp',
      classifierVersion: 1,
    });
  });
});

describe('syntax language for content-sensitive extensions', () => {
  it('requires an explicit language for .h/.m and maps Objective-C to Prism objectivec', () => {
    expect(api.getSyntaxLanguageFromFilename).toBeTypeOf('function');
    if (!api.getSyntaxLanguageFromFilename) return;

    expect(api.getSyntaxLanguageFromFilename('Sources/Store.h')).toBe('text');
    expect(api.getSyntaxLanguageFromFilename('Sources/Store.m')).toBe('text');
    expect(api.getSyntaxLanguageFromFilename('Sources/Store.mm')).toBe('text');
    expect(api.getSyntaxLanguageFromFilename('Sources/Store.h', 'objective-c')).toBe('objectivec');
    expect(api.getSyntaxLanguageFromFilename('Sources/Store.h', 'cpp')).toBe('cpp');
  });
});
