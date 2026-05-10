/**
 * Small hooks for the Java provider. Each is a few lines; they make
 * the provider's choice explicit rather than relying on defaults.
 */

import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

// ─── bindingScopeFor ──────────────────────────────────────────────────────

/** Method return-type bindings hoist to Module scope so cross-file
 *  `propagateImportedReturnTypes` and chain-follow can find them. */
export function javaBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  if (decl['@type-binding.return'] !== undefined) {
    let cur: Scope | undefined = innermost;
    while (cur !== undefined && cur.kind !== 'Module') {
      const parentId: ScopeId | null = cur.parent ?? null;
      if (parentId === null) break;
      cur = tree.getScope(parentId);
    }
    if (cur !== undefined && cur.kind === 'Module') return cur.id;
  }
  return null;
}

// ─── importOwningScope ────────────────────────────────────────────────────

/** Java imports are always at file level. Defensively handle nested
 *  scopes by attaching to the innermost if it's Class or Function. */
export function javaImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  if (innermost.kind === 'Class' || innermost.kind === 'Function') return innermost.id;
  return null;
}

// ─── receiverBinding ──────────────────────────────────────────────────────

/** Look up `this` or `super` in the function scope's type bindings. */
export function javaReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('this') ?? functionScope.typeBindings.get('super') ?? null;
}
