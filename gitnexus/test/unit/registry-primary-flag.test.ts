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
  MIGRATED_LANGUAGES,
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
  it('returns MIGRATED_LANGUAGES membership by default (no env var set)', () => {
    // Ring 3: languages in MIGRATED_LANGUAGES are registry-primary by
    // default — operators don't need to set an env var for the rolled-out
    // migration to take effect. Unmigrated languages default to false.
    for (const lang of Object.values(SupportedLanguages)) {
      expect(isRegistryPrimary(lang)).toBe(MIGRATED_LANGUAGES.has(lang));
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
    // Java and Go are not in MIGRATED_LANGUAGES — default false stays
    // false regardless of Python's flag.
    expect(isRegistryPrimary(SupportedLanguages.Java)).toBe(false);
    expect(isRegistryPrimary(SupportedLanguages.Go)).toBe(false);
  });

  it('respects a mid-process env-var mutation (no stale cache)', () => {
    // Use Java — not in MIGRATED_LANGUAGES — so the unset default is
    // deterministically `false`, independent of which languages have
    // been flipped to registry-primary.
    expect(isRegistryPrimary(SupportedLanguages.Java)).toBe(false);
    process.env['REGISTRY_PRIMARY_JAVA'] = 'true';
    expect(isRegistryPrimary(SupportedLanguages.Java)).toBe(true);
    delete process.env['REGISTRY_PRIMARY_JAVA'];
    expect(isRegistryPrimary(SupportedLanguages.Java)).toBe(false);
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
  it('returns MIGRATED_LANGUAGES when no flags are set', () => {
    // Default-on for migrated languages (Ring 3); unmigrated stay off.
    const enabled = primaryLanguages();
    expect(enabled.size).toBe(MIGRATED_LANGUAGES.size);
    for (const lang of MIGRATED_LANGUAGES) {
      expect(enabled.has(lang)).toBe(true);
    }
  });

  it('returns exactly the flipped languages (env opts in unmigrated, opts out migrated)', () => {
    // Migrated languages are default-on; each must be opted out here when
    // testing explicit env overrides. Go (unmigrated) opts in; Java stays off.
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'false';
    process.env['REGISTRY_PRIMARY_CSHARP'] = 'false';
    process.env['REGISTRY_PRIMARY_TYPESCRIPT'] = 'false';
    process.env['REGISTRY_PRIMARY_GO'] = '1';
    const enabled = primaryLanguages();
    expect(enabled.has(SupportedLanguages.Python)).toBe(false);
    expect(enabled.has(SupportedLanguages.CSharp)).toBe(false);
    expect(enabled.has(SupportedLanguages.Go)).toBe(true);
    expect(enabled.has(SupportedLanguages.Java)).toBe(false);
    // Only Go is on: migrated defaults overridden off, Go explicitly on.
    expect(enabled.size).toBe(1);
  });

  it('returns a plain Set (not a frozen proxy) — consistent shape', () => {
    process.env['REGISTRY_PRIMARY_PYTHON'] = 'true';
    const enabled = primaryLanguages();
    expect(enabled).toBeInstanceOf(Set);
  });
});
