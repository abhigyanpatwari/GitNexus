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

/**
 * Minimum elapsed time (in ms) below which `performance.now()` ratios
 * are dominated by scheduler jitter and become meaningless. When both
 * timed runs come in below this floor, we skip the ratio assertion —
 * the absolute <500ms bound still catches catastrophic backtracking,
 * and the next CI run will measure higher absolute times that the
 * ratio assertion can evaluate reliably.
 *
 * Calibrated empirically: a flake on macOS reported ratio 5.29×
 * between two sub-millisecond measurements (~0.5ms vs ~2.6ms), both
 * genuinely linear but indistinguishable from noise. 5ms is a
 * comfortable floor where individual measurements are well-separated
 * from the ~10-100µs `performance.now()` resolution band.
 */
const RATIO_MEASUREMENT_FLOOR_MS = 5;

/**
 * Assert linear scaling between two timed runs on inputs that differ
 * by 2×. When measurements are too small to be reliable, the ratio
 * assertion is skipped (the absolute bound still fires elsewhere).
 */
function assertSubLinearRatio(elapsedSmall: number, elapsedLarge: number, label: string): void {
  if (elapsedSmall < RATIO_MEASUREMENT_FLOOR_MS && elapsedLarge < RATIO_MEASUREMENT_FLOOR_MS) {
    // Both runs completed faster than the noise floor — the ratio is
    // not meaningful. The absolute <500ms bound elsewhere in this
    // describe block still pins linearity; we skip rather than risk a
    // flake on a genuinely-linear implementation.
    return;
  }
  const ratio = elapsedLarge / Math.max(elapsedSmall, 0.001);
  if (ratio >= LINEAR_RATIO_BOUND) {
    throw new Error(
      `${label}: ratio ${ratio.toFixed(2)}× exceeds bound ${LINEAR_RATIO_BOUND}× ` +
        `(small=${elapsedSmall.toFixed(2)}ms, large=${elapsedLarge.toFixed(2)}ms)`,
    );
  }
}

describe('cobol-preprocessor RE_SET_TO_TRUE — linear time on pathological input', () => {
  it('matches in <500ms on 50k repetitions of "A OF A " AND 100k/50k ratio is sub-linear when measurable', () => {
    // 50k/100k repetitions chosen so timings exceed the
    // RATIO_MEASUREMENT_FLOOR_MS noise floor on typical CI hardware.
    // Pre-fix nested-quantifier shape would be exponential here; the
    // post-fix `.+?` shape is linear (~2× when input doubles).
    const inputSmall = 'SET ' + 'A OF A '.repeat(50_000) + 'TO TRUE';
    const inputLarge = 'SET ' + 'A OF A '.repeat(100_000) + 'TO TRUE';
    const elapsedSmall = timeRegex(RE_SET_TO_TRUE, inputSmall);
    const elapsedLarge = timeRegex(RE_SET_TO_TRUE, inputLarge);
    expect(RE_SET_TO_TRUE.exec(inputSmall)).not.toBeNull();
    expect(elapsedSmall).toBeLessThan(500);
    expect(elapsedLarge).toBeLessThan(500);
    assertSubLinearRatio(elapsedSmall, elapsedLarge, 'RE_SET_TO_TRUE');
  });

  it('still matches a normal SET ... TO TRUE statement', () => {
    const m = RE_SET_TO_TRUE.exec('SET WS-FLAG TO TRUE');
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('WS-FLAG');
  });
});

describe('cobol-preprocessor RE_SET_INDEX — linear time on pathological input', () => {
  it('rejects in <500ms on 50k tokens with no valid suffix AND 100k/50k ratio is sub-linear when measurable', () => {
    // Forces backtracking against the (TO|UP\s+BY|DOWN\s+BY) alternation
    // — the richer pathological surface of the two regexes.
    const inputSmall = 'SET ' + 'A '.repeat(50_000) + 'X';
    const inputLarge = 'SET ' + 'A '.repeat(100_000) + 'X';
    const elapsedSmall = timeRegex(RE_SET_INDEX, inputSmall);
    const elapsedLarge = timeRegex(RE_SET_INDEX, inputLarge);
    expect(RE_SET_INDEX.exec(inputSmall)).toBeNull();
    expect(elapsedSmall).toBeLessThan(500);
    expect(elapsedLarge).toBeLessThan(500);
    assertSubLinearRatio(elapsedSmall, elapsedLarge, 'RE_SET_INDEX');
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
  it('extracts the package name in <500ms on 100k blank lines AND 200k/100k ratio is sub-linear when measurable', () => {
    // 100k/200k blank lines chosen so timings exceed the
    // RATIO_MEASUREMENT_FLOOR_MS noise floor. Earlier 10k/20k pairing
    // produced sub-millisecond measurements where scheduler jitter
    // dominated and the ratio became meaningless (a real macOS run
    // saw 5.29× between two genuinely-linear sub-ms measurements).
    const cargoTomlSmall =
      '[package]\n' + '\n'.repeat(100_000) + 'name = "myrepo"\nversion = "0.1.0"\n';
    const cargoTomlLarge =
      '[package]\n' + '\n'.repeat(200_000) + 'name = "myrepo"\nversion = "0.1.0"\n';
    const elapsedSmall = timeFn(() => parseCargoPackageName(cargoTomlSmall));
    const elapsedLarge = timeFn(() => parseCargoPackageName(cargoTomlLarge));
    expect(parseCargoPackageName(cargoTomlSmall)).toBe('myrepo');
    expect(elapsedSmall).toBeLessThan(500);
    expect(elapsedLarge).toBeLessThan(500);
    assertSubLinearRatio(elapsedSmall, elapsedLarge, 'parseCargoPackageName');
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
