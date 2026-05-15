/**
 * C++ standard-conversion-sequence ranking for overload resolution.
 *
 * ISO C++ ranks implicit conversion sequences as:
 *   - Exact match (rank 0) — no conversion needed
 *   - Promotion (rank 1) — int→long, float→double, char→int, bool→int
 *   - Standard conversion (rank 2) — int→double, double→int, etc.
 *   - Mismatch (Infinity) — incompatible types, no implicit conversion
 *
 * V1 operates on **normalized** type strings (output of
 * `normalizeCppParamType` in `arity-metadata.ts`). After normalization:
 *   - int/long/short/unsigned → 'int'
 *   - float/double → 'double'
 *   - char → 'char', bool → 'bool'
 *
 * Because the normalizer collapses promotion pairs (int↔long,
 * float↔double) to the same string, promotions are invisible at this
 * layer — they look like exact matches. The ranking that matters
 * post-normalization is therefore:
 *   - exact (same normalized type) → rank 0
 *   - arithmetic cross-type (int↔double, char→int, bool→int) → rank 2
 *   - mismatch (string↔int, user types, etc.) → Infinity
 *
 * This function is intentionally C++-specific (issue #1578 pitfall:
 * keep conversion-rank tables out of shared overload-narrowing). Other
 * languages may define their own `ConversionRankFn` in the future.
 */

/** Set of normalized arithmetic types that support implicit conversion. */
const ARITHMETIC = new Set(['int', 'double', 'char', 'bool']);

/**
 * Return the conversion rank from `argType` to `paramType`.
 *
 * @returns 0 for exact match, 2 for standard conversion between
 *          arithmetic types, Infinity for incompatible types.
 */
export function cppConversionRank(argType: string, paramType: string): number {
  if (argType === paramType) return 0;
  if (ARITHMETIC.has(argType) && ARITHMETIC.has(paramType)) return 2;
  return Infinity;
}
