import { describe, it, expect, afterEach } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { OPTIONAL_GRAMMAR_ENV, isOptionalGrammarRequired } from '../helpers/optional-grammar.js';

/**
 * The required-grammar gate exists so a language whose optional grammar never
 * installs cannot merge with every one of its suites green-by-skip. That only
 * works if the gate actually fires, so these cases pin the two ways it could
 * silently never fire: reading a variable name CI does not set, or accepting a
 * value CI does not write.
 */
describe('optional grammar required-gate', () => {
  // Read once through the registry so a rename of the variable moves every
  // case here with it; the first test is what pins the spelling CI depends on.
  const envVar =
    OPTIONAL_GRAMMAR_ENV[SupportedLanguages.Zig] ?? 'GITNEXUS_REQUIRE_ZIG_UNREGISTERED';
  const original = process.env[envVar];

  afterEach(() => {
    if (original === undefined) delete process.env[envVar];
    else process.env[envVar] = original;
  });

  // A typo here is invisible: the gate would read an unset variable, never
  // require anything, and every CI job would stay green while Zig skipped.
  it('reads the exact variable name the CI jobs export', () => {
    expect(OPTIONAL_GRAMMAR_ENV[SupportedLanguages.Zig]).toBe('GITNEXUS_REQUIRE_ZIG');
  });

  it('requires the grammar only for `1`, the value CI writes', () => {
    process.env[envVar] = '1';
    expect(isOptionalGrammarRequired(SupportedLanguages.Zig)).toBe(true);
  });

  it.each(['0', 'true', 'yes', ''])(
    'does not require the grammar for %o — a local run must still skip',
    (value) => {
      process.env[envVar] = value;
      expect(isOptionalGrammarRequired(SupportedLanguages.Zig)).toBe(false);
    },
  );

  it('does not require the grammar when the variable is unset', () => {
    delete process.env[envVar];
    expect(isOptionalGrammarRequired(SupportedLanguages.Zig)).toBe(false);
  });

  // Languages with no entry must never be gated — an unregistered language
  // reading a stray env var would fail jobs on platforms with no prebuild.
  it('never requires a language that is not registered', () => {
    expect(OPTIONAL_GRAMMAR_ENV[SupportedLanguages.Swift]).toBeUndefined();
    expect(isOptionalGrammarRequired(SupportedLanguages.Swift)).toBe(false);
  });
});
