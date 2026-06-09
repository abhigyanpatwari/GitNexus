import { describe, it, expect } from 'vitest';
// Pure, side-effect-free classifier extracted from the FTS evict→reload bench.
// Importing it must NOT load @ladybugdb/core, build fixtures, or run the bench
// (the module has zero imports and zero module-scope side effects). If this
// import ever pulled in the bench's native-addon require, this test file would
// be slow / fail to load — so the import succeeding cheaply IS the no-side-effect
// guard (R3).
import { classifyVerdict, median, slopeMbPerCycle } from '../../scripts/bench/fts-rss-verdict.mjs';

// Build an exactly-linear series: start, start+slope, start+2·slope, …
const linear = (start: number, slope: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => start + slope * i);

describe('classifyVerdict (FTS evict→reload bench)', () => {
  it('pure helpers behave', () => {
    expect(typeof classifyVerdict).toBe('function');
    expect(median([3, 1, 2])).toBe(2);
    // Least-squares slope of an exact linear series equals its step.
    expect(slopeMbPerCycle(linear(100, 2, 10))).toBeCloseTo(2, 6);
  });

  it('truly flat run → PLATEAU (over-correction guard, R1)', () => {
    // No leak, no warmup: first ≈ second ≈ 0. Must stay PLATEAU, NOT INCONCLUSIVE.
    const series = [200, 200, 201, 200, 200, 201, 200, 200, 200, 201, 200, 200];
    const r = classifyVerdict(series, 190);
    expect(r.verdict).toBe('PLATEAU');
  });

  it('sustained sub-floor positive slope → INCONCLUSIVE (the headline fix, R1)', () => {
    // ~0.4 MB/cycle, sustained (first ≈ second slope), below the absolute floor.
    // The OLD logic labeled this PLATEAU ("no leak"); it must now be INCONCLUSIVE.
    const series = linear(200, 0.4, 20); // peak ~207.6, baseline 190 → small WS → floor stays 0.5
    const r = classifyVerdict(series, 190);
    expect(r.secondHalfSlope).toBeGreaterThan(0.1); // above EPSILON
    expect(r.secondHalfSlope).toBeLessThan(r.floor); // below the floor
    expect(r.decelRatio).toBeGreaterThanOrEqual(0.6); // sustained, not decelerating
    expect(r.verdict).toBe('INCONCLUSIVE');
  });

  it('decelerated-to-flat run → PLATEAU', () => {
    // Climbs then flattens: tail slope ≈ 0 (below EPSILON).
    const series = [200, 210, 218, 224, 228, 230, 231, 231, 231, 231, 231, 231, 231, 231, 231, 231];
    const r = classifyVerdict(series, 190);
    expect(r.verdict).toBe('PLATEAU');
  });

  it('sustained linear above the floor → CLIMB', () => {
    const series = linear(200, 3, 20); // 3 MB/cycle sustained
    const r = classifyVerdict(series, 190);
    expect(r.decelRatio).toBeGreaterThanOrEqual(0.6);
    expect(r.secondHalfSlope).toBeGreaterThanOrEqual(r.floor);
    expect(r.verdict).toBe('CLIMB');
  });

  it('step discontinuity → INCONCLUSIVE (existing guard preserved)', () => {
    const series = [200, 201, 202, 203, 204, 205, 265, 266, 267, 268, 269, 270];
    const r = classifyVerdict(series, 190);
    expect(r.stepDiscontinuity).toBe(true);
    expect(r.verdict).toBe('INCONCLUSIVE');
  });

  it('floor scales with working-set growth, not baseline RSS (R2)', () => {
    // Identical 0.8 MB/cycle sustained tail, two different working sets.
    const series = linear(600, 0.8, 12); // peak ~608.8
    // Small working set (baseline near the series) → low floor → 0.8 clears it → CLIMB.
    const small = classifyVerdict(series, 590); // peak-baseline ~18.8 → floor 0.5
    expect(small.secondHalfSlope).toBeGreaterThanOrEqual(small.floor);
    expect(small.verdict).toBe('CLIMB');
    // Large working set (low baseline) → floor rises with arena size → 0.8 is now
    // sub-floor → the sustained-but-small slope is unresolved, not a clean CLIMB.
    const large = classifyVerdict(series, 0); // peak-baseline ~608 → floor ~1.5
    expect(large.floor).toBeGreaterThan(small.floor);
    expect(large.secondHalfSlope).toBeLessThan(large.floor);
    expect(large.verdict).toBe('INCONCLUSIVE');
  });
});
