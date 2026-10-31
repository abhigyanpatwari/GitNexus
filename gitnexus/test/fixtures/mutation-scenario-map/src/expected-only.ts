// Scenario-map controls fixture (Phase 1 U17), pair `expected-only`. One rendering of a shared tag
// list; the two tests assert different parts of the same output.

/** Renders tags as a comma-separated list of `#`-prefixed names. */
export function formatTags(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(', ');
}
