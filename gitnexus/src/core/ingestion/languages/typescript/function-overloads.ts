import { makeScopeId } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { narrowOverloadCandidates } from '../../scope-resolution/passes/overload-narrowing.js';
import { findAllCallableBindingsInScope } from '../../scope-resolution/scope/walkers.js';
import { selectTsPrimitiveOverload } from './call-arguments.js';

export const resolveTsFunctionOverload: ScopeResolver['resolveUnqualifiedCall'] = (
  site,
  scopes,
) => {
  // Resolve the lexical/imported name first. An overload in a different module
  // or an outer scope cannot contribute a signature to that declaration.
  const visible = findAllCallableBindingsInScope(site.inScope, site.name, scopes, {
    position: site.atRange,
    purpose: 'value',
    callee: true,
  });
  const def = visible[0];
  if (def?.type !== 'Function' || !def.declarationRange || !def.qualifiedName) return undefined;
  const scope = makeScopeId({
    filePath: def.filePath,
    range: def.declarationRange,
    kind: 'Function',
  });
  const siblings = scopes.scopeTree.getParent(scope)?.bindings.get(def.qualifiedName);
  if (!siblings?.some((binding) => binding.def.isOverloadSignature)) return undefined;
  if (visible.length > 1) {
    const family = new Set(siblings.map((binding) => binding.def.nodeId));
    if (!visible.every((candidate) => family.has(candidate.nodeId))) return undefined;
  }
  const signatures = siblings
    .filter((binding) => binding.def.isOverloadSignature)
    .map((binding) => binding.def);
  const selected = selectTsPrimitiveOverload(signatures, site, scopes);
  if (selected) return { kind: 'resolved', definition: selected };
  const matches = narrowOverloadCandidates(signatures, site.arity, site.argumentTypes);
  if (matches.length === 1) return { kind: 'resolved', definition: matches[0] };
  return {
    kind: matches.length ? 'unknown' : 'inapplicable',
    candidateIds: (matches.length ? matches : signatures).map((signature) => signature.nodeId),
  };
};
