// Scenario-map controls fixture (Phase 1 U17), pair `repo-arithmetic` (design §8 positive control).
// Repo-only arithmetic: every operation is visible to coverage and mutation.

/** Adds two numbers. */
export function add(left: number, right: number): number {
  return left + right;
}
