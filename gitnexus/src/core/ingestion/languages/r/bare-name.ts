/**
 * R lets any name be written in backticks (`` `%+%` ``, `` `my fn` ``,
 * `` `helper` ``); the symbol is the text between them. The graph and the scope
 * model keep a definition's name exactly as written, while NAMESPACE entries,
 * roxygen tags and rename requests carry the symbol. Every place that compares
 * the two spellings goes through {@link rBareName}, so there is one definition of
 * "the same name".
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
