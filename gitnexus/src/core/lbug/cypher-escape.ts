/**
 * Escape a value for embedding in a single-quoted Cypher string literal.
 *
 * LadybugDB's parser uses backslash escapes and REJECTS SQL-style `''`
 * doubling — `'we''ird'` is a parser error, not an escaped quote (#2409
 * review). Every call site that used doubling produced a query that never
 * parsed; the failures were invisible wherever the site swallowed errors
 * (per-file deletes skipping quoted paths, importer BFS returning [],
 * augment/wiki batch lookups silently missing rows).
 *
 * Backslashes are escaped first, then quotes — reversing the order would
 * double the backslash that the quote escape just introduced. For values
 * inside single-quoted literals only; table/label names go through
 * `escapeTableName` in lbug-adapter instead.
 *
 * NOT for CSV emission: the COPY path (csv-generator.ts) quotes fields for
 * LadybugDB's CSV reader (`ESCAPE='"'`), a different grammar with its own
 * rules — its `''` usages are not this bug.
 */
export const escapeCypherString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
