/**
 * Regression tests for U8 — closes:
 *   #186 js/redos             rust-workspace-extractor.ts
 *   #187 js/redos             cobol-preprocessor.ts
 *   #184 js/resource-exhaustion cross-impact.ts
 *
 * These tests import the production symbols directly. A previous shape
 * dynamic-imported names that did not exist (`extractRustWorkspace` vs.
 * the real `extractRustWorkspaceLinks`) and `??`-fell-back to inline
 * regex copies, so the tests stayed green even when the production
 * fixes regressed. Static imports + named symbols make a regression in
 * any of the three sites a hard test failure.
 */
import { describe, expect, it } from 'vitest';
import { RE_SET_TO_TRUE, RE_SET_INDEX } from '../../src/core/ingestion/cobol/cobol-preprocessor.js';
import { parseCargoPackageName } from '../../src/core/group/extractors/rust-workspace-extractor.js';
import {
  clampTimeout,
  IMPACT_TIMEOUT_MIN_MS,
  IMPACT_TIMEOUT_MAX_MS,
} from '../../src/core/group/cross-impact.js';

describe('cobol-preprocessor RE_SET_TO_TRUE — linear time on pathological input', () => {
  it('matches in <500ms on 5k repetitions of "A OF A "', () => {
    const pathological = 'SET ' + 'A OF A '.repeat(5000) + 'TO TRUE';
    const start = performance.now();
    const m = RE_SET_TO_TRUE.exec(pathological);
    const elapsedMs = performance.now() - start;
    expect(m).not.toBeNull();
    expect(elapsedMs).toBeLessThan(500);
  });

  it('still matches a normal SET ... TO TRUE statement', () => {
    const m = RE_SET_TO_TRUE.exec('SET WS-FLAG TO TRUE');
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('WS-FLAG');
  });
});

describe('cobol-preprocessor RE_SET_INDEX — linear time on pathological input', () => {
  it('rejects in <500ms on 5k tokens with no valid suffix', () => {
    // Forces backtracking against the (TO|UP\s+BY|DOWN\s+BY) alternation
    // — the richer pathological surface of the two regexes.
    const pathological = 'SET ' + 'A '.repeat(5000) + 'X';
    const start = performance.now();
    const m = RE_SET_INDEX.exec(pathological);
    const elapsedMs = performance.now() - start;
    expect(m).toBeNull();
    expect(elapsedMs).toBeLessThan(500);
  });

  it('still matches a normal SET INDEX statement', () => {
    const m = RE_SET_INDEX.exec('SET WS-IDX TO 5');
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('WS-IDX');
    expect(m?.[2]).toBe('TO');
    expect(m?.[3]).toBe('5');
  });
});

describe('rust-workspace parseCargoPackageName — linear-time line walk', () => {
  it('extracts the package name in <500ms on 10k blank lines between [package] and name=', () => {
    const cargoToml = '[package]\n' + '\n'.repeat(10000) + 'name = "myrepo"\nversion = "0.1.0"\n';
    const start = performance.now();
    const result = parseCargoPackageName(cargoToml);
    const elapsedMs = performance.now() - start;
    expect(result).toBe('myrepo');
    expect(elapsedMs).toBeLessThan(500);
  });

  it('returns null when [package] section is absent', () => {
    expect(parseCargoPackageName('[workspace]\nmembers = ["a"]\n')).toBeNull();
  });

  it('stops at the next section header (does not pick up a name= from a later section)', () => {
    const toml = '[package]\nversion = "1.0"\n[other]\nname = "wrong"\n';
    expect(parseCargoPackageName(toml)).toBeNull();
  });

  it('extracts the name from a normal [package] section', () => {
    const toml = '[package]\nname = "real-crate"\nversion = "0.1.0"\n';
    expect(parseCargoPackageName(toml)).toBe('real-crate');
  });
});

describe('cross-impact clampTimeout — bounds user-supplied impact timeouts', () => {
  it('rejects negative and zero timeouts, returning MIN', () => {
    expect(clampTimeout(0)).toBe(IMPACT_TIMEOUT_MIN_MS);
    expect(clampTimeout(-1)).toBe(IMPACT_TIMEOUT_MIN_MS);
    expect(clampTimeout(-999_999)).toBe(IMPACT_TIMEOUT_MIN_MS);
  });

  it('rejects NaN/Infinity, returning MIN', () => {
    expect(clampTimeout(NaN)).toBe(IMPACT_TIMEOUT_MIN_MS);
    expect(clampTimeout(Infinity)).toBe(IMPACT_TIMEOUT_MIN_MS);
    expect(clampTimeout(-Infinity)).toBe(IMPACT_TIMEOUT_MIN_MS);
  });

  it('caps very large timeouts at MAX (5 minutes)', () => {
    expect(clampTimeout(999_999_999)).toBe(IMPACT_TIMEOUT_MAX_MS);
    expect(clampTimeout(IMPACT_TIMEOUT_MAX_MS + 1)).toBe(IMPACT_TIMEOUT_MAX_MS);
  });

  it('passes through a reasonable timeout unchanged (truncated to integer)', () => {
    expect(clampTimeout(30_000)).toBe(30_000);
    expect(clampTimeout(30_500.7)).toBe(30_500);
  });

  it('floors below-MIN positive values to MIN', () => {
    expect(clampTimeout(50)).toBe(IMPACT_TIMEOUT_MIN_MS);
    expect(clampTimeout(0.1)).toBe(IMPACT_TIMEOUT_MIN_MS);
  });
});
