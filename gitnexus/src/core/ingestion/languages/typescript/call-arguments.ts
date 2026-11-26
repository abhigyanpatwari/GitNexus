import {
  makeScopeId,
  type BindingRef,
  type CallResultAssignmentSite,
  type CallableFlowSite,
  type ParsedFile,
  type Range,
  type ReferenceSite,
  type SymbolDefinition,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import {
  findAllCallableBindingsInScope,
  findClassBindingInScope,
  findReceiverTypeBinding,
} from '../../scope-resolution/scope/walkers.js';
import { narrowOverloadCandidates } from '../../scope-resolution/passes/overload-narrowing.js';
import { receiverTypeIsOutOfScope } from './global-declarations.js';

type Argument = Extract<CallableFlowSite, { kind: 'argument' }>;
const argumentsByCall = new WeakMap<ReferenceSite, Argument[]>();
const receiverCalls = new WeakMap<ReferenceSite, ReferenceSite>();
type OverloadUse = { argument: Argument; call: ReferenceSite; owners: ReadonlySet<string> };
type AssignmentUse = {
  consumers: OverloadUse[];
  producer?: { call: ReferenceSite; candidates: ReadonlySet<string> };
  chainedReceiver?: { outer: ReferenceSite; inner: ReferenceSite };
};
const usesByAssignment = new WeakMap<CallResultAssignmentSite, AssignmentUse>();
const freeOverloadNames = new WeakMap<ScopeResolutionIndexes['scopeTree'], ReadonlySet<string>>();

export function mayCallTsFunctionOverload(name: string, indexes: ScopeResolutionIndexes): boolean {
  return freeOverloadNames.get(indexes.scopeTree)?.has(name) ?? true;
}
const primitiveTypes = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'null',
  'undefined',
]);

function rangeKey(range: Range): string {
  return `${range.startLine}:${range.startCol}-${range.endLine}:${range.endCol}`;
}

