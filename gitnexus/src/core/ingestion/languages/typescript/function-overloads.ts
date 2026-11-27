import { makeScopeId } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import {
  findAllCallableBindingsInScope,
  findClassBindingInScope,
} from '../../scope-resolution/scope/walkers.js';
import { mayCallTsFunctionOverload, resolveTsOverloadSet } from './call-arguments.js';

export const resolveTsFunctionOverload: ScopeResolver['resolveUnqualifiedCall'] = (
  site,
  scopes,
) => {
  if (!mayCallTsFunctionOverload(site.name, scopes)) return undefined;
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
  const result = resolveTsOverloadSet(signatures, site, scopes);
  if (result.kind !== 'unknown') return result;
  const bodies = siblings.filter(({ def }) => def.type === 'Function' && !def.isOverloadSignature);
  if (bodies.length !== 1) return result;
  const candidates = new Set(result.candidateIds);
  const viable = signatures.filter((signature) => candidates.has(signature.nodeId));
  const first = viable[0];
  const returned = first?.returnType;
  const commonReturnSource =
    returned &&
    viable.every(
      (signature) => signature.returnType === returned && !signature.typeParameters?.length,
    ) &&
    findClassBindingInScope(scope, returned, scopes, undefined, {
      purpose: 'type',
      uniqueQualifiedNameFallback: false,
    })
      ? first
      : undefined;
  return {
    kind: 'implementation',
    definition: bodies[0].def,
    candidateIds: result.candidateIds,
    commonReturnSource,
  };
};
