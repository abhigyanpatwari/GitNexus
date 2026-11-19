import { describe, expect, it } from 'vitest';
import type { Range } from 'gitnexus-shared';
import { javaRangeContains } from '../../src/core/ingestion/languages/java/overload-argument-facts.js';
import {
  firstContaining,
  firstContainingSearch,
} from '../../src/core/ingestion/languages/java/overload-resolution.js';

// Deterministic LCG so every run checks the same ranges; its low bits repeat
// with a short period, so values come from the high bits.
function generator(seed: number): (bound: number) => number {
  let state = seed;
  return (bound) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor((state / 2147483648) * bound);
  };
}

// Few lines and columns, so equal starts, equal ends and nesting all occur.
function ranges(next: (bound: number) => number, count: number): Range[] {
  return Array.from({ length: count }, () => {
    const startLine = 1 + next(6);
    const endLine = startLine + next(4);
    const startCol = next(4);
    const endCol = endLine === startLine ? startCol + next(4) : next(4);
    return { startLine, startCol, endLine, endCol };
  });
}

function byStart(a: Range, b: Range): number {
  return a.startLine - b.startLine || a.startCol - b.startCol;
}

describe('firstContaining', () => {
  it.each([
    { order: 'start-sorted', seed: 7, arrange: (items: Range[]) => items.sort(byStart) },
    { order: 'unsorted', seed: 11, arrange: (items: Range[]) => items },
  ])('finds the first $order item a scan finds', ({ seed, arrange }) => {
    const next = generator(seed);
    for (let round = 0; round < 200; round++) {
      const list = arrange(ranges(next, 1 + next(12)));
      const search = firstContainingSearch(list, (range) => range);
      for (const at of ranges(next, 12))
        expect(firstContaining(search, at)).toBe(
          list.find((range) => javaRangeContains(range, at)),
        );
    }
  });
});
