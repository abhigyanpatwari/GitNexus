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

/**
 * Build an OR-of-scalar-equality predicate over a relationship's `type`
 * property, replacing list-membership (`IN`) filters on the rel-type column.
 *
 * LadybugDB ≥ 0.18.1 writes a CodeRelation storage layout (bulk CSV COPY
 * across the multi-pair rel table) on which relationship-property IN-list
 * predicates return wrong rows — duplicated and dropped edges — under every
 * reader version, while scalar equality evaluates correctly on the same data
 * (#2508). Route every rel-type filter through this helper; never write
 * `.type IN` against a relationship alias.
 *
 * Spread `params` into the query's existing parameter map; keys are
 * `${paramPrefix}0..n`, so distinct prefixes keep multiple predicates in one
 * statement collision-free. An empty `types` list preserves the
 * match-nothing semantics of `IN []` via a literal `FALSE` clause.
 */
export const relTypeEquals = (
  alias: string,
  types: readonly string[],
  paramPrefix = 'relType',
): { clause: string; params: Record<string, string> } => {
  if (types.length === 0) return { clause: 'FALSE', params: {} };
  const params: Record<string, string> = {};
  const terms = types.map((t, i) => {
    const key = `${paramPrefix}${i}`;
    params[key] = t;
    return `${alias}.type = $${key}`;
  });
  return { clause: `(${terms.join(' OR ')})`, params };
};
