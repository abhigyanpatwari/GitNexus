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
 * Linearity-test methodology
 * --------------------------
 * Wall-clock perf assertions in CI are notoriously flaky. To make these
 * robust without losing regression-detection power, we combine four
 * techniques:
 *
 *   1. **Warmup** — run the function a few times before timing, so the
 *      JIT has tiered up by the time we measure.
 *   2. **Median of N trials** — single measurements are dominated by
 *      GC pauses, scheduler jitter, and OS interrupts. Median of 5
 *      eliminates almost all of that.
 *   3. **4× input ratio** (not 2×) — linear → ~4×, O(n²) → ~16×,
 *      catastrophic → ≫16×. A wider input ratio gives a much bigger
 *      gap between "linear" and "regressed", so the bound can be loose
 *      enough to absorb noise without losing signal.
 *   4. **Generous bound (8×)** with a noise floor — only assert the
 *      ratio when the *large* measurement is well above the noise
 *      floor. The absolute <500ms cap still catches catastrophic
 *      backtracking on cold CI even when the ratio is skipped.
 *
 * Headroom: linear is expected at ~4×; the bound is 8× → 2× headroom.
 * O(n²) on a 4× input would clock 16×, well outside the bound.
 */
const PERF_WARMUP_RUNS = 3;
const PERF_TRIAL_COUNT = 5;
const SIZE_RATIO = 4;
const LINEAR_RATIO_BOUND = SIZE_RATIO * 2; // 8× — 2× headroom over expected linear
// Median-of-N tightens the noise floor we can rely on. A single-sample 5ms
// measurement is ~50% jitter; median-of-5 brings the same 5ms into the
// reliably-resolvable range above `performance.now()`'s ~10-100µs band.
const RATIO_MEASUREMENT_FLOOR_MS = 5;

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Median time of `PERF_TRIAL_COUNT` runs of `fn`, after `PERF_WARMUP_RUNS`
 * warmup iterations. Trial cost: (warmup + trials) × fn cost.
 */
