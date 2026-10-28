// Scenario-map controls fixture (Phase 1 U17), pair `regex-alternatives`. Stryker's regex mutator
// (weapon-regex, level 1) has no operator that drops one alternative of an alternation.

/** True when a method name reads as an accessor: `get` or `set` followed by a capital letter. */
export function isAccessorName(name: string): boolean {
  return /^(?:get|set)[A-Z]/.test(name);
}
