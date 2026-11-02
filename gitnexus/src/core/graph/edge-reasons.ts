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
 * Emitted by the unique-simple-name tiers of the free-call fallback
 * (`pickUniqueGlobalCallable` and constructor-form `pickUniqueGlobalClass`),
 * and only for the languages that opt into `allowGlobalFreeCallFallback`. It
 * is a name collision away from being wrong and must never be presented as
 * an import-resolved edge: a reader who cannot tell the two apart has no way
 * to discount the guess.
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

/**
 * An IMPORTS edge from a File to the `Module` node of the compiler module it
 * belongs to, for languages where every file of a module sees every other
 * file's declarations with no `import` (whole-module visibility).
 *
 * One edge per member file instead of one per ordered file pair: the pairwise
 * form is n·(n−1) edges and exhausted V8's Map limit on large modules (#3355).
 * Consumers that need "files that see this file" follow the hub: two files are
 * co-members when both have a membership edge to the same `Module` node
 * (`queryImportersBatch`).
 */
export const MODULE_MEMBERSHIP_REASON = 'module-membership';