/** Join worker facts after imports and their local aliases have been bound. */
export function indexTsCallArguments(
  files: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const overloads = new Map<string, Set<string>>();
  const overloadedFunctions = new Set<string>();
  const names = new Set<string>();
  const collectNames = (bindings: ReadonlyMap<string, readonly BindingRef[]>) => {
    for (const [name, refs] of bindings) {
      if (refs.some(({ def }) => overloadedFunctions.has(def.nodeId))) names.add(name);
    }
  };
  for (const file of files) {
    const firstOwner = new Map<string, string>();
    let hasFreeSignatures = false;
    for (const def of file.localDefs) {
      if (def.type === 'Function' && def.isOverloadSignature) hasFreeSignatures = true;
      if (def.type !== 'Method' || !def.isOverloadSignature || !def.qualifiedName || !def.ownerId)
        continue;
      const previous = firstOwner.get(def.qualifiedName);
      if (previous) {
        const name = def.qualifiedName.slice(def.qualifiedName.lastIndexOf('.') + 1);
        const owners = overloads.get(name);
        if (owners) {
          owners.add(previous);
          owners.add(def.ownerId);
        } else {
          overloads.set(name, new Set([previous, def.ownerId]));
        }
      } else {
        firstOwner.set(def.qualifiedName, def.ownerId);
      }
    }
    if (hasFreeSignatures) {
      for (const scope of file.scopes) {
        for (const bindings of scope.bindings.values()) {
          if (bindings.some(({ def }) => def.type === 'Function' && def.isOverloadSignature)) {
            for (const { def } of bindings)
              if (def.type === 'Function') overloadedFunctions.add(def.nodeId);
          }
        }
      }
      // Extraction can bind only declarations from this file. Cross-file
      // names arrive through the finalized binding maps below.
      for (const scope of file.scopes) collectNames(scope.bindings);
    }
  }
  // A lookup can reach an overload only through a spelling bound to a member
  // of its declaration family. Include the implementation since a default
  // import or a re-export can expose just that member under a different name.
  freeOverloadNames.set(indexes.scopeTree, names);
  if (overloadedFunctions.size) {
    for (const bindings of indexes.bindings.values()) collectNames(bindings);
    for (const bindings of indexes.bindingAugmentations.values()) collectNames(bindings);
    for (const bindings of indexes.namespaceFqnBindings.values()) collectNames(bindings);
    collectNames(indexes.workspaceFqnBindings);
  }
  if (!overloads.size && !names.size) return;
  for (const file of files) {
    if (!file.callableFlowSites?.length && !file.callResultAssignmentSites?.length) continue;
    const calls = new Map<string, ReferenceSite>();
    const usesByName = new Map<string, OverloadUse[]>();
    const hasOverload = file.referenceSites.some(
      (site) =>
        site.kind === 'call' &&
        (overloads.has(site.name) || (site.callForm === 'free' && names.has(site.name))),
    );
    for (const site of file.referenceSites) {
      if (site.kind !== 'call') continue;
      if (hasOverload) calls.set(rangeKey(site.atRange), site);
      argumentsByCall.delete(site);
      receiverCalls.delete(site);
    }
    if (!hasOverload) continue;
    for (const fact of file.callableFlowSites ?? []) {
      if (fact.kind !== 'argument' || fact.source.expressionKind !== 'binding') continue;
      const call = calls.get(rangeKey(fact.callSite));
      if (!call || call.argumentTypes?.[fact.parameterIndex] !== '') continue;
      const owners = overloads.get(call.name);
      if (!owners && !(call.callForm === 'free' && names.has(call.name))) continue;
      const args = argumentsByCall.get(call);
      if (args) args.push(fact);
      else argumentsByCall.set(call, [fact]);
      if (!owners) continue;
      const uses = usesByName.get(fact.source.name);
      const use = { argument: fact, call, owners };
      if (uses) uses.push(use);
      else usesByName.set(fact.source.name, [use]);
    }
    for (const assignment of file.callResultAssignmentSites ?? []) {
      const outer = calls.get(rangeKey(assignment.callSite));
      let candidates = outer && overloads.get(outer.name);
      if (outer?.callForm === 'free') {
        candidates = names.has(outer.name) ? overloadedFunctions : undefined;
      }
      const uses = usesByName.get(assignment.lhs);
      if (!uses && !candidates?.size) {
        usesByAssignment.delete(assignment);
        continue;
      }
      const entry: AssignmentUse = { consumers: uses ?? [] };
      if (outer && candidates?.size) entry.producer = { call: outer, candidates };
      usesByAssignment.set(assignment, entry);
      if (!outer) continue;
      const receiver = outer.explicitReceiver?.name;
      if (!receiver?.endsWith(')')) continue;
      const { startLine, startCol } = outer.atRange;
      const lines = receiver.split('\n');
      const inner = calls.get(
        rangeKey({
          startLine,
          startCol,
          endLine: startLine + lines.length - 1,
          endCol: (lines.length === 1 ? startCol : 0) + lines.at(-1)!.length,
        }),
      );
      if (inner && inner !== outer) {
        entry.chainedReceiver = { outer, inner };
      }
    }
  }
}

/** Resolve a factory’s return annotation in the scope that declared it. */
function chainedReceiverOwner(inner: ReferenceSite, indexes: ScopeResolutionIndexes) {
  if (inner.callForm === 'constructor' && !inner.explicitReceiver) {
    return findClassBindingInScope(inner.inScope, inner.name, indexes, undefined, {
      purpose: 'value',
      position: inner.atRange,
      uniqueQualifiedNameFallback: false,
    });
  }
  if (inner.callForm !== 'free') return undefined;
  const definitions = findAllCallableBindingsInScope(inner.inScope, inner.name, indexes, {
    purpose: 'value',
    position: inner.atRange,
    callee: true,
  });
  if (definitions.length !== 1) return undefined;
  const [factory] = definitions;
  if (factory.type !== 'Function' || !factory.returnType || !factory.declarationRange)
    return undefined;
  const scope = makeScopeId({
    filePath: factory.filePath,
    range: factory.declarationRange,
    kind: 'Function',
  });
  return findClassBindingInScope(scope, factory.returnType, indexes, undefined, {
    purpose: 'type',
    position: factory.declarationRange,
    uniqueQualifiedNameFallback: false,
  });
}

