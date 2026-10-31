// Scenario-map controls fixture (Phase 1 U17), pair `date-boundary`. Day 0 of the next month rolls
// back to the last day of this one inside Date, so the leap-year rule is Date's, not this module's.

/** Days in a month (0-based, as Date counts months) of a year, in UTC. */
export function daysInMonth(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  return lastDay.getUTCDate();
}
