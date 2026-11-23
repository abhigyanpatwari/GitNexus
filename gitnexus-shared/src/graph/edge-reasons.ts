/** The callee's simple name was unique, but the caller had no binding to it. */
export const GLOBAL_NAME_FALLBACK_REASON = 'global-name-fallback';

/** Cypher predicate used at each hop of CLI, MCP, and web impact traversal. */
export const impactEdgePredicate = (edge: 'r' | 'r1' | 'r2' | 'r3'): string =>
  `(${edge}.type <> 'CALLS' OR ${edge}.reason IS NULL OR ${edge}.reason <> '${GLOBAL_NAME_FALLBACK_REASON}')`;