function matchesOverloadOwner(
  call: ReferenceSite,
  owners: ReadonlySet<string>,
  indexes: ScopeResolutionIndexes,
  inner?: ReferenceSite,
): boolean {
  const receiver = call.explicitReceiver?.name;
  if (!receiver) return false;
  const type =
    !inner &&
    findReceiverTypeBinding(call.inScope, receiver, indexes, {
      purpose: 'value',
      position: call.atRange,
    });
  const owner = inner
    ? chainedReceiverOwner(inner, indexes)
    : type &&
      findClassBindingInScope(type.declaredAtScope, type.rawName, indexes, undefined, {
        purpose: type.lookupPurpose ?? 'type',
        position: type.lookupPosition,
        uniqueQualifiedNameFallback: false,
      });
  return (
    !!owner &&
    [owner.nodeId, ...indexes.methodDispatch.mroFor(owner.nodeId)].some((id) => owners.has(id))
  );
}

export const tsCallResultAssignmentApplies: ScopeResolver['callResultAssignmentApplies'] = (
  assignment,
  indexes,
) => {
  const entry = usesByAssignment.get(assignment);
  if (!entry) return false;
  const producer = entry.producer;
  const overloadedReturn =
    producer &&
    (producer.call.callForm === 'free'
      ? findAllCallableBindingsInScope(producer.call.inScope, producer.call.name, indexes, {
          purpose: 'value',
          position: producer.call.atRange,
          callee: true,
        }).some((def) => producer.candidates.has(def.nodeId))
      : matchesOverloadOwner(
          producer.call,
          producer.candidates,
          indexes,
          entry.chainedReceiver?.inner,
        ));
  const applies =
    overloadedReturn ||
    entry.consumers.some(({ argument: { source }, call, owners }) => {
      if (!matchesOverloadOwner(call, owners, indexes)) return false;
      let scope = indexes.scopeTree.getScope(source.inScope);
      while (scope) {
        if (scope.id === assignment.inScope) return true;
        if (
          scope.bindings.has(source.name) ||
          scope.typeBindings.has(source.name) ||
          scope.lexicalNames?.has(source.name)
        )
          return false;
        scope = indexes.scopeTree.getParent(scope.id);
      }
      return false;
    });
  if (applies && entry.chainedReceiver && entry.chainedReceiver.inner.callForm !== 'constructor') {
    const { outer, inner } = entry.chainedReceiver;
    receiverCalls.set(outer, inner);
  }
  return applies;
};

export const tsReceiverCallSite: ScopeResolver['receiverCallSite'] = (site) => {
  const receiver = receiverCalls.get(site);
  return receiver && { name: receiver.name, range: receiver.atRange };
};

function byPosition(a: Range, b: Range): number {
  return a.startLine - b.startLine || a.startCol - b.startCol;
}

/** For primitive arguments, compare the written parameter annotation. The
 * receiver-oriented parameterTypes view strips array and generic wrappers. */
function acceptsPrimitiveArguments(
  signature: SymbolDefinition,
  types: string[],
  indexes: ScopeResolutionIndexes,
): boolean | undefined {
  if (signature.parameterCount === undefined || !signature.declarationRange) return undefined;
  if (
    types.length > signature.parameterCount ||
    types.length < (signature.requiredParameterCount ?? 0)
  )
    return false;
  const scope = indexes.scopeTree.getScope(
    makeScopeId({
      filePath: signature.filePath,
      range: signature.declarationRange,
      kind: 'Function',
    }),
  );
  if (!scope) return undefined;
  const params = [...scope.typeBindings.values()].filter(
    (binding) => binding.source === 'parameter-annotation' && binding.bindingRange,
  );
  if (params.length !== signature.parameterCount) return undefined;
  params.sort((a, b) => byPosition(a.bindingRange!, b.bindingRange!));
  let unknown = false;
  for (const [i, type] of types.entries()) {
    const annotation = params[i].declaredSpelling ?? params[i].rawName;
    const alternatives = annotation.split('|').map((part) => part.trim());
    if (
      !alternatives.every(
        (part) =>
          primitiveTypes.has(part) ||
          part === 'unknown' ||
          part === 'any' ||
          part === 'never' ||
          (part.endsWith('[]') && primitiveTypes.has(part.slice(0, -2))),
      )
    ) {
      unknown = true;
      continue;
    }
    if (alternatives.some((part) => part === type || part === 'unknown' || part === 'any'))
      continue;
    return false;
  }
  return unknown ? undefined : true;
}

