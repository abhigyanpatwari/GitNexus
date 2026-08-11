import { describe, expect, it } from 'vitest';
import { toOneBasedLine, toZeroBasedLine } from '../../src/core/ingestion/utils/line-base.js';

/**
 * The line-base conversion contract itself.
 *
 * GraphNode `startLine`/`endLine` are 0-based (#2377); the CFG/PDG layer's
 * `BasicBlock` ids and `functionStartLine` are 1-based (`startPosition.row + 1`).
 * `toOneBasedLine` is the named internal inverse used to join graph rows against
 * that layer (`mcp/local/pdg-impact.ts`), so these tests pin the two properties
 * its call sites depend on: it is the exact inverse of `toZeroBasedLine` over
 * real source lines, and — unlike `toZeroBasedLine` — it never clamps, so a
 * caller must establish the operand is a number before calling it.
 */
describe('line-base conversions', () => {
  it('lifts the first 0-based graph line to the first 1-based CFG line', () => {
    expect(toOneBasedLine(0)).toBe(1);
  });

  it.each([1, 2, 3, 7, 42, 1000, Number.MAX_SAFE_INTEGER - 1])(
    'round-trips 1-based line %i through the 0-based graph space',
    (oneBasedLine) => {
      expect(toOneBasedLine(toZeroBasedLine(oneBasedLine))).toBe(oneBasedLine);
    },
  );

  it.each([0, 1, 2, 5, 999])(
    'round-trips 0-based graph line %i through the 1-based CFG space',
    (zeroBasedLine) => {
      expect(toZeroBasedLine(toOneBasedLine(zeroBasedLine))).toBe(zeroBasedLine);
    },
  );

  it('clamps only on the 0-based side: degenerate 1-based inputs floor at 0', () => {
    expect(toZeroBasedLine(0)).toBe(0);
    expect(toZeroBasedLine(-1)).toBe(0);
    expect(toZeroBasedLine(-5)).toBe(0);
  });

  it('does not clamp on the 1-based side: it is plain arithmetic', () => {
    // No undefined/NaN handling either, by design — the PDG join in
    // `pdg-impact.ts` guards with `typeof sym.startLine === 'number'` and keeps
    // its own `Number.NaN` fallback rather than delegating that decision here.
    expect(toOneBasedLine(-1)).toBe(0);
    expect(toOneBasedLine(-5)).toBe(-4);
  });
});
