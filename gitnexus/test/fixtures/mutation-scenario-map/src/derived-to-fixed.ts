// Scenario-map controls fixture (Phase 1 U17), pair `derived-to-fixed`. The input is scaled by repo
// arithmetic first, so the value that reaches Number.prototype.toFixed is derived, not the input.

/** Formats a star rating (0 to 5) on a 0 to 50 scale with one decimal. */
export function formatRating(stars: number): string {
  return (stars * 10).toFixed(1);
}
