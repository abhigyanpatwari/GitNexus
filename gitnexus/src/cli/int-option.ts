/**
 * Shared integer parsing for CLI flags.
 *
 * One digit-only parser with a per-flag minimum, so `1e3`, `0x10`, `1.5`,
 * and padded-zero spellings are rejected the same way on every surface.
 * Callers choose how to report the typed error: analyze routes it through
 * `cliError` + `process.exitCode = 1`, while watch and wiki let it propagate.
 */

export class IntegerOptionError extends Error {
  constructor(
    readonly flag: string,
    readonly minimum: number,
    message: string,
  ) {
    super(message);
    this.name = 'IntegerOptionError';
  }
}

export interface IntegerOptionBounds {
  /** Smallest accepted value (inclusive). */
  minimum: number;
  /**
   * Divides the safe-integer bound, for values the caller later multiplies
   * (wiki's `--timeout` seconds become milliseconds, so it passes 1000).
   */
  scale?: number;
}

/**
 * Parse a trimmed, digit-only integer flag value. Throws
 * `IntegerOptionError` naming the flag when the value is not a plain
 * non-negative integer, is below the minimum, or exceeds
 * `MAX_SAFE_INTEGER / scale`.
 */
export function parseIntegerOption(
  value: string,
  flag: string,
  { minimum, scale = 1 }: IntegerOptionBounds,
): number {
  const trimmed = value.trim();
  const parsed = /^(0|[1-9]\d*)$/.test(trimmed) ? parseInt(trimmed, 10) : Number.NaN;
  if (Number.isNaN(parsed) || parsed < minimum) {
    const requirement =
      minimum === 1 ? 'must be a positive integer' : `must be an integer >= ${minimum}`;
    throw new IntegerOptionError(flag, minimum, `${flag} ${requirement}`);
  }
  if (parsed > Math.floor(Number.MAX_SAFE_INTEGER / scale)) {
    throw new IntegerOptionError(flag, minimum, `${flag} is too large`);
  }
  return parsed;
}
