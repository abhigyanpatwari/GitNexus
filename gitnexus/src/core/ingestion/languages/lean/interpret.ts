/**
 * Lean 4 scope-resolution interpret hooks.
 *
 * Interprets raw `@import.statement` capture matches (from `import` and
 * `open` statements) into `ParsedImport` for the central finalize algorithm.
 *
 * Lean's import semantic: `import Foo.Bar` loads the module file
 * `Foo/Bar.lean` (dotted path → relative path); `open Foo` brings its
 * names into scope without qualification. Both are modeled as `'named'`
 * imports with the dotted path as `targetRaw`; the scope resolver maps
 * the dotted path to a file path (`resolveImportTarget` in
 * `scope-resolver.ts`). Lean has no export list — every declaration is
 * visible — so there is nothing to check on the export side.
 */

import type {
  CaptureMatch,
  ParsedImport,
  ParsedTypeBinding,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

// ─── interpretImport ──────────────────────────────────────────────────────

/**
 * Interpret an `import`/`open` statement as a `ParsedImport`.
 *
 * The `@import.name` capture holds the dotted module path
 * (e.g., `Mathlib.Analysis.Calculus.Deriv.MeanValue`).
 * Returns `null` for matches without a name.
 */
export function interpretLeanImport(match: CaptureMatch): ParsedImport | null {
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
 * Lean signatures carry types, but MVP scope resolution does not model
 * the type system (same posture as the initial COBOL wiring).
 * Always returns `null`.
 */
export function interpretLeanTypeBinding(_match: CaptureMatch): ParsedTypeBinding | null {
  return null;
}

// ─── importOwningScope / receiverBinding ──────────────────────────────────

/**
 * Imports live at file scope in Lean (top-of-file `import`, `open`
 * anywhere but resolved file-wide for MVP): walk up to the Module.
 */
export function leanImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  if (innermost.kind === 'Module') return innermost.id;
  const ancestors = tree.getAncestors(innermost.id);
  for (const ancId of ancestors) {
    const anc = tree.getScope(ancId);
    if (anc !== undefined && anc.kind === 'Module') return ancId;
  }
  return null;
}

/**
 * Lean is not method-receiver based (`self`/`this`); standalone functions.
 */
export function leanReceiverBinding(_functionScope: Scope): TypeRef | null {
  return null;
}
