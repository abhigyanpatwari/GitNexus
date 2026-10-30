/**
 * PL/SQL scope-resolution interpret hooks.
 *
 * PL/SQL itself has no import statement — schema objects are global to the
 * database. The one textual inclusion in PL/SQL source trees is SQL*Plus
 * `@@script` / `@script` / `START script`, which install scripts use to load
 * package specs and bodies in order. It is modelled as a `'named'` import of
 * the script path.
 */

import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

export function interpretPlSqlImport(match: CaptureMatch): ParsedImport | null {
  const name = match['@import.name']?.text;
  if (!name) return null;
  return { kind: 'named', localName: name, importedName: name, targetRaw: name };
}

/** Script inclusion is file-level: it binds in the file's Module scope. */
export function plsqlImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  if (innermost.kind === 'Module') return innermost.id;
  for (const id of tree.getAncestors(innermost.id)) {
    const scope = tree.getScope(id);
    if (scope?.kind === 'Module') return id;
  }
  return null;
}

/** PL/SQL subprograms have no implicit receiver (object-type `SELF` is out of scope). */
export function plsqlReceiverBinding(_functionScope: Scope): TypeRef | null {
  return null;
}
