// Scenario-map controls fixture (Phase 1 U17), pair `locale-compare`. The ordering is decided
// inside String.prototype.localeCompare, which Stryker cannot mutate. No locale literal is passed:
// a mutated (empty) locale string would make the call throw instead of fail an assertion.

/** Orders two display labels with the runtime's collation: -1, 0 or 1. */
export function compareLabels(left: string, right: string): number {
  const order = left.localeCompare(right);
  if (order < 0) {
    return -1;
  }
  if (order > 0) {
    return 1;
  }
  return 0;
}
