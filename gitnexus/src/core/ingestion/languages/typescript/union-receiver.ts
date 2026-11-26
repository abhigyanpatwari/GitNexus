import type { ReferenceSite, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import { findClassBindingInScope } from '../../scope-resolution/scope/walkers.js';
import { selectTsPrimitiveOverload } from './call-arguments.js';

/** The checker takes the first compatible signature from its ordered union of
 * member types. For equally named methods in one file, declaration position
 * determines that order, including methods inherited from a base class. */
export function representativeUnionOwner(
  receiver: TypeRef,
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
  model: SemanticModel,
  staticOnly: (method: SymbolDefinition) => boolean,
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
  for (const name of names) {
    const owner = findClassBindingInScope(receiver.declaredAtScope, name, indexes, undefined, {
      position: receiver.lookupPosition,
      purpose: 'type',
      uniqueQualifiedNameFallback: false,
    });
    if (!owner) return undefined;
    let method: SymbolDefinition | undefined;
    for (const id of [owner.nodeId, ...indexes.methodDispatch.mroFor(owner.nodeId)]) {
      if (model.fields.lookupAllByOwner(id, site.name).length) return null;
      const methods = model.methods.lookupAllByOwner(id, site.name);
      if (!methods.length) continue;
      if (methods.length !== 1 || staticOnly(methods[0])) return null;
      method = methods[0];
      break;
    }
    if (!method?.declarationRange || method.typeParameters?.length) return null;
    if (site.arity !== 0 || method.parameterCount !== 0) {
      if (!selectTsPrimitiveOverload([method], site, indexes)) return null;
    }
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
  return first?.owner ?? null;
}
