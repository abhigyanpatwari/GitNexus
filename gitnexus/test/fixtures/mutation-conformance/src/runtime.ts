// Stryker disable all
// Conformance fixture (gate 2): runtime mutants, each hit only while a test runs.

/** Two tests kill its mutant. */
export function double(value: number): number {
  // Stryker restore next-line ArithmeticOperator
  return value * 2;
}

/** The mutant drops the optional chain, so a null argument throws a TypeError. */
export function firstChar(text: string | null): string {
  // Stryker restore next-line OptionalChaining
  return text?.charAt(0) ?? '';
}

/** The mutant never ends the loop; the catch swallows the hit-limit error too. */
export function countItems(items: readonly number[]): number {
  let counted = 0;
  try {
    // Stryker restore next-line UpdateOperator
    for (let index = 0; index < items.length; index++) {
      counted += 1;
    }
  } catch {
    // Swallowed on purpose: the run must still end as a timeout through the hit count.
  }
  return counted;
}

/** The mutant leaves a rejected promise without a handler. */
export function scheduleAudit(quiet: boolean): void {
  // Stryker restore next-line BooleanLiteral
  if (!quiet) void Promise.reject(new Error('runtime: the audit failed'));
}

/** The mutant turns the delay into one far above the fixture's testTimeout. */
export function settleDelay(fast: boolean): number {
  // Stryker restore next-line BooleanLiteral
  if (!fast) return 10_000;
  return 0;
}

/** The mutant makes the only test that covers it skip itself. */
export function featureDisabled(): boolean {
  // Stryker restore next-line BooleanLiteral
  return false;
}

/** No test calls it. */
export function neverCalled(): string {
  // Stryker restore next-line StringLiteral
  return 'unreached';
}
