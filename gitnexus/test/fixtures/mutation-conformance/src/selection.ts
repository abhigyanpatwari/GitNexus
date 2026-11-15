// Stryker disable all
// Conformance fixture (gate 2), selection scope: both tests of selection.case.ts cover this code,
// and the scope's testIds select one of them (Phase 1 KTD2).

/** Called in each test. */
export function scale(value: number): number {
  // Stryker restore next-line ArithmeticOperator
  return value * 3;
}

/** Called only in the suite's `beforeAll`. */
export function unit(): string {
  // Stryker restore next-line StringLiteral
  return 'x';
}
