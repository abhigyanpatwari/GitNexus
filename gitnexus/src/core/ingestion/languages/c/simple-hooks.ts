import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

/**
 * C binding scope: always use default auto-hoist (null).
 * C has no self/receiver bindings that need special scoping.
 */
export function cBindingScopeFor(
  _decl: CaptureMatch,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

/**
 * C import owning scope: always use default (null).
 */
export function cImportOwningScope(
  _imp: ParsedImport,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

/**
 * C receiver binding: always null. C has no methods or receivers.
 */
export function cReceiverBinding(_functionScope: Scope): TypeRef | null {
  return null;
}
