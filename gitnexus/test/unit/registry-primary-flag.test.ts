/**
 * Unit tests for `registry-primary-flag` (RFC #909 Ring 2 PKG #924).
 *
 * Flag is `REGISTRY_PRIMARY_<UPPER(lang)>`. Each test manipulates
 * `process.env` directly and restores it in `afterEach` — there is no
 * per-process cache to invalidate, so isolation is lexical.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import {
  envVarNameFor,
  isRegistryPrimary,
  primaryLanguages,
} from '../../src/core/ingestion/registry-primary-flag.js';

// ─── Test isolation ─────────────────────────────────────────────────────────
//
// Scrub every `REGISTRY_PRIMARY_*` env var before + after each test so
// parallel vitest runs on the same process don't bleed state.

function clearAllRegistryPrimaryVars(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('REGISTRY_PRIMARY_')) delete process.env[key];
  }
}

beforeEach(clearAllRegistryPrimaryVars);
afterEach(clearAllRegistryPrimaryVars);

// ─── envVarNameFor ─────────────────────────────────────────────────────────

describe('envVarNameFor', () => {
  it('produces upper-cased env-var names from the enum value', () => {
    expect(envVarNameFor(SupportedLanguages.Python)).toBe('REGISTRY_PRIMARY_PYTHON');
    expect(envVarNameFor(SupportedLanguages.TypeScript)).toBe('REGISTRY_PRIMARY_TYPESCRIPT');
    expect(envVarNameFor(SupportedLanguages.JavaScript)).toBe('REGISTRY_PRIMARY_JAVASCRIPT');
  });

  it('uses the enum VALUE, not the key, for languages whose key differs from the value', () => {
    // Key 'CPlusPlus' → value 'cpp' → env var 'REGISTRY_PRIMARY_CPP'.
    // Users see the language by its canonical name, not its TS symbol.
    expect(envVarNameFor(SupportedLanguages.CPlusPlus)).toBe('REGISTRY_PRIMARY_CPP');
    expect(envVarNameFor(SupportedLanguages.CSharp)).toBe('REGISTRY_PRIMARY_CSHARP');
  });

  it('covers every member of SupportedLanguages', () => {
    // Build env-var names for every language and assert no duplicates —
    // catches a future enum-value collision or accidental renaming.
    const names = new Set<string>();
    for (const lang of Object.values(SupportedLanguages)) {
      names.add(envVarNameFor(lang));
    }
    expect(names.size).toBe(Object.values(SupportedLanguages).length);
  });
});

// ─── isRegistryPrimary ─────────────────────────────────────────────────────

describe('isRegistryPrimary', () => {
  it('returns false by default (no env var set)', () => {
    for (const lang of Object.values(SupportedLanguages)) {
      expect(isRegistryPrimary(lang)).toBe(false);
    }
  });

  it("returns true when the env var is 'true' (lowercase)", () => {
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'true';
    expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(true);
  });

  it("returns true when the env var is '1'", () => {
    process.env['REGISTRY_PRIMARY_PYTHON'] = '1';
    expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(true);
  });

  it("returns true when the env var is 'yes'", () => {
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'yes';
    expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(true);
  });

  it('accepts mixed-case and whitespace-padded truthy values', () => {
    process.env['REGISTRY_PRIMARY_PYTHON'] = '  TRUE  ';
    expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(true);
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'Yes';
    expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(true);
  });

  it("returns false for falsy-looking values ('false', '0', empty, 'off')", () => {
    for (const value of ['false', '0', '', 'off', 'no', 'disabled']) {
      process.env['REGISTRY_PRIMARY_PYTHON'] = value;
      expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(false);
    }
  });

  it('returns false for unrecognized tokens (fail-safe on typos)', () => {
    // User meant to type 'true' but fat-fingered — conservative: treat as off.
    for (const value of ['ture', 'tru', 'yeah', 'enable', 'y']) {
      process.env['REGISTRY_PRIMARY_PYTHON'] = value;
      expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(false);
    }
  });

  it('isolates flags per-language (one on does not affect others)', () => {
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'true';
    expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(true);
    expect(isRegistryPrimary(SupportedLanguages.Java)).toBe(false);
    expect(isRegistryPrimary(SupportedLanguages.Go)).toBe(false);
  });

  it('respects a mid-process env-var mutation (no stale cache)', () => {
    expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(false);
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'true';
    expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(true);
    delete process.env['REGISTRY_PRIMARY_PYTHON'];
    expect(isRegistryPrimary(SupportedLanguages.Python)).toBe(false);
  });

  it('handles the CPlusPlus → REGISTRY_PRIMARY_CPP mapping correctly', () => {
    process.env['REGISTRY_PRIMARY_CPP'] = 'true';
    expect(isRegistryPrimary(SupportedLanguages.CPlusPlus)).toBe(true);
    // Negative: the TS-key-style name is NOT read.
    delete process.env['REGISTRY_PRIMARY_CPP'];
    process.env['REGISTRY_PRIMARY_CPLUSPLUS'] = 'true';
    expect(isRegistryPrimary(SupportedLanguages.CPlusPlus)).toBe(false);
  });
});

// ─── primaryLanguages ──────────────────────────────────────────────────────

describe('primaryLanguages', () => {
  it('returns an empty set when no flags are set', () => {
    expect(primaryLanguages().size).toBe(0);
  });

  it('returns exactly the flipped languages', () => {
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'true';
    process.env['REGISTRY_PRIMARY_GO'] = '1';
    process.env['REGISTRY_PRIMARY_JAVA'] = 'false'; // explicitly off
    const enabled = primaryLanguages();
    expect(enabled.has(SupportedLanguages.Python)).toBe(true);
    expect(enabled.has(SupportedLanguages.Go)).toBe(true);
    expect(enabled.has(SupportedLanguages.Java)).toBe(false);
    expect(enabled.size).toBe(2);
  });

  it('returns a plain Set (not a frozen proxy) — consistent shape', () => {
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'true';
    const enabled = primaryLanguages();
    expect(enabled).toBeInstanceOf(Set);
  });
});
