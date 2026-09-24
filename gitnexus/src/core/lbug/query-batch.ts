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
 * Items per graph query when each item makes the query do MORE WORK — an
 * `UNWIND` row, a per-item predicate, anything the engine pays for per item.
 *
 * Measured on a 25k-node index: for the `detect_changes` hunk→symbol query, 25
 * items cost 1025ms, 50 cost 642ms, **100 cost 476ms**, 200 cost 613ms and 800
 * cost 650ms — round-trip overhead dominates below 100, per-query cost above
 * it. The impact path's id lookups landed on the same number independently,
 * and its list is bounded by `processLimit * maxSymbolsPerProcess` anyway, so
 * it rarely fills even one chunk.
 *
 * NOT the size for an id-list probe — see `LBUG_ID_PROBE_BATCH_SIZE`, which
 * measures an order of magnitude larger for the opposite reason. The two are
 * deliberately separate constants.
 */
export const LBUG_QUERY_BATCH_SIZE = 100;

/**
 * Items per graph query when the list is only a MEMBERSHIP TEST the engine
 * probes with — `WHERE n.id IN $ids` and nothing else scaling with it.
 *
 * Ten times `LBUG_QUERY_BATCH_SIZE` because the two shapes are opposites:
 *
 * - The hunk→symbol query above is an unlabeled `MATCH (n)`, a scan of the
 *   whole node table that every batch pays in full. More items per batch means
 *   fewer scans to amortise, so the cost curve turns UP past ~100.
 * - An `id IN $ids` probe does work proportional to the ids and nothing else.
 *   There is no fixed cost to amortise, so a small batch is pure round-trip
 *   overhead and the curve only turns up once a batch is big enough to
 *   materialise a large list.
 *
 * Measured on this repo's index (25k nodes), `detect_changes`' symbol→process
 * lookup at concurrency 4, median of 3:
 *
 * | ids    | chunk=100 | chunk=1000 | one query |
 * |--------|-----------|------------|-----------|
 * |  5,000 |     161ms |       88ms |     124ms |
 * | 20,000 |     617ms |      266ms |     336ms |
 *
 * At 20,000 ids the curve is already flat at 1,000 (250:374ms, 500:300ms,
 * 1000:261ms, 2000:248ms, 4000:269ms), so a larger batch buys ≤5% and gives
 * back the ceiling that is the whole point of chunking: the unchunked form
 * measured 1,238 MB at 100k ids and 4,002 MB at 500k (#2915). 1,000 is the
 * first size on the flat part.
 *
 * This also settles an earlier measurement that read chunking this query as a
 * regression (4,150 ids 129→152ms, 9,749 ids 238→325ms): that was chunk=100,
 * which is slower than not chunking at all above ~2,000 ids. At 1,000 the
 * chunked form beats both.
 */
export const LBUG_ID_PROBE_BATCH_SIZE = 1000;

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
