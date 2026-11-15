// Stryker disable all
// Conformance fixture (gate 2): production code called only from suite hooks.

/** Called only in a suite's `beforeAll`. */
export function loadRecords(): string[] {
  // Stryker restore next-line StringLiteral
  return ['record'];
}

/** Called in a `beforeAll`: the mutant makes the hook throw. */
export function assertOpen(open: boolean): void {
  // Stryker restore next-line BooleanLiteral
  if (!open) throw new Error('hooks: the connection is not open');
}

/** Called in an `afterAll`: the mutant makes the hook throw after the tests passed. */
export function assertClosed(closed: boolean): void {
  // Stryker restore next-line BooleanLiteral
  if (!closed) throw new Error('hooks: the connection is still open');
}
