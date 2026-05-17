/**
 * Return true only for plain-object payloads that can be safely used as
 * named parameter maps in prepared Cypher execution.
 *
 * Validation criteria:
 * - must be a JavaScript object (`typeof value === 'object'`)
 * - must not be `null`
 * - must not be an array
 *
 * Rationale: prepared-statement params are key/value maps; rejecting null/array
 * prevents ambiguous payload shapes and keeps binding behavior consistent.
 */
export const isValidQueryParams = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
