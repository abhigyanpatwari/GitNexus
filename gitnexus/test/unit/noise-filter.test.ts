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
    it('Go has no language-specific noise', () => {
      expect(isBuiltIn('fmt', SupportedLanguages.Go)).toBe(false);
      expect(isBuiltIn('Println', SupportedLanguages.Go)).toBe(false);
    });
  });

  // Java's set exists so `classifyReceiverOrigin` can name the program boundary
  // (#2744): without it no Java drop could ever be judged `external` and every
  // one of them hedged `impact()` to `lower-bound`. It lists TYPE names only —
  // the shape a receiver base actually has — never method names.
  describe('Java platform types (#2744)', () => {
    it('names the java.lang types that appear unqualified as receiver bases', () => {
      expect(isBuiltIn('System', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('String', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('Integer', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('Math', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('Thread', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('StringBuilder', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('RuntimeException', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('Object', SupportedLanguages.Java)).toBe(true);
    });

    it('names the java.util utility holders whose imports never resolve in-workspace', () => {
      expect(isBuiltIn('Optional', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('List', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('Arrays', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('Collections', SupportedLanguages.Java)).toBe(true);
      expect(isBuiltIn('Objects', SupportedLanguages.Java)).toBe(true);
    });

    // The asymmetry that governs the set: an entry here can NEVER be reported
    // as in-program, so every name an application plausibly declares itself
    // stays out. Missing one only costs a hedge.
    it('omits platform names that double as ordinary domain nouns', () => {
      expect(isBuiltIn('Map', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('Set', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('Collection', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('Stream', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('Record', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('Error', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('Number', SupportedLanguages.Java)).toBe(false);
    });

    // The same hook gates `type-env.ts` return-type inference and the #2545
    // free-call shadow guard, both keyed on the CALLEE name. Java method names
    // are camelCase and collide with user code, so none are listed.
    it('lists no method names, so Java callee resolution is untouched', () => {
      expect(isBuiltIn('println', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('format', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('toString', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('run', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('get', SupportedLanguages.Java)).toBe(false);
    });

    it('does not name user-defined types', () => {
      expect(isBuiltIn('UserService', SupportedLanguages.Java)).toBe(false);
      expect(isBuiltIn('OrderRepository', SupportedLanguages.Java)).toBe(false);
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
