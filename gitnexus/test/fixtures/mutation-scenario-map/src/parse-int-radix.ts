// Scenario-map controls fixture (Phase 1 U17), pair `parse-int-radix`. The radix is applied inside
// parseInt, which Stryker cannot mutate.

/** Reads a code written in the given radix; text that is not a number reads as -1. */
export function readCode(text: string, radix: number): number {
  const value = parseInt(text, radix);
  if (Number.isNaN(value)) {
    return -1;
  }
  return value;
}
