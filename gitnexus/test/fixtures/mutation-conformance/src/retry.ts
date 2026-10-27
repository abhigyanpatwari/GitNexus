// Stryker disable all
// Conformance fixture (gate 2), retry scope: a test with `retry: 1` makes every run that selects
// it inconclusive, static runs (which select every test) included.

export function retryDelay(attempt: number): number {
  // Stryker restore next-line ArithmeticOperator
  return attempt * 10;
}

// Stryker restore next-line StringLiteral
export const RETRY_POLICY = 'linear';
