// Scenario-map controls fixture (Phase 1 U17), pair `object-key-row`. A supported row-deletion
// table (design §5.4): an object literal with plain keys, read through `table[variable]`. Stryker
// never mutates object keys.

const UNIT_FACTORS: Readonly<Record<string, number>> = { ms: 1, s: 1000, min: 60000 };

/** Converts an amount of a time unit to milliseconds; an unknown unit converts to 0. */
export function toMillis(amount: number, unit: string): number {
  const factor = UNIT_FACTORS[unit];
  if (factor === undefined) {
    return 0;
  }
  return amount * factor;
}
