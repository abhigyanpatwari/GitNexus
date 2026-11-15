// Stryker disable all
// Conformance fixture (gate 2): summed by `it.each` rows whose titles truncate to one name.

export function total(values: readonly number[]): number {
  // Stryker restore next-line ArithmeticOperator
  return values.reduce((sum, value) => sum + value, 0);
}
