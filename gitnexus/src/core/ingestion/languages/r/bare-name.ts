/**
 * R lets any name be written in backticks (`` `%+%` ``, `` `my fn` ``,
 * `` `helper` ``); the symbol is the text between them. The graph and the scope
 * model keep a definition's name exactly as written, while NAMESPACE entries,
 * roxygen tags and rename requests carry the symbol. The scope, qualified-call,
 * post-parse, rename and type code compare the two spellings through
 * {@link rBareName}, so there is one definition of "the same name" there. The one
 * other normaliser is `stripBackticks` in `languages/r/import-target.ts`, which removes
 * every leading and trailing backtick from a NAMESPACE entry (a quoted
 * `` "`x`" `` entry keeps its backticks after `normaliseArg`) before comparing it
 * with a symbol.
 *
 * One pair of surrounding backticks is removed, in constant time. An escaped
 * backtick inside the name stays as written, as `normaliseArg` in
 * `namespace-imports.ts` leaves it when it unquotes a NAMESPACE entry.
 */
export function rBareName(name: string): string {
  const last = name.length - 1;
  return last >= 1 && name.charCodeAt(0) === 96 && name.charCodeAt(last) === 96
    ? name.slice(1, last)
    : name;
}
