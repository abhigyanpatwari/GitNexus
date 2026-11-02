// Scenario-map controls fixture (Phase 1 U17), pair `verbatim-duplicate`. Repo-only logic, no
// built-in calls.

/** Clamps a percentage to the range 0 to 100. */
export function clampPercent(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}
