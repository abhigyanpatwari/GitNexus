import { describe, it, expect } from 'vitest';
import { isBuiltInOrNoise } from '../../src/core/ingestion/utils/noise-filter.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe('isBuiltInOrNoise (per-language)', () => {
  describe('language-specific filtering', () => {
    it('filters console for JS but not Python', () => {
      expect(isBuiltInOrNoise('console', getProvider(SupportedLanguages.JavaScript))).toBe(true);
      expect(isBuiltInOrNoise('console', getProvider(SupportedLanguages.Python))).toBe(false);
    });

    it('filters println for Kotlin but not Java', () => {
      expect(isBuiltInOrNoise('println', getProvider(SupportedLanguages.Kotlin))).toBe(true);
      expect(isBuiltInOrNoise('println', getProvider(SupportedLanguages.Java))).toBe(false);
    });

    it('filters malloc for C but not JavaScript', () => {
      expect(isBuiltInOrNoise('malloc', getProvider(SupportedLanguages.C))).toBe(true);
      expect(isBuiltInOrNoise('malloc', getProvider(SupportedLanguages.JavaScript))).toBe(false);
    });

    it('filters setState for Dart but not TypeScript', () => {
      expect(isBuiltInOrNoise('setState', getProvider(SupportedLanguages.Dart))).toBe(true);
      expect(isBuiltInOrNoise('setState', getProvider(SupportedLanguages.TypeScript))).toBe(false);
    });

    it('filters unwrap for Rust but not Go', () => {
      expect(isBuiltInOrNoise('unwrap', getProvider(SupportedLanguages.Rust))).toBe(true);
      expect(isBuiltInOrNoise('unwrap', getProvider(SupportedLanguages.Go))).toBe(false);
    });

    it('filters puts for Ruby but not PHP', () => {
      expect(isBuiltInOrNoise('puts', getProvider(SupportedLanguages.Ruby))).toBe(true);
      expect(isBuiltInOrNoise('puts', getProvider(SupportedLanguages.PHP))).toBe(false);
    });

    it('filters echo for PHP but not Python', () => {
      expect(isBuiltInOrNoise('echo', getProvider(SupportedLanguages.PHP))).toBe(true);
      expect(isBuiltInOrNoise('echo', getProvider(SupportedLanguages.Python))).toBe(false);
    });

    it('filters NSLog for Swift but not C', () => {
      expect(isBuiltInOrNoise('NSLog', getProvider(SupportedLanguages.Swift))).toBe(true);
      expect(isBuiltInOrNoise('NSLog', getProvider(SupportedLanguages.C))).toBe(false);
    });

    it('filters ToString for C# but not Rust', () => {
      expect(isBuiltInOrNoise('ToString', getProvider(SupportedLanguages.CSharp))).toBe(true);
      expect(isBuiltInOrNoise('ToString', getProvider(SupportedLanguages.Rust))).toBe(false);
    });
  });

  describe('cross-language pollution eliminated', () => {
    it('close is filtered for C# but not C (POSIX)', () => {
      expect(isBuiltInOrNoise('Close', getProvider(SupportedLanguages.CSharp))).toBe(true);
      expect(isBuiltInOrNoise('close', getProvider(SupportedLanguages.C))).toBe(false);
    });

    it('then/catch are JS-specific, not filtered for Rust', () => {
      expect(isBuiltInOrNoise('then', getProvider(SupportedLanguages.JavaScript))).toBe(true);
      expect(isBuiltInOrNoise('catch', getProvider(SupportedLanguages.JavaScript))).toBe(true);
      expect(isBuiltInOrNoise('then', getProvider(SupportedLanguages.Rust))).toBe(false);
    });

    it('emit is Kotlin-specific, not filtered for Java', () => {
      expect(isBuiltInOrNoise('emit', getProvider(SupportedLanguages.Kotlin))).toBe(true);
      expect(isBuiltInOrNoise('emit', getProvider(SupportedLanguages.Java))).toBe(false);
    });
  });

  describe('languages without builtInNames', () => {
    it('Java has no language-specific noise', () => {
      expect(isBuiltInOrNoise('System', getProvider(SupportedLanguages.Java))).toBe(false);
      expect(isBuiltInOrNoise('println', getProvider(SupportedLanguages.Java))).toBe(false);
    });

    it('Go has no language-specific noise', () => {
      expect(isBuiltInOrNoise('fmt', getProvider(SupportedLanguages.Go))).toBe(false);
      expect(isBuiltInOrNoise('Println', getProvider(SupportedLanguages.Go))).toBe(false);
    });
  });

  describe('domain names not filtered', () => {
    it('does not filter arbitrary names', () => {
      expect(isBuiltInOrNoise('processOrder', getProvider(SupportedLanguages.TypeScript))).toBe(false);
      expect(isBuiltInOrNoise('UserService', getProvider(SupportedLanguages.Java))).toBe(false);
      expect(isBuiltInOrNoise('handle_request', getProvider(SupportedLanguages.Rust))).toBe(false);
    });
  });
});
