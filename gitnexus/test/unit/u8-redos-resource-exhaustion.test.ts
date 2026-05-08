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

/**
 * Time a single regex.exec call. Used by the linearity tests below to
 * compute a 10k/5k ratio in addition to the absolute <500ms bound.
 *
 * Ratio assertions catch sub-exponential O(n²) regressions that fit
 * inside the absolute cap on warm CI; the absolute cap catches
 * catastrophic backtracking on cold CI. Two complementary signals.
 */
function timeRegex(re: RegExp, input: string): number {
  // Reset regex.lastIndex for global/sticky regexes — ours are not, but
  // be defensive in case future shape changes add the `g` flag.
  re.lastIndex = 0;
  const start = performance.now();
  re.exec(input);
  return performance.now() - start;
}

function timeFn<T>(fn: () => T): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

// Linear scaling is ~2.0× when input doubles; 3.0× allows generous
// slack for CI-runner GC and tier-up jitter. An O(n²) regression on a
// 2× input takes ~4× as long, well outside this bound.
const LINEAR_RATIO_BOUND = 3.0;

describe('cobol-preprocessor RE_SET_TO_TRUE — linear time on pathological input', () => {
  it('matches in <500ms on 5k repetitions of "A OF A " AND 10k/5k ratio is sub-linear', () => {
    const input5k = 'SET ' + 'A OF A '.repeat(5000) + 'TO TRUE';
    const input10k = 'SET ' + 'A OF A '.repeat(10000) + 'TO TRUE';
    const elapsed5k = timeRegex(RE_SET_TO_TRUE, input5k);
    const elapsed10k = timeRegex(RE_SET_TO_TRUE, input10k);
    // Re-run to confirm matches; the timed runs above already exec'd
    // but we rebuild here to assert correctness without conflating it
    // with the timing measurement.
    expect(RE_SET_TO_TRUE.exec(input5k)).not.toBeNull();
    expect(elapsed5k).toBeLessThan(500);
    expect(elapsed10k).toBeLessThan(500);
    // Ratio check: pre-fix nested-quantifier shape would be exponential
    // here; the post-fix `.+?` shape is linear (~2×).
    expect(elapsed10k / Math.max(elapsed5k, 0.001)).toBeLessThan(LINEAR_RATIO_BOUND);
  });

  it('still matches a normal SET ... TO TRUE statement', () => {
    const m = RE_SET_TO_TRUE.exec('SET WS-FLAG TO TRUE');
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('WS-FLAG');
  });
});

describe('cobol-preprocessor RE_SET_INDEX — linear time on pathological input', () => {
  it('rejects in <500ms on 5k tokens with no valid suffix AND 10k/5k ratio is sub-linear', () => {
    // Forces backtracking against the (TO|UP\s+BY|DOWN\s+BY) alternation
    // — the richer pathological surface of the two regexes.
    const input5k = 'SET ' + 'A '.repeat(5000) + 'X';
    const input10k = 'SET ' + 'A '.repeat(10000) + 'X';
    const elapsed5k = timeRegex(RE_SET_INDEX, input5k);
    const elapsed10k = timeRegex(RE_SET_INDEX, input10k);
    expect(RE_SET_INDEX.exec(input5k)).toBeNull();
    expect(elapsed5k).toBeLessThan(500);
    expect(elapsed10k).toBeLessThan(500);
    expect(elapsed10k / Math.max(elapsed5k, 0.001)).toBeLessThan(LINEAR_RATIO_BOUND);
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
  it('extracts the package name in <500ms on 10k blank lines AND 20k/10k ratio is sub-linear', () => {
    const cargoToml10k =
      '[package]\n' + '\n'.repeat(10000) + 'name = "myrepo"\nversion = "0.1.0"\n';
    const cargoToml20k =
      '[package]\n' + '\n'.repeat(20000) + 'name = "myrepo"\nversion = "0.1.0"\n';
    const elapsed10k = timeFn(() => parseCargoPackageName(cargoToml10k));
    const elapsed20k = timeFn(() => parseCargoPackageName(cargoToml20k));
    expect(parseCargoPackageName(cargoToml10k)).toBe('myrepo');
    expect(elapsed10k).toBeLessThan(500);
    expect(elapsed20k).toBeLessThan(500);
    expect(elapsed20k / Math.max(elapsed10k, 0.001)).toBeLessThan(LINEAR_RATIO_BOUND);
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
