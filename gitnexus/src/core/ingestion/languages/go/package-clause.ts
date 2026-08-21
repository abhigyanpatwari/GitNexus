/**
 * Go package-clause resolution — the single derivation of a file's package
 * identity (#2837).
 *
 * Both Go passes that bucket files by package (`populateGoWorkspaceOwners` and
 * `populateGoPackageSiblings`) previously carried their own byte-identical copy
 * of this, spelled as one unanchored multiline regex:
 *
 *     sourceText.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m)
 *
 * With the `m` flag that matches the first line ANYWHERE in the file starting
 * with `package <ident>` — comment bodies included. Measured against that exact
 * expression: a header comment containing `package legacy_notes kept for
 * history` yields `legacy_notes`, and an indented `  package helper old name`
 * yields `helper`. A file that mis-infers its own package gets a bucket key no
 * sibling shares, so it is isolated in BOTH passes: its methods never attach to
 * structs declared in sibling files, and it exchanges no same-package bindings.
 * Every field-receiver call in it then resolves to nothing, silently — the same
 * per-file signature #2837 reported.
 *
 * The Go spec makes the correct rule exact rather than heuristic: a source
 * file's first non-comment, non-blank token is `package`. So skip the leading
 * run of whitespace and comments, then require the very next token to be the
 * clause. Anything else is `null` — a truncated read, a misrouted non-Go file,
 * an unparseable header — reported by the caller rather than guessed at.
 *
 * ONE rule governs every leniency below (the `\s+` separator, the shebang skip,
 * CR-only line endings): a file this returns `null` for is dropped from BOTH
 * passes, so refusing a shape the previous regex accepted is a silent
 * regression, not a principled tightening. Be no stricter than the grammar.
 */

/** Leading trivia: whitespace, `//` lines, block comments. Sticky. */
const LEADING_TRIVIA = /(?:\s+|\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)*/y;

/** The clause itself, anchored at the first non-trivia byte. `\s+` (not
 *  `[ \t]+`) because Go separates tokens by any whitespace: `package\nmain` is
 *  legal and tree-sitter parses it without error. */
const PACKAGE_CLAUSE = /package\s+([A-Za-z_][A-Za-z0-9_]*)/y;

/**
 * The package name declared by this Go source text, or `null` when its first
 * real token is not a package clause.
 *
 * Only the leading run before the clause is skipped — deliberately NOT a
 * whole-file comment strip, which would be O(file) on every Go file and would
 * also have to model string literals to stay correct.
 */
export function inferGoPackageName(sourceText: string): string | null {
  let i = 0;
  // A leading `#!` line: `gorun`-style scripts carry one. Only a FIRST-line
  // `#!` is skipped; a `#` anywhere else still ends the scan.
  if (sourceText.startsWith('#!')) {
    const eol = sourceText.search(/[\n\r]/);
    if (eol === -1) return null;
    i = eol + 1;
  }
  // Whitespace (`\s` covers the BOM and every line ending), `//` lines and block
  // comments — the run a Go file may carry before its clause. Sticky, so the
  // header is skipped in place without slicing a copy of the file. An
  // unterminated `/*` or a `//` running to EOF simply leaves `lastIndex` where
  // the clause cannot match, so neither needs its own early return.
  LEADING_TRIVIA.lastIndex = i;
  LEADING_TRIVIA.exec(sourceText);
  PACKAGE_CLAUSE.lastIndex = LEADING_TRIVIA.lastIndex;
  return PACKAGE_CLAUSE.exec(sourceText)?.[1] ?? null;
}

/**
 * The directory half of a Go package key. Go package identity is
 * directory-scoped, so repeated `package main` directories must not see each
 * other's unqualified names.
 */
export function goPackageDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}