function medianTimeFn<T>(fn: () => T): number {
  for (let i = 0; i < PERF_WARMUP_RUNS; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < PERF_TRIAL_COUNT; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

/** Median time of regex.exec — defensively resets lastIndex each call. */
function medianTimeRegex(re: RegExp, input: string): number {
  return medianTimeFn(() => {
    re.lastIndex = 0;
    re.exec(input);
  });
}

/**
 * Assert near-linear scaling between two median-timed runs on inputs
 * that differ by `SIZE_RATIO`×. The bound is `LINEAR_RATIO_BOUND` =
 * `SIZE_RATIO * 2`, i.e. 2× headroom over the linear expectation —
 * comfortably under the ~`SIZE_RATIO²` ratio a quadratic regression
 * would produce, so true regressions still fail loudly.
 *
 * Skip semantics: the ratio assertion is skipped only when *both*
 * measurements are below the noise floor. If either run is reliably
 * measurable, we still assert — otherwise an O(n²) regression that
 * happens to stay under the absolute 500ms cap on a fast runner could
 * slip through with no detector firing. Median-of-N + the 5ms floor
 * keeps the assertion stable while preserving regression coverage.
 */
function assertNearLinearScaling(elapsedSmall: number, elapsedLarge: number, label: string): void {
  if (elapsedSmall < RATIO_MEASUREMENT_FLOOR_MS && elapsedLarge < RATIO_MEASUREMENT_FLOOR_MS) {
    // Both runs completed below the noise floor — even the median is
    // dominated by `performance.now()` resolution. The absolute <500ms
    // cap elsewhere still catches catastrophic backtracking.
    return;
  }
  const ratio = elapsedLarge / Math.max(elapsedSmall, 0.001);
  if (ratio >= LINEAR_RATIO_BOUND) {
    throw new Error(
      `${label}: ratio ${ratio.toFixed(2)}× exceeds bound ${LINEAR_RATIO_BOUND}× ` +
        `on ${SIZE_RATIO}× input (small=${elapsedSmall.toFixed(2)}ms, ` +
        `large=${elapsedLarge.toFixed(2)}ms, median of ${PERF_TRIAL_COUNT} trials)`,
    );
  }
}

describe('cobol-preprocessor RE_SET_TO_TRUE — linear time on pathological input', () => {
  it('matches in <500ms on 50k repetitions of "A OF A " AND scales sub-linearly on a 4× input', () => {
    // 50k → 200k (4× input ratio). Pre-fix nested-quantifier shape would
    // be exponential here; the post-fix `.+?` shape is linear (~4× when
    // input quadruples). Median of 5 trials with warmup eliminates GC
    // and tier-up jitter.
    const inputSmall = 'SET ' + 'A OF A '.repeat(50_000) + 'TO TRUE';
    const inputLarge = 'SET ' + 'A OF A '.repeat(50_000 * SIZE_RATIO) + 'TO TRUE';
    const elapsedSmall = medianTimeRegex(RE_SET_TO_TRUE, inputSmall);
    const elapsedLarge = medianTimeRegex(RE_SET_TO_TRUE, inputLarge);
    expect(RE_SET_TO_TRUE.exec(inputSmall)).not.toBeNull();
    expect(elapsedSmall).toBeLessThan(500);
    expect(elapsedLarge).toBeLessThan(500);
    assertNearLinearScaling(elapsedSmall, elapsedLarge, 'RE_SET_TO_TRUE');
  });

  it('still matches a normal SET ... TO TRUE statement', () => {
    const m = RE_SET_TO_TRUE.exec('SET WS-FLAG TO TRUE');
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('WS-FLAG');
  });
});

describe('cobol-preprocessor RE_SET_INDEX — linear time on pathological input', () => {
  it('rejects in <500ms on 50k tokens with no valid suffix AND scales sub-linearly on a 4× input', () => {
    // Forces backtracking against the (TO|UP\s+BY|DOWN\s+BY) alternation
    // — the richer pathological surface of the two regexes.
    const inputSmall = 'SET ' + 'A '.repeat(50_000) + 'X';
    const inputLarge = 'SET ' + 'A '.repeat(50_000 * SIZE_RATIO) + 'X';
    const elapsedSmall = medianTimeRegex(RE_SET_INDEX, inputSmall);
    const elapsedLarge = medianTimeRegex(RE_SET_INDEX, inputLarge);
    expect(RE_SET_INDEX.exec(inputSmall)).toBeNull();
    expect(elapsedSmall).toBeLessThan(500);
    expect(elapsedLarge).toBeLessThan(500);
    assertNearLinearScaling(elapsedSmall, elapsedLarge, 'RE_SET_INDEX');
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
  it('extracts the package name in <500ms on 100k blank lines AND scales sub-linearly on a 4× input', () => {
    // 100k → 400k blank lines (4× input ratio). Median of 5 trials with
    // warmup keeps the ratio stable across CI runners. A previous 2×
    // input + 3× bound + single-trial setup flaked at 3.01× on macOS
    // (small=7.41ms, large=22.31ms) — both above the noise floor but
    // close enough that single-shot jitter pushed the ratio over.
    const cargoTomlSmall =
      '[package]\n' + '\n'.repeat(100_000) + 'name = "myrepo"\nversion = "0.1.0"\n';
    const cargoTomlLarge =
      '[package]\n' + '\n'.repeat(100_000 * SIZE_RATIO) + 'name = "myrepo"\nversion = "0.1.0"\n';
    const elapsedSmall = medianTimeFn(() => parseCargoPackageName(cargoTomlSmall));
    const elapsedLarge = medianTimeFn(() => parseCargoPackageName(cargoTomlLarge));
    expect(parseCargoPackageName(cargoTomlSmall)).toBe('myrepo');
    expect(elapsedSmall).toBeLessThan(500);
    expect(elapsedLarge).toBeLessThan(500);
    assertNearLinearScaling(elapsedSmall, elapsedLarge, 'parseCargoPackageName');
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
