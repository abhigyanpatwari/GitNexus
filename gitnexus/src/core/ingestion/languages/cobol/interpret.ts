/**
 * COBOL scope-resolution interpret hooks.
 *
 * Interprets raw `@import.statement` capture matches (from COPY statements)
 * into `ParsedImport` for the central finalize algorithm.
 *
 * COBOL's import semantic is simple: `COPY bookname` means the copybook's
 * content is inlined at compile time. There is no module-system equivalent
 * of `export` — everything is text-inclusion. The scope-resolution pipeline
 * models this as a `'named'` import where the imported name is the copybook
 * name and the target is the copybook file path.
 */

import type {
  CaptureMatch,
  ParsedImport,
  ParsedTypeBinding,
  ScopeId,
  ScopeTree,
  Scope,
  TypeRef,
} from 'gitnexus-shared';

// ─── interpretImport ──────────────────────────────────────────────────────

/**
 * Interpret a COPY statement as a `ParsedImport`.
 *
 * The `@import.name` capture contains the copybook target name (e.g.,
 * `CPSESP` from `COPY CPSESP.`). Returns a `'named'` import with the
 * copybook name as both `localName` and `importedName`.
 *
 * Returns `null` for any match that doesn't carry an `@import.name` (e.g.,
 * malformed COPY statements the regex tagger might emit).
 */
export function interpretCobolImport(match: CaptureMatch): ParsedImport | null {
  const nameCap = match['@import.name'];
  if (nameCap === undefined) return null;

  const name = nameCap.text;
  if (name === '') return null;

  return {
    kind: 'named',
    localName: name,
    importedName: name,
    targetRaw: name,
  };
}

// ─── interpretTypeBinding ─────────────────────────────────────────────────

/**
 * COBOL has no type system — no type bindings to interpret.
 * Always returns `null`.
 */
export function interpretCobolTypeBinding(_match: CaptureMatch): ParsedTypeBinding | null {
  return null;
}

// ─── importOwningScope ────────────────────────────────────────────────────

/**
 * COPY statements in COBOL are module-level — they expand inline at
 * compile time and their bindings belong to the enclosing PROGRAM-ID
 * (Module) scope. Walk up from the innermost scope through ancestors
 * to find the enclosing Module scope.
 *
 * For the edge case of a COPY inside a paragraph (unusual but possible
 * with some vendors), we walk the scope tree to ensure the import is
 * attached to the program scope, not the paragraph Function scope.
 */
export function cobolImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  // If already in a Module scope, use it directly.
  if (innermost.kind === 'Module') return innermost.id;
  // Walk through ancestors to find the enclosing Module.
  const ancestors = tree.getAncestors(innermost.id);
  for (const ancId of ancestors) {
    const anc = tree.getScope(ancId);
    if (anc !== undefined && anc.kind === 'Module') return ancId;
  }
  // Fallback: delegate to central default.
  return null;
}

// ─── receiverBinding ──────────────────────────────────────────────────────

/**
 * COBOL has no implicit receiver (no `self`, `this`, or equivalent).
 * All function calls are explicit CALL statements or PERFORM/GO TO
 * control flow. Always returns `null`.
 */
export function cobolReceiverBinding(_functionScope: Scope): TypeRef | null {
  return null;
}
