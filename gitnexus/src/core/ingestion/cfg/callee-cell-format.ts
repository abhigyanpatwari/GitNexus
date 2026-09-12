/**
 * Wire format of the `BasicBlock.callees` / `BasicBlock.calleeIds` cells.
 *
 * A LEAF module on purpose: it declares two string constants and imports
 * nothing. `cfg/emit.ts` produces those cells and `mcp/local/pdg-impact.ts`
 * parses them, but `emit.ts` is analyze-only and drags the whole CFG closure
 * (reaching-defs, control-dependence, post-dominators, synthetic-escape,
 * call-site-harvest) behind it — 8 modules evaluated at every MCP server start
 * just to read two strings, since ESM evaluates a module to import any binding
 * from it (#2802 review). Splitting the format constants out deletes that cost
 * rather than deferring it, which is the same bar #2802 held its own proposals
 * to.
 *
 * `emit.ts` RE-EXPORTS both names, so every existing importer keeps working and
 * the producer/consumer pair still resolves to one definition — the drift this
 * shared constant exists to prevent stays impossible.
 */

/**
 * Reserved token placed in `BasicBlock.callees` when a statement's call sites
 * were truncated at the per-statement site cap: the recorded callee list is then
 * INCOMPLETE, so over-cap callees are absent. `*` is not a valid identifier
 * leaf, so it cannot collide with a real callee name. The impact bridge treats a
 * slice containing this sentinel as "callees unknown" and keeps reach
 * callgraph-equal (proven), rather than falsely labeling an absent-but-real
 * callee `unproven-bridge`.
 */
export const CALLEES_TRUNCATED_SENTINEL = '*';

/**
 * Inner separator for the `BasicBlock.calleeIds` cell (resolved callee symbol
 * ids). A TAB is used — NOT a space — because resolved ids embed `filePath` and
 * C++ overload shape tags with multi-word primitive types (e.g. `unsigned char`,
 * `long double`), so an id can legitimately contain a space; a space-joined cell
 * then fragments on read and silently drops inter-procedural reach to that
 * callee (#2227 tri-review). A tab cannot appear in a tree-sitter-derived id
 * token (paths/identifiers/type tokens are tab-free) and round-trips intact
 * through `escapeCSVField` (tab is in its preserved set) and the RFC-4180 COPY
 * reader (every cell is quoted). Producer (`calleeIdsOfBlock`) and consumer
 * (`splitCalleeIds`) both resolve to this single constant so they cannot drift.
 * The sibling `callees` (leaf-name) cell stays space-joined — leaf names are
 * bare identifiers and never contain a space.
 */
export const CALLEE_ID_SEP = '\t';
