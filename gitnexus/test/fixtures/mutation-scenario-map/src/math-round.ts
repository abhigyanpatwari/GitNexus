// Scenario-map controls fixture (Phase 1 U17), pair `math-round`. The rounding happens inside
// Math.round, which Stryker cannot mutate, so inputs on either side of the half kill the same
// mutants of this module.

/** Rounds a raw score to whole points; a negative score counts as zero. */
export function roundScore(raw: number): number {
  if (raw < 0) {
    return 0;
  }
  return Math.round(raw);
}
