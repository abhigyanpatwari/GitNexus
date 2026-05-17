/**
 * Validate user-supplied query params payloads for prepared Cypher execution.
 * Accepts plain objects only (rejects null and arrays).
 */
export const isValidQueryParams = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
