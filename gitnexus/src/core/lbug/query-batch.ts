/**
 * Ceilings for graph queries whose input is an unbounded, caller-sized array.
 *
 * The engine parses a whole query before it runs, so anything spliced into the
 * TEXT — an `IN [...]` literal, a per-item OR chain — grows the query with the
 * input. See `coalesceHunks` in `src/storage/git.ts` for what that crash looks
 * like (#2915).
 *
 * Two ways out, in order of preference:
 *   1. Bind the list as a PARAMETER (`WHERE x IN $paths`). The text is then
 *      constant no matter how long the list is, and the engine holds one value
 *      node instead of an expression tree. Measured 3x faster than the
 *      equivalent inlined literal at 5,000 items, and it keeps predicates that
 *      would otherwise have to move into JS.
 *   2. Where a parameter will not do, `chunk()` the input and merge in JS.
 *      That is a real cost — cross-batch semantics (DISTINCT, ORDER BY, LIMIT,
 *      membership tests) have to be re-established by hand — so reach for it
 *      second.
 */

/**
 * Items per graph query when the input list is caller-sized.
 *
 * Measured on a 25k-node index: for the `detect_changes` hunk→symbol query, 25
 * items cost 1025ms, 50 cost 642ms, **100 cost 476ms**, 200 cost 613ms and 800
 * cost 650ms — round-trip overhead dominates below 100, per-query cost above
 * it. The impact path's id lookups landed on the same number independently.
 */
export const LBUG_QUERY_BATCH_SIZE = 100;

/**
 * Query text above which a caller is assumed to be splicing a caller-sized list
 * into the query rather than binding it.
 *
 * A deliberately loose proxy. The fatal shape is expression DEPTH (the engine's
 * recursive evaluator copy overflows its worker-thread stack — a bare SIGBUS on
 * a 512 KB stack), and text length cannot distinguish a deep tree from a wide
 * flat literal of the same size. What it buys is attribution: a query that
 * would have died in native code with no message instead names itself. #2915's
 * 3,000 hunks produced roughly 200 KB of WHERE clause; every legitimate query
 * in this repo is under 8 KB.
 */
const QUERY_TEXT_CEILING_BYTES = 64 * 1024;

/**
 * Warn when a query looks like it was built by string-concatenating a
 * caller-sized list. Never throws: a long query that the engine can actually
 * run must not start failing because of a heuristic.
 */
export function warnIfQueryTextUnbounded(
  cypher: string,
  context: string,
  warn: (message: string) => void,
): void {
  // `cypher.length` counts UTF-16 code units, and what reaches the engine is
  // UTF-8 bytes — non-ASCII query text is undercounted by up to 3x. UTF-8 never
  // needs more than 3 bytes per code unit (an astral character costs 4 bytes
  // across 2 units), so a query short enough here cannot exceed the ceiling and
  // never pays for the byte count. This runs on every read query.
  if (cypher.length * 3 <= QUERY_TEXT_CEILING_BYTES) return;
  const bytes = Buffer.byteLength(cypher, 'utf8');
  if (bytes <= QUERY_TEXT_CEILING_BYTES) return;
  warn(
    `${context}: query text is ${Math.round(bytes / 1024)} KB. A list spliced into query ` +
      `text grows the expression the engine has to parse and can overflow its evaluator stack ` +
      `(#2915) — bind the list as a parameter (WHERE x IN $list), or chunk it.`,
  );
}
