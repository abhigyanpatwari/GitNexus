/**
 * Return true only for plain object payloads that can be safely used as
 * named parameter maps in prepared Cypher execution.
 */
export const isValidQueryParams = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
