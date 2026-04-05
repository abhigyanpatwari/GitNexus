/**
 * Regression test for safePushAll — the helper introduced to replace
 * `array.push(...largeArray)` in the pipeline chunk-accumulation loop.
 *
 * The spread operator converts every element into a V8 call-stack argument.
 * At ~65k+ elements a single `push(...arr)` call overflows the stack.
 * This test ensures safePushAll handles that size without crashing and
 * will catch any future reintroduction of the spread pattern.
 */
import { describe, it, expect } from 'vitest';
import { safePushAll } from '../../src/core/ingestion/pipeline.js';

/** Size that reliably triggers the V8 stack overflow with push(...arr). */
const OVERFLOW_SIZE = 200_000;

describe('safePushAll', () => {
  it('appends elements in order for a small array', () => {
    const target = [1, 2, 3];
    safePushAll(target, [4, 5, 6]);
    expect(target).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('handles an empty source array', () => {
    const target = [1];
    safePushAll(target, []);
    expect(target).toEqual([1]);
  });

  it('handles an empty target array', () => {
    const target: number[] = [];
    safePushAll(target, [1, 2]);
    expect(target).toEqual([1, 2]);
  });

  it(`handles ${OVERFLOW_SIZE.toLocaleString()} elements without stack overflow`, () => {
    const source = new Array<number>(OVERFLOW_SIZE);
    for (let i = 0; i < OVERFLOW_SIZE; i++) source[i] = i;

    const target: number[] = [];
    // This must not throw — push(...source) would RangeError here.
    safePushAll(target, source);

    expect(target.length).toBe(OVERFLOW_SIZE);
    // Spot-check order is preserved at boundaries
    expect(target[0]).toBe(0);
    expect(target[OVERFLOW_SIZE - 1]).toBe(OVERFLOW_SIZE - 1);
  });
});
