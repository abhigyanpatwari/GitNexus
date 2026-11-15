import { describe, expect, it } from 'vitest';

const { evaluateScaling } = await import(
  new URL('../../bench/method-declaration-facts/scaling.mjs', import.meta.url).href
);

const sizes = [640, 2560, 10240];
const series = (cost: (size: number) => number) =>
  sizes.map((size) => ({ size, time: cost(size), heap: size * 1000 }));

describe('callable benchmark scaling guard', () => {
  it('accepts linear growth with fixed startup overhead', () => {
    expect(
      evaluateScaling(
        series((n) => 500 + n),
        ['time', 'heap'],
      ).passed,
    ).toBe(true);
  });

  it('rejects quadratic time despite linear memory', () => {
    expect(
      evaluateScaling(
        series((n) => n * n),
        ['time', 'heap'],
      ).passed,
    ).toBe(false);
  });

  it('rejects quadratic memory despite linear time', () => {
    const rows = series((n) => n).map((row) => ({ ...row, heap: row.size ** 2 }));
    expect(evaluateScaling(rows, ['time', 'heap']).passed).toBe(false);
  });

  it('checks the whole size range as well as adjacent sizes', () => {
    // Each 4x step grows cost by 5.28x, but the 16x span grows it by 27.86x.
    expect(
      evaluateScaling(
        series((n) => n ** 1.2),
        ['time'],
      ).passed,
    ).toBe(false);
  });

  it('rejects a regression confined to the largest workload', () => {
    const rows = series((n) => n);
    rows[2].time *= 7;
    expect(evaluateScaling(rows, ['time']).passed).toBe(false);
  });

  it.each([0, -1, NaN, Infinity, undefined])('rejects an invalid reading: %s', (time) => {
    const rows = series((n) => n);
    expect(() => evaluateScaling([{ ...rows[0], time }, ...rows.slice(1)], ['time'])).toThrow();
  });

  it('rejects missing sizes or metrics', () => {
    expect(() => evaluateScaling(series((n) => n).slice(0, 1), ['time'])).toThrow();
    expect(() =>
      evaluateScaling(
        series((n) => n),
        [],
      ),
    ).toThrow();
  });

  it.each([0, -1, NaN, Infinity, 640])('rejects invalid or repeated sizes: %s', (size) => {
    const rows = series((n) => n);
    expect(() => evaluateScaling([rows[0], { ...rows[1], size }, rows[2]], ['time'])).toThrow();
  });
});
