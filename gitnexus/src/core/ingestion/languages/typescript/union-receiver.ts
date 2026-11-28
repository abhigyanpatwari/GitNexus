import type { ReferenceSite, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import { findClassBindingInScope } from '../../scope-resolution/scope/walkers.js';
import { primitiveTypes, selectTsPrimitiveOverload } from './call-arguments.js';

/** Overloaded union members can agree on one concrete positional signature. Equal
 * argument applicability alone does not establish that a common signature exists. */
function samePrimitiveSignature(left: SymbolDefinition, right: SymbolDefinition): boolean {
  const a = left.declaredParameterTypes;
  const b = right.declaredParameterTypes;
  return (
    !!a &&
    !!b &&
    // A representative with a different return type could misdirect a later call.
    left.returnType === right.returnType &&
    a.length === b.length &&
    left.parameterCount === a.length &&
    left.requiredParameterCount === a.length &&
    right.parameterCount === b.length &&
    right.requiredParameterCount === b.length &&
    a.every((type, index) => primitiveTypes.has(type) && type === b[index])
  );
}

/** The checker takes the first compatible signature from its ordered union of
 * member types. For equally named methods in one file, declaration position
 * determines that order, including methods inherited from a base class. */
export function representativeUnionOwner(
  receiver: TypeRef,
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
  model: SemanticModel,
  staticOnly: (member: SymbolDefinition) => boolean,
): SymbolDefinition | null | undefined {
  const spelling = receiver.declaredSpelling ?? receiver.rawName;
  if (site.kind !== 'call' || !spelling.includes('|')) return undefined;
  const names = spelling.split('|').map((arm) => arm.trim());
  // Nullable receivers and nested type expressions have their own narrowing paths.
  if (
    !names.every(
      (name) =>
        /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u.test(name) &&
        name !== 'null' &&
        name !== 'undefined',
    )
  )
    return undefined;
  let first: { owner: SymbolDefinition; method: SymbolDefinition } | undefined;
  const selected: SymbolDefinition[] = [];
  let hasOverloads = false;
  for (const name of names) {
    const owner = findClassBindingInScope(receiver.declaredAtScope, name, indexes, undefined, {
      position: receiver.lookupPosition,
      purpose: 'type',
      uniqueQualifiedNameFallback: false,
    });
    if (!owner) return undefined;
    let method: SymbolDefinition | undefined;
    for (const id of [owner.nodeId, ...indexes.methodDispatch.mroFor(owner.nodeId)]) {
      if (model.fields.lookupAllByOwner(id, site.name).some((field) => !staticOnly(field)))
        return null;
      const methods = model.methods
        .lookupAllByOwner(id, site.name)
        .filter((method) => !staticOnly(method));
      if (!methods.length) continue;
      if (methods.length === 1) {
        method = methods[0];
        if (!method?.declarationRange || method.typeParameters?.length) return null;
        if (
          (site.arity !== 0 || method.parameterCount !== 0) &&
          !selectTsPrimitiveOverload([method], site, indexes)
        )
          return null;
      } else {
        const signatures = methods.filter((candidate) => candidate.isOverloadSignature);
        if (
          signatures.length < 2 ||
          methods.length - signatures.length > 1 ||
          signatures.some((signature) => signature.typeParameters?.length)
        )
          return null;
        hasOverloads = true;
        method = selectTsPrimitiveOverload(signatures, site, indexes) ?? undefined;
      }
      break;
    }
    if (!method?.declarationRange || method.typeParameters?.length) return null;
    selected.push(method);
    // Across files the compiler uses Program source-file order. A path sort
    // or the order of the written union cannot establish that ordering.
    if (first && first.method.filePath !== method.filePath) return null;
    const before = first?.method.declarationRange;
    const { startLine, startCol } = method.declarationRange;
    if (
      !before ||
      startLine < before.startLine ||
      (startLine === before.startLine && startCol < before.startCol)
    )
      first = { owner, method };
  }
  if (!first) return null;
  const representative = first.method;
  if (
    hasOverloads &&
    selected.some(
      (method) => method !== representative && !samePrimitiveSignature(representative, method),
    )
  )
    return null;
  return first.owner;
}
