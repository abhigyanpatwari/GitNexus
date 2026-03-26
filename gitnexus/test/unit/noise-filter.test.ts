import { describe, it, expect } from 'vitest';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

const isBuiltIn = (name: string, lang: SupportedLanguages) => getProvider(lang).isBuiltInName(name);

describe('isBuiltInOrNoise (per-language)', () => {
  describe('language-specific filtering', () => {
    it('filters console for JS but not Python', () => {
      expect(isBuiltIn('console', SupportedLanguages.JavaScript)).toBe(true);
      expect(isBuiltIn('console', SupportedLanguages.Python)).toBe(false);
    });

    it('filters println for Kotlin but not Java', () => {
      expect(isBuiltIn('println', SupportedLanguages.Kotlin)).toBe(true);
      expect(isBuiltIn('println', SupportedLanguages.Java)).toBe(false);
    });

    it('filters malloc for C but not JavaScript', () => {
      expect(isBuiltIn('malloc', SupportedLanguages.C)).toBe(true);
      expect(isBuiltIn('malloc', SupportedLanguages.JavaScript)).toBe(false);
    });

    it('filters setState for Dart but not TypeScript', () => {
      expect(isBuiltIn('setState', SupportedLanguages.Dart)).toBe(true);
      expect(isBuiltIn('setState', SupportedLanguages.TypeScript)).toBe(false);
    });

    it('filters unwrap for Rust but not Go', () => {
      expect(isBuiltIn('unwrap', SupportedLanguages.Rust)).toBe(true);
      expect(isBuiltIn('unwrap', SupportedLanguages.Go)).toBe(false);
    });

    it('filters puts for Ruby but not PHP', () => {
      expect(isBuiltIn('puts', SupportedLanguages.Ruby)).toBe(true);
      expect(isBuiltIn('puts', SupportedLanguages.PHP)).toBe(false);
    });

    it('filters echo for PHP but not Python', () => {
      expect(isBuiltIn('echo', SupportedLanguages.PHP)).toBe(true);
      expect(isBuiltIn('echo', SupportedLanguages.Python)).toBe(false);
    });

    it('filters NSLog for Swift but not C', () => {
      expect(isBuiltIn('NSLog', SupportedLanguages.Swift)).toBe(true);
      expect(isBuiltIn('NSLog', SupportedLanguages.C)).toBe(false);
    });

    it('filters ToString for C# but not Rust', () => {
      expect(isBuiltIn('ToString', SupportedLanguages.CSharp)).toBe(true);
      expect(isBuiltIn('ToString', SupportedLanguages.Rust)).toBe(false);
    });
  });

  describe('cross-language pollution eliminated', () => {
    it('close is filtered for C# but not C (POSIX)', () => {
      expect(isBuiltIn('Close', SupportedLanguages.CSharp)).toBe(true);
      expect(isBuiltIn('close', SupportedLanguages.C)).toBe(false);
    });

    it('then/catch are JS-specific, not filtered for Rust', () => {
      expect(isBuiltIn('then', SupportedLanguages.JavaScript)).toBe(true);
      expect(isBuiltIn('catch', SupportedLanguages.JavaScript)).toBe(true);
      expect(isBuiltIn('then', SupportedLanguages.Rust)).toBe(false);
    });

    it('emit is Kotlin-specific, not filtered for Java', () => {
      expect(isBuiltIn('emit', SupportedLanguages.Kotlin)).toBe(true);
      expect(isBuiltIn('emit', SupportedLanguages.Java)).toBe(false);
    });
  });

  describe('languages without builtInNames', () => {
    it('Java has no language-specific noise', () => {
      expect(isBuiltIn('System', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('println', SupportedLanguages.Java)).toBe(false);
    });

    it('Go has no language-specific noise', () => {
      expect(isBuiltIn('fmt', SupportedLanguages.Go)).toBe(false);
      expect(isBuiltIn('Println', SupportedLanguages.Go)).toBe(false);
    });
  });

  describe('domain names not filtered', () => {
    it('does not filter arbitrary names', () => {
      expect(isBuiltIn('processOrder', SupportedLanguages.TypeScript)).toBe(false);
      expect(isBuiltIn('UserService', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('handle_request', SupportedLanguages.Rust)).toBe(false);
    });
  });
});
