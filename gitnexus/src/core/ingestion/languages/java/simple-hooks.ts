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

/** Java imports are always at compilation-unit (Module) level (JLS §7.5).
 *  Return `null` unconditionally so the default Module scope is used. */
export function javaImportOwningScope(
  _imp: ParsedImport,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

// ─── receiverBinding ──────────────────────────────────────────────────────

/** Look up `this` or `super` in the function scope's type bindings. */
export function javaReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('this') ?? functionScope.typeBindings.get('super') ?? null;
}
