import { describe, it, expect } from 'vitest';
import { isLanguageAvailable, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe('isLanguageAvailable', () => {
  it('returns true for installed languages', () => {
    expect(isLanguageAvailable(SupportedLanguages.TypeScript)).toBe(true);
    expect(isLanguageAvailable(SupportedLanguages.JavaScript)).toBe(true);
    expect(isLanguageAvailable(SupportedLanguages.Python)).toBe(true);
    expect(isLanguageAvailable(SupportedLanguages.Java)).toBe(true);
    expect(isLanguageAvailable(SupportedLanguages.Go)).toBe(true);
    expect(isLanguageAvailable(SupportedLanguages.Rust)).toBe(true);
    expect(isLanguageAvailable(SupportedLanguages.PHP)).toBe(true);
    expect(isLanguageAvailable(SupportedLanguages.Ruby)).toBe(true);
  });

  it('returns false for fabricated language values', () => {
    expect(isLanguageAvailable('erlang' as SupportedLanguages)).toBe(false);
    expect(isLanguageAvailable('haskell' as SupportedLanguages)).toBe(false);
  });

  it('handles Swift based on optional dependency availability', () => {
    // Swift is optional — result depends on whether tree-sitter-swift is installed
    const result = isLanguageAvailable(SupportedLanguages.Swift);
    expect(typeof result).toBe('boolean');
    // Either way, it should not throw
  });

  it('handles Kotlin based on optional dependency availability', () => {
    // Kotlin is now optional — result depends on whether tree-sitter-kotlin is installed
    const result = isLanguageAvailable(SupportedLanguages.Kotlin);
    expect(typeof result).toBe('boolean');
    // Either way, it should not throw
  });
});

describe('Kotlin optional dependency', () => {
  it('handles Kotlin loading gracefully', async () => {
    // Kotlin is optional — it either loads successfully or throws an error
    try {
      await loadLanguage(SupportedLanguages.Kotlin);
      // If it succeeds, tree-sitter-kotlin is installed
    } catch (e: any) {
      // If it fails, it should be because tree-sitter-kotlin is not installed
      expect(e.message).toContain('Unsupported language');
    }
  });
});
