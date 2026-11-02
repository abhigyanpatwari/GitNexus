// Stryker disable all
// Conformance fixture (gate 2). Every mutant except the ones restored below is disabled, so each
// planted mutant is one pinned case of expected.json.

// Static: the table is built while the module loads.
// Stryker restore next-line StringLiteral
export const UNITS: Readonly<Record<string, string>> = { ms: 'milliseconds' };

/** Called from a `describe` body, so its mutant is hit while tests are collected. */
export function suiteLabel(): string {
  // Stryker restore next-line StringLiteral
  return 'collected';
}

/** Rows of an `it.each` table: a mutant here changes the collected test set. */
export function rowNames(): string[] {
  return [
    'alpha',
    // Stryker restore next-line StringLiteral
    'beta',
  ];
}
