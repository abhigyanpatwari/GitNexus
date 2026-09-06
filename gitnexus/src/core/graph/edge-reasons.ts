/**
 * Edge `reason` values that mark a CALLS edge as a HEURISTIC GUESS rather than
 * a resolution.
 *
 * The distinction exists because an edge's `confidence` number cannot carry it.
 * `GLOBAL_NAME_FALLBACK_REASON` edges are emitted at exactly 0.5 — the same
 * number as `process-processor`'s `MIN_TRACE_CONFIDENCE` and
 * `community-processor`'s `MIN_CONFIDENCE_LARGE` — so a `confidence < 0.5`
 * gate does NOT exclude them. Anything that must exclude guesses has to read
 * the reason, which is why `KnowledgeGraph.forEachRelationshipFields` passes it
 * and why `GraphEmitSink` retains a reason column.
 */

/**
 * The target was chosen because its SIMPLE NAME is unique in the workspace —
 * not because any import, scope chain, or type binding led to it.
 *
 * Emitted only by the `pickUniqueGlobalCallable` tier of the free-call
 * fallback, and only for the languages that opt into
 * `allowGlobalFreeCallFallback`. It is a name collision away from being wrong
 * and must never be presented as an import-resolved edge: a reader who cannot
 * tell the two apart has no way to discount the guess.
 */
export const GLOBAL_NAME_FALLBACK_REASON = 'global-name-fallback';

/**
 * Reasons excluded from process tracing and large-graph community detection.
 *
 * Both walks exist to describe how the program actually flows. Seeding a flow
 * from a unique-name guess produces a confident-looking trace through code that
 * may never call each other, which is worse than a shorter honest trace.
 */
const HEURISTIC_EDGE_REASONS: ReadonlySet<string> = new Set([GLOBAL_NAME_FALLBACK_REASON]);

/** True when this edge's target was guessed by name rather than resolved. */
export const isHeuristicEdgeReason = (reason: string): boolean =>
  HEURISTIC_EDGE_REASONS.has(reason);
