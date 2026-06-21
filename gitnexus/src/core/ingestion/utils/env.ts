/**
 * Environment constants shared across the ingestion module.
 *
 * Centralizes `isDev` so every file in `ingestion/` imports from
 * one canonical location rather than re-declaring the check.
 *
 * @module
 */

/** Whether we're running in development mode (enables verbose console logging). */
export const isDev = process.env.NODE_ENV === 'development';

/**
 * Parse a narrow-form truthy env-var value. Accepts `'1'`, `'true'`, `'yes'`
 * (case-insensitive, whitespace-trimmed). Anything else — including
 * `undefined`, empty string, `'0'`, `'false'`, `'no'`, or unknown tokens —
 * returns `false`.
 *
 * This is the shared helper for narrow-form truthy parsing across the
 * ingestion module. `logger.ts` uses a broader negative-list form
 * (`isTruthyEnv`) that intentionally accepts anything except a small set of
 * falsy tokens — that lives separately because it follows pino-debug
 * conventions and serves a different purpose.
 */
export const parseTruthyEnv = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
};

/**
 * Parse a positive-integer env-var value. Returns the integer when `raw` is a
 * finite integer `> 0`; otherwise (`undefined`, empty, non-numeric, `0`, or
 * negative) returns `undefined` so the caller falls back to its default. Used
 * for numeric tuning knobs like `GITNEXUS_PDG_EMIT_CHUNK_SIZE` (#2202).
 */
export const parsePositiveIntEnv = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * Whether scope-resolution dev validators (e.g. `validateBindingsImmutability`)
 * should run AND emit warnings. Off by default in CLI runs to avoid silent
 * O(n) scans on large repos; on in `NODE_ENV=development` or when explicitly
 * opted-in via `VALIDATE_SEMANTIC_MODEL=1`. `VALIDATE_SEMANTIC_MODEL=0` is the
 * explicit off switch and wins over both.
 *
 * Read every call (not memoized) so test setups using `vi.stubEnv` work.
 */
export const isSemanticModelValidatorEnabled = (): boolean => {
  if (process.env.VALIDATE_SEMANTIC_MODEL === '0') return false;
  return process.env.NODE_ENV === 'development' || process.env.VALIDATE_SEMANTIC_MODEL === '1';
};