/** Later interface declarations contribute their overload group first. */
function interfaceDeclarationOrder(
  owner: SymbolDefinition,
  indexes: ScopeResolutionIndexes,
): Map<string, number> | undefined {
  if (owner.type !== 'Interface' || !owner.declarationRange || !owner.qualifiedName) return;
  const scope = makeScopeId({
    filePath: owner.filePath,
    range: owner.declarationRange,
    kind: 'Class',
  });
  const name = owner.qualifiedName.slice(owner.qualifiedName.lastIndexOf('.') + 1);
  const bindings = indexes.scopeTree.getParent(scope)?.bindings.get(name);
  if (!bindings || bindings.length < 2) return;
  const siblings = bindings
    .map(({ def }) => def)
    .filter(
      (def) => def.type === 'Interface' && def.filePath === owner.filePath && def.declarationRange,
    );
  if (siblings.length < 2 || !siblings.some((def) => def.nodeId === owner.nodeId)) return;
  siblings.sort((a, b) => byPosition(b.declarationRange!, a.declarationRange!));
  return new Map(siblings.map((def, order) => [def.nodeId, order]));
}

export const resolveTsMemberArguments: ScopeResolver['resolveReceiverMember'] = (
  owner,
  name,
  site,
  indexes,
  model,
) => {
  if (receiverTypeIsOutOfScope(owner, site, indexes))
    return { kind: 'inapplicable', candidateIds: [] };
  const declarations = interfaceDeclarationOrder(owner, indexes);
  if (declarations) {
    const methods = [...declarations.keys()].flatMap((id) =>
      model.methods.lookupAllByOwner(id, name),
    );
    if (methods.length) {
      const selected = selectTsPrimitiveOverload(methods, site, indexes, declarations);
      if (selected) return { kind: 'resolved', definition: selected };
      const candidates = narrowOverloadCandidates(methods, site.arity, site.argumentTypes);
      if (candidates.length === 1) return { kind: 'resolved', definition: candidates[0] };
      return {
        kind: candidates.length ? 'unknown' : 'inapplicable',
        candidateIds: (candidates.length ? candidates : methods).map((method) => method.nodeId),
      };
    }
  }
  if (!argumentsByCall.has(site) || !site.argumentTypes) return undefined;
  let methods = model.methods.lookupAllByOwner(owner.nodeId, name);
  if (!methods.length) {
    if (model.fields.lookupAllByOwner(owner.nodeId, name).length) return undefined;
    for (const ancestor of indexes.methodDispatch.mroFor(owner.nodeId)) {
      methods = model.methods.lookupAllByOwner(ancestor, name);
      if (methods.length) break;
      if (model.fields.lookupAllByOwner(ancestor, name).length) return undefined;
    }
  }
  const signatures = methods.filter((def) => def.isOverloadSignature);
  // Static and instance overload families can share an owner and a spelling.
  if (signatures.length < 2 || methods.length - signatures.length > 1) return undefined;
  const selected = selectTsPrimitiveOverload(signatures, site, indexes);
  return selected && { kind: 'resolved', definition: selected };
};

/** Compare written primitive annotations in declaration order for one overload family. */
export function selectTsPrimitiveOverload(
  signatures: SymbolDefinition[],
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
  declarations?: ReadonlyMap<string, number>,
): SymbolDefinition | undefined {
  if (!site.argumentTypes) return undefined;
  const types = [...site.argumentTypes];
  for (const { source, parameterIndex } of argumentsByCall.get(site) ?? []) {
    const binding = findReceiverTypeBinding(source.inScope, source.name, indexes, {
      purpose: 'value',
      position: source.atRange,
    });
    const type = binding?.declaredSpelling ?? binding?.rawName;
    if (type && primitiveTypes.has(type)) types[parameterIndex] = type;
  }
  if (!types.every((type) => primitiveTypes.has(type))) return undefined;
  if (!signatures.every((sig) => sig.filePath === signatures[0].filePath && sig.declarationRange))
    return undefined;
  signatures.sort(
    (a, b) =>
      (declarations?.get(a.ownerId ?? '') ?? 0) - (declarations?.get(b.ownerId ?? '') ?? 0) ||
      byPosition(a.declarationRange!, b.declarationRange!),
  );
  for (const signature of signatures) {
    const applicable = acceptsPrimitiveArguments(signature, types, indexes);
    if (applicable === undefined) return undefined;
    if (applicable) return signature;
  }
  return undefined;
}
