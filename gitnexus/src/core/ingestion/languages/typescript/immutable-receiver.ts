import {
  makeScopeId,
  type ParsedFile,
  type ReferenceSite,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  findClassBindingInScope,
  findReceiverTypeBinding,
} from '../../scope-resolution/scope/walkers.js';
import { declarationScope } from './module-kind.js';

const constructions = new WeakMap<TypeRef, string>();
const candidateCalls = new WeakSet<ReferenceSite>();

export function indexImmutableReceivers(file: ParsedFile) {
  const facts = declarationScope(file.captureSideChannel)?.constructions;
  if (!facts?.length) return;
  const names = new Set(facts.map((fact) => fact.name));
  const byPosition = new Map(facts.map((fact) => [`${fact.line}:${fact.column}`, fact]));
  for (const scope of file.scopes) {
    for (const [name, binding] of scope.typeBindings) {
      if (binding.source !== 'annotation' || !names.has(name) || !binding.bindingRange) continue;
      const fact = byPosition.get(
        `${binding.bindingRange.startLine}:${binding.bindingRange.startCol}`,
      );
      if (fact?.name === name) constructions.set(binding, fact.className);
    }
  }
  for (const site of file.referenceSites) {
    if (
      site.callForm === 'member' &&
      site.explicitReceiver &&
      names.has(site.explicitReceiver.name)
    )
      candidateCalls.add(site);
  }
}

/** Use a const initializer only when the annotated hierarchy has no member at that spelling. */
export function immutableReceiverMethod(
  owner: SymbolDefinition,
  name: string,
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
  model: SemanticModel,
) {
  if (!candidateCalls.has(site) || !site.explicitReceiver) return;
  const binding = findReceiverTypeBinding(site.inScope, site.explicitReceiver.name, indexes, {
    purpose: 'value',
    position: site.atRange,
  });
  const className = binding && constructions.get(binding);
  if (!binding || !className || owner.qualifiedName !== binding.rawName) return;
  for (const id of [owner.nodeId, ...indexes.methodDispatch.mroFor(owner.nodeId)]) {
    if (
      model.methods.lookupAllByOwner(id, name).length ||
      model.fields.lookupAllByOwner(id, name).length
    )
      return;
  }
  const actual = findClassBindingInScope(binding.declaredAtScope, className, indexes, undefined, {
    purpose: 'value',
    position: binding.lookupPosition,
    uniqueQualifiedNameFallback: false,
  });
  if (actual?.type !== 'Class') return;
  const hierarchy = [actual.nodeId, ...indexes.methodDispatch.mroFor(actual.nodeId)];
  // An explicit constructor may return a different object.
  if (hierarchy.some((id) => model.methods.lookupAllByOwner(id, 'constructor').length)) return;
  for (const id of hierarchy) {
    if (model.fields.lookupAllByOwner(id, name).length) return;
    const methods = model.methods.lookupAllByOwner(id, name);
    if (!methods.length) continue;
    const method = methods[0];
    if (methods.length !== 1 || !method.declarationRange) return;
    const scope = indexes.scopeTree.getScope(
      makeScopeId({ filePath: method.filePath, range: method.declarationRange, kind: 'Function' }),
    );
    if (scope?.typeBindings.get('this')?.source === 'self') return method;
    return;
  }
}
