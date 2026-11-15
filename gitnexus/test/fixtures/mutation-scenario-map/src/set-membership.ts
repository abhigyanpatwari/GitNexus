// Scenario-map controls fixture (Phase 1 U17), pair `set-membership` (design §8 positive control).
// A supported row-deletion table (design §5.4): `new Set([...])` of literal entries, read through
// `has`. The entries are numbers, which Stryker never mutates one by one, so the only table mutant
// empties the whole Set.

const SUCCESS_STATUSES: ReadonlySet<number> = new Set([200, 204]);

/** True when an HTTP status code is one this client treats as success. */
export function isSuccessStatus(status: number): boolean {
  return SUCCESS_STATUSES.has(status);
}
