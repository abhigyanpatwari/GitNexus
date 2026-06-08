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

  it('a comma list skips ONLY the named grammars — un-named ones unaffected', async () => {
    // Baseline (no skip) so the isolation check is install-state-robust.
    const base = await freshLoader(undefined);
    const dartBase = base.isLanguageAvailable(SupportedLanguages.Dart);
    const kotlinBase = base.isLanguageAvailable(SupportedLanguages.Kotlin);
    const { isLanguageAvailable } = await freshLoader('swift');
    expect(isLanguageAvailable(SupportedLanguages.Swift)).toBe(false);
    // A prefix/union bug would skip these too — assert they match baseline.
    expect(isLanguageAvailable(SupportedLanguages.Dart)).toBe(dartBase);
    expect(isLanguageAvailable(SupportedLanguages.Kotlin)).toBe(kotlinBase);
  });

  it('accepts the tree-sitter-<lang> package spelling — others unaffected', async () => {
    const base = await freshLoader(undefined);
    const swiftBase = base.isLanguageAvailable(SupportedLanguages.Swift);
    const kotlinBase = base.isLanguageAvailable(SupportedLanguages.Kotlin);
    const { isLanguageAvailable } = await freshLoader('tree-sitter-dart');
    expect(isLanguageAvailable(SupportedLanguages.Dart)).toBe(false);
    expect(isLanguageAvailable(SupportedLanguages.Swift)).toBe(swiftBase);
    expect(isLanguageAvailable(SupportedLanguages.Kotlin)).toBe(kotlinBase);
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

  it('isGrammarRuntimeSkipped reflects the opt-out, never for required grammars', async () => {
    const swiftOnly = await freshLoader('swift');
    expect(swiftOnly.isGrammarRuntimeSkipped(SupportedLanguages.Swift)).toBe(true);
    expect(swiftOnly.isGrammarRuntimeSkipped(SupportedLanguages.Dart)).toBe(false);
    const all = await freshLoader('all');
    expect(all.isGrammarRuntimeSkipped(SupportedLanguages.Swift)).toBe(true);
    // C is not `userSkippable` (required dep via the optional machinery) — even
    // `all` must not mark it runtime-skipped.
    expect(all.isGrammarRuntimeSkipped(SupportedLanguages.C)).toBe(false);
  });

  it('logs an accurate runtime-skip note, not a missing-binding message', async () => {
    // Import the logger AND parser-loader from the SAME fresh module registry so
    // the capture intercepts the loader's logger instance.
    vi.resetModules();
    process.env[ENV] = 'swift';
    const { _captureLogger } = await import('../../src/core/logger.js');
    const { isLanguageAvailable } = await import('../../src/core/tree-sitter/parser-loader.js');
    const cap = _captureLogger();
    try {
      isLanguageAvailable(SupportedLanguages.Swift); // triggers the one-time skip log
      const msgs = cap
        .records()
        .map((r) => (typeof r.msg === 'string' ? r.msg : ''))
        .filter(Boolean);
      const skipMsg = msgs.find((m) => m.includes('GITNEXUS_SKIP_OPTIONAL_GRAMMARS'));
      expect(skipMsg, `captured:\n${msgs.join('\n')}`).toBeTruthy();
      // The opt-out note must NOT borrow the install/platform "missing binding"
      // language — that would tell a deliberate opt-out to reinstall/rebuild.
      expect(skipMsg).not.toMatch(/no prebuilt|failed to load|npm rebuild/i);
    } finally {
      cap.restore();
    }
  });
});
