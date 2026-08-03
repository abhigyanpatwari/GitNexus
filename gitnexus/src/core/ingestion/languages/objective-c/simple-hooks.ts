import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

export function objectiveCBindingScopeFor(
  declaration: CaptureMatch,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  if (declaration['@type-binding.self'] !== undefined && innermost.kind === 'Function') {
    return innermost.id;
  }
  return null;
}

export function objectiveCImportOwningScope(
  _import: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return innermost.kind === 'Module' ? innermost.id : null;
}

export function objectiveCReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('self') ?? null;
}
