/**
 * Return true only for plain-object payloads that can be safely used as
 * named parameter maps in prepared Cypher execution.
 *
 * Validation criteria:
 * - must be a JavaScript object (`typeof value === 'object'`)
 * - must not be `null`
 * - must not be an array
 * - must have a plain-object prototype
 * - values must be scalar bindable values (string | number | boolean | null)
 *
 * Rationale: prepared-statement params are key/value maps; rejecting null/array
 * and non-plain objects keeps binding behavior predictable and avoids passing
 * complex host objects to Ladybug parameter binding.
 */
const isBindableScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

export const isValidQueryParams = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Object.values(value).every(isBindableScalar);
