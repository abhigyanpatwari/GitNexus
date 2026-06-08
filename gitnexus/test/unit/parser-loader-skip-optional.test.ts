import { describe, it, expect, afterEach, vi } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

/**
 * Runtime opt-out for optional grammars (#2091, #2093).
 *
 * `GITNEXUS_SKIP_OPTIONAL_GRAMMARS` used to be an install-time-only env (the
 * postinstall build scripts read it). `parser-loader` now also honors it at
 * analyze time: when set, genuinely-optional grammars (swift/dart/kotlin)
 * report unavailable so the ingestion pipeline skips their files, mirroring a
 * genuinely-absent binding. Grammars that are required `dependencies` routed
 * through the optional machinery for ABI safety (C — `severity: 'error'`) are
 * NEVER skippable this way.
 *
 * `parser-loader` memoizes load results at module scope, so each case loads a
 * fresh copy via `vi.resetModules()` after setting the env. These assertions
 * are install-state-robust: they only assert the SKIP direction (skip → false)
 * and that required grammars are unaffected (true) — never that an optional
 * grammar is positively available, which depends on the install/platform.
 */

const ENV = 'GITNEXUS_SKIP_OPTIONAL_GRAMMARS';

async function freshLoader(skipValue: string | undefined) {
  vi.resetModules();
  if (skipValue === undefined) delete process.env[ENV];
  else process.env[ENV] = skipValue;
  return import('../../src/core/tree-sitter/parser-loader.js');
}

afterEach(() => {
  delete process.env[ENV];
  vi.resetModules();
});

describe('parser-loader GITNEXUS_SKIP_OPTIONAL_GRAMMARS runtime gate', () => {
  it('skip=1 reports every optional grammar as unavailable', async () => {
    const { isLanguageAvailable } = await freshLoader('1');
    expect(isLanguageAvailable(SupportedLanguages.Swift)).toBe(false);
    expect(isLanguageAvailable(SupportedLanguages.Dart)).toBe(false);
    expect(isLanguageAvailable(SupportedLanguages.Kotlin)).toBe(false);
  });

  it('skip=all/true/* also skip every optional grammar', async () => {
    for (const v of ['all', 'true', '*']) {
      const { isLanguageAvailable } = await freshLoader(v);
      expect(isLanguageAvailable(SupportedLanguages.Swift), `value=${v}`).toBe(false);
      expect(isLanguageAvailable(SupportedLanguages.Dart), `value=${v}`).toBe(false);
      expect(isLanguageAvailable(SupportedLanguages.Kotlin), `value=${v}`).toBe(false);
    }
  });

  it('does NOT skip required grammars — skip=all is a no-op for C / Python', async () => {
    // Compare availability WITH skip=all against the baseline (no skip). The
    // runtime opt-out must never change a required grammar's availability:
    // C is `optional: true` + `severity: 'error'` (a required dep routed
    // through the optional machinery for ABI safety, #1242), and Python is a
    // plain required dep. Asserting EQUALITY (not positive truth) keeps this
    // install-state-robust — C's native binding is intentionally fallible, so
    // a positive assertion could flake on an ABI-mismatched matrix.
    const base = await freshLoader(undefined);
    const cBase = base.isLanguageAvailable(SupportedLanguages.C);
    const pyBase = base.isLanguageAvailable(SupportedLanguages.Python);
    const skipped = await freshLoader('all');
    expect(skipped.isLanguageAvailable(SupportedLanguages.C)).toBe(cBase);
    expect(skipped.isLanguageAvailable(SupportedLanguages.Python)).toBe(pyBase);
  });

  it('a comma list skips only the named grammars (language-id form)', async () => {
    const { isLanguageAvailable } = await freshLoader('swift');
    expect(isLanguageAvailable(SupportedLanguages.Swift)).toBe(false);
  });

  it('accepts the tree-sitter-<lang> package spelling', async () => {
    const { isLanguageAvailable } = await freshLoader('tree-sitter-dart');
    expect(isLanguageAvailable(SupportedLanguages.Dart)).toBe(false);
  });

  it('accepts a multi-entry list', async () => {
    const { isLanguageAvailable } = await freshLoader('kotlin, dart');
    expect(isLanguageAvailable(SupportedLanguages.Kotlin)).toBe(false);
    expect(isLanguageAvailable(SupportedLanguages.Dart)).toBe(false);
  });

  it('getLanguageGrammar throws a clean "Unsupported language" for a skipped optional grammar', async () => {
    const { getLanguageGrammar } = await freshLoader('all');
    expect(() => getLanguageGrammar(SupportedLanguages.Swift)).toThrow(/Unsupported language/);
  });

  it('an empty / unset env does not skip (required grammars load)', async () => {
    const { isLanguageAvailable } = await freshLoader(undefined);
    expect(isLanguageAvailable(SupportedLanguages.Python)).toBe(true);
  });
});
