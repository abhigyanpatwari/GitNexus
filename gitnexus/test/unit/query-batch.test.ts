/**
 * `chunk` at `LBUG_QUERY_BATCH_SIZE` — the shape every query built from a
 * caller-sized array has to take (#2915: one condition per diff hunk overflowed
 * LadybugDB's recursive evaluator copy, a bare SIGBUS with no error output).
 *
 * `chunk` itself lives in `lib/utils.ts`; what is tested here is the batching
 * contract a GRAPH QUERY depends on. The scheduler that consumes those batches,
 * `mapConcurrent`, is generic and has non-query callers, so its tests live
 * beside it in `utils.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { LBUG_QUERY_BATCH_SIZE } from '../../src/core/lbug/query-batch.js';
import { chunk } from '../../src/lib/utils.js';

describe('chunk', () => {
  it('splits into consecutive slices of at most `size`', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns no batches for empty input, so a caller never queries nothing', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('keeps an exact multiple free of a trailing empty batch', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('splits at the shared query batch size', () => {
    expect(
      chunk(
        Array.from({ length: LBUG_QUERY_BATCH_SIZE + 1 }, (_, i) => i),
        LBUG_QUERY_BATCH_SIZE,
      ),
    ).toHaveLength(2);
  });

  it('rejects a size that would loop forever', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it('rejects a non-finite size instead of returning one empty batch', () => {
    // `NaN` fails every comparison, so a bare `size < 1` let it through and
    // `i += NaN` produced exactly one EMPTY slice — the one shape the docstring
    // promises never to return, and one a caller reads as "nothing to query".
    expect(() => chunk([1], Number.NaN)).toThrow(RangeError);
  });

  it('rejects a fractional size, which would DUPLICATE an item rather than fail', () => {
    // The nastier sibling of the NaN case, because it produces a plausible-looking
    // result instead of an empty one. `slice` truncates its indices but `i` does
    // not, so size 1.5 gives slice(0, 1.5) = items 0-1 then slice(1.5, 3) = items
    // 1-2: 'b' is in two batches, and a caller batching a query would send it
    // twice. `Number.isFinite` admits this; only `Number.isInteger` rejects it.
    expect(() => chunk(['a', 'b', 'c'], 1.5)).toThrow(RangeError);
  });
});
