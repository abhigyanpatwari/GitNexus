/**
 * Every identifier a Java source file spells, for `ScopeResolver.namesMentionedIn`.
 *
 * A type-import-on-demand declaration (`import pkg.*;`) imports types "as
 * needed" (JLS §7.5.2): it changes how simple names in the compilation unit
 * are read and does nothing else. So a file depends on a package member only
 * if it writes that member's simple name somewhere, and the set of identifiers
 * in the text is a superset of the names the import can ever bind.
 *
 * Deliberately lexical, with no parse and no notion of position: comments,
 * string literals and the import lines themselves all contribute. Each of
 * those can only ADD a name, which keeps an IMPORTS edge a compiler would not
 * need; nothing here can drop a name the file really uses. The import lines
 * are worth keeping in particular — `import static pkg.Utils.*;` is how a file
 * that calls `format()` unqualified names the `Utils` it depends on.
 *
 * ponytail: a regex over the text rather than a worker-captured identifier
 * fact. A name spelled only through a Unicode escape (`User`) is not
 * seen; that would need the lexer. Capture identifiers at parse time if this
 * ever has to work without retained source text.
 */

// JLS §3.8 via `Character.isJavaIdentifierStart` / `isJavaIdentifierPart`:
// letters, letter numbers, currency symbols and connector punctuation start an
// identifier; digits, combining marks and format characters may continue it.
const JAVA_IDENTIFIER =
  /[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}]*/gu;

export function javaNamesMentionedIn(sourceText: string): ReadonlySet<string> {
  return new Set(sourceText.match(JAVA_IDENTIFIER));
}
