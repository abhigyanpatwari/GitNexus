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
 */

/** Sticky (anchored at `lastIndex`) so the clause is matched in place, without
 *  slicing a copy of the file for what is always a header-length check. */
// `\s+`, not `[ \t]+`: Go's grammar separates tokens by any whitespace, so
// `package\nmain` is legal and tree-sitter parses it without error. The narrower
// class rejected it (and CR-only line endings) where the regex it replaced did
// not — a file returning `null` is dropped from BOTH Go cross-file passes, so
// being stricter than the grammar is the expensive direction to be wrong in.
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
  const n = sourceText.length;
  let i = 0;
  for (;;) {
    // `\s` covers the BOM (U+FEFF) as well as ordinary whitespace and CRLF.
    while (i < n && /\s/.test(sourceText.charAt(i))) i += 1;
    if (sourceText.startsWith('//', i)) {
      // Terminate on CR *or* LF. Scanning for `\n` alone swallowed the rest of a
      // CR-only file — the leading `//go:build` comment ate the package clause
      // with it and the file was dropped from both Go cross-file passes. Rare,
      // but the regex this replaced handled it, so losing it is a regression.
      let end = i + 2;
      while (end < n && sourceText.charAt(end) !== '\n' && sourceText.charAt(end) !== '\r') {
        end += 1;
      }
      if (end >= n) return null; // comment runs to EOF: no clause follows
      i = end + 1;
      continue;
    }
    if (sourceText.startsWith('/*', i)) {
      const end = sourceText.indexOf('*/', i + 2);
      if (end === -1) return null; // unterminated block comment
      i = end + 2;
      continue;
    }
    break;
  }
  PACKAGE_CLAUSE.lastIndex = i;
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
