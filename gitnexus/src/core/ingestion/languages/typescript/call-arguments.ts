import {
  makeScopeId,
  type BindingRef,
  type CallResultAssignmentSite,
  type CallableFlowSite,
  type ParsedFile,
  type Range,
  type ReferenceSite,
  type ScopeId,
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
import {
  acceptsArgumentEvidence,
  callRangeKey,
  isLiteralParameter,
  type ArgumentEvidence,
} from './argument-evidence.js';
import { declarationScope } from './module-kind.js';
import { typeApplicationArguments } from '../../utils/template-arguments.js';
import { acceptsEnum, enumArgument, indexEnumArguments } from './enum-arguments.js';

type Argument = Extract<CallableFlowSite, { kind: 'argument' }>;
const argumentsByCall = new WeakMap<ReferenceSite, Argument[]>();
const evidenceByCall = new WeakMap<ReferenceSite, (ArgumentEvidence | null)[]>();

export function hasSpreadArguments(site: ReferenceSite): boolean {
  return (
    evidenceByCall
      .get(site)
      ?.some((arg) => arg !== null && typeof arg === 'object' && 'spread' in arg) === true
  );
}
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
    indexEnumArguments(file, indexes);
    const argumentFacts = declarationScope(file.captureSideChannel)?.callArguments;
    if (
      !file.callableFlowSites?.length &&
      !file.callResultAssignmentSites?.length &&
      !argumentFacts
    )
      continue;
    const calls = new Map<string, ReferenceSite>();
    const hasOverload = file.referenceSites.some(
      (site) =>
        site.kind === 'call' &&
        (overloads.has(site.name) || (site.callForm === 'free' && names.has(site.name))),
    );
    for (const site of file.referenceSites) {
      if (site.kind !== 'call') continue;
      if (hasOverload) {
        const key = callRangeKey(site.atRange);
        calls.set(key, site);
        const evidence = argumentFacts?.[key];
        if (evidence) evidenceByCall.set(site, evidence);
      }
      argumentsByCall.delete(site);
      receiverCalls.delete(site);
    }
    if (!hasOverload) continue;
    const usesByScope = new Map<string, Map<ScopeId, OverloadUse[]>>();
    for (const { lhs, inScope } of file.callResultAssignmentSites ?? []) {
      let scopes = usesByScope.get(lhs);
      if (!scopes) {
        scopes = new Map();
        usesByScope.set(lhs, scopes);
      }
      if (!scopes.has(inScope)) scopes.set(inScope, []);
    }
    for (const fact of file.callableFlowSites ?? []) {
      if (
        fact.kind !== 'argument' ||
        (fact.source.expressionKind !== 'binding' && fact.source.expressionKind !== 'bound-member')
      )
        continue;
      const call = calls.get(rangeKey(fact.callSite));
      if (!call || call.argumentTypes?.[fact.parameterIndex] !== '') continue;
      const owners = overloads.get(call.name);
      if (!owners && !(call.callForm === 'free' && names.has(call.name))) continue;
      const args = argumentsByCall.get(call);
      if (args) args.push(fact);
      else argumentsByCall.set(call, [fact]);
      if (fact.source.expressionKind === 'bound-member') continue;
      if (!owners) continue;
      const scopes = usesByScope.get(fact.source.name);
      if (!scopes) continue;
      const use = { argument: fact, call, owners };
      let scope = indexes.scopeTree.getScope(fact.source.inScope);
      while (scope) {
        scopes.get(scope.id)?.push(use);
        if (scope.bindings.has(fact.source.name) || scope.lexicalNames?.has(fact.source.name))
          break;
        scope = indexes.scopeTree.getParent(scope.id);
      }
    }
    for (const assignment of file.callResultAssignmentSites ?? []) {
      const outer = calls.get(rangeKey(assignment.callSite));
      let candidates = outer && overloads.get(outer.name);
      if (outer?.callForm === 'free') {
        candidates = names.has(outer.name) ? overloadedFunctions : undefined;
      }
      const uses = usesByScope.get(assignment.lhs)?.get(assignment.inScope);
      if (!uses?.length && !candidates?.size) {
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
      let scope = indexes.scopeTree.getScope(source.inScope);
      while (scope) {
        if (scope.id === assignment.inScope) return matchesOverloadOwner(call, owners, indexes);
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

/** A tuple with a statically known length and primitive element types. */
function fixedPrimitiveTuple(spelling?: string): string[] | undefined {
  const tuple = spelling?.replace(/^readonly\s+/u, '').trim();
  if (!tuple?.startsWith('[') || !tuple.endsWith(']')) return undefined;
  if (/^\[\s*\]$/u.test(tuple)) return [];
  const items = typeApplicationArguments(tuple);
  return items?.every((item) => primitiveTypes.has(item)) ? items : undefined;
}

/** For primitive arguments, compare the written parameter annotation. The
 * receiver-oriented parameterTypes view strips array and generic wrappers. */
function acceptsPrimitiveArguments(
  signature: SymbolDefinition,
  types: string[],
  indexes: ScopeResolutionIndexes,
  evidence?: readonly (ArgumentEvidence | null)[],
  enumArguments?: ReadonlyMap<number, NonNullable<ReturnType<typeof enumArgument>>>,
): boolean | undefined {
  if (!signature.declarationRange) return undefined;
  const formals = signature.parameterTypes;
  if (
    (signature.parameterCount !== undefined && types.length > signature.parameterCount) ||
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
  const params = [...scope.typeBindings.values()]
    .filter((binding) => binding.source === 'parameter-annotation' && binding.bindingRange)
    .sort((a, b) => byPosition(a.bindingRange!, b.bindingRange!))
    .map((binding) => binding.declaredSpelling ?? binding.rawName);
  let annotations: readonly string[];
  let restElement: string | undefined;
  if (signature.parameterCount === undefined && formals?.at(-1) === 'params') {
    if (params.length !== formals.length - 1) return undefined;
    const rest = params.pop();
    if (!rest) return undefined;
    const tuple = fixedPrimitiveTuple(rest);
    if (tuple) {
      const count = params.length + tuple.length;
      if (types.length > count || (tuple.length > 0 && types.length < count)) return false;
      if (types.length < params.length) return undefined;
      annotations = [...params, ...tuple];
    } else {
      if (!rest.endsWith('[]') || types.length < params.length) return undefined;
      restElement = rest.slice(0, -2).trim();
      annotations = params;
    }
  } else if (params.length === signature.parameterCount) {
    annotations = params;
  } else if (
    signature.parameterTypes?.length === signature.parameterCount &&
    signature.parameterTypes.every(
      (p) => isLiteralParameter(p) || p.startsWith('{') || p.includes('=>'),
    )
  ) {
    annotations = signature.parameterTypes;
  } else return undefined;
  let unknown = false;
  for (const [i, type] of types.entries()) {
    const annotation = annotations[i] ?? restElement;
    if (annotation === undefined) return undefined;
    if (annotation.startsWith('[') && primitiveTypes.has(type) && fixedPrimitiveTuple(annotation))
      return false;
    const enumValue = enumArguments?.get(i);
    const checked = enumValue
      ? acceptsEnum(annotation, enumValue, signature, scope.id, indexes)
      : acceptsArgumentEvidence(annotation, type, evidence?.[i]);
    if (checked === false) return false;
    if (checked === true) continue;
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
      const candidates = hasSpreadArguments(site)
        ? methods
        : narrowOverloadCandidates(methods, site.arity, site.argumentTypes);
      if (candidates.length === 1) return { kind: 'resolved', definition: candidates[0] };
      return {
        kind: candidates.length ? 'unknown' : 'inapplicable',
        candidateIds: (candidates.length ? candidates : methods).map((method) => method.nodeId),
      };
    }
  }
  if ((!argumentsByCall.has(site) && !evidenceByCall.has(site)) || !site.argumentTypes)
    return undefined;
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
  if (selected) return { kind: 'resolved', definition: selected };
  return hasSpreadArguments(site)
    ? { kind: 'unknown', candidateIds: signatures.map((sig) => sig.nodeId) }
    : undefined;
};

/** Compare written primitive annotations in declaration order for one overload family. */
export function selectTsPrimitiveOverload(
  signatures: SymbolDefinition[],
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
  declarations?: ReadonlyMap<string, number>,
): SymbolDefinition | undefined {
  if (!site.argumentTypes) return undefined;
  let types = [...site.argumentTypes];
  let enumArguments: Map<number, NonNullable<ReturnType<typeof enumArgument>>> | undefined;
  for (const { source, parameterIndex } of argumentsByCall.get(site) ?? []) {
    if (source.expressionKind === 'bound-member') {
      const value =
        source.qualifiedName &&
        enumArgument(source.qualifiedName, source.inScope, indexes, source.atRange);
      if (value) (enumArguments ??= new Map()).set(parameterIndex, value);
      continue;
    }
    const binding = findReceiverTypeBinding(source.inScope, source.name, indexes, {
      purpose: 'value',
      position: source.atRange,
    });
    const type = binding?.declaredSpelling ?? binding?.rawName;
    if (type && primitiveTypes.has(type)) types[parameterIndex] = type;
  }
  let evidence = evidenceByCall.get(site);
  if (evidence && hasSpreadArguments(site)) {
    const expandedTypes: string[] = [];
    const expandedEvidence: (ArgumentEvidence | null)[] = [];
    const expandedEnums =
      enumArguments && new Map<number, NonNullable<ReturnType<typeof enumArgument>>>();
    for (const [index, arg] of evidence.entries()) {
      if (arg !== null && typeof arg === 'object' && 'spread' in arg) {
        if (!arg.spread) return undefined;
        const binding = findReceiverTypeBinding(site.inScope, arg.spread, indexes, {
          purpose: 'value',
          position: site.atRange,
        });
        const items = fixedPrimitiveTuple(binding?.declaredSpelling ?? binding?.rawName);
        if (!items) return undefined;
        for (const item of items) {
          expandedTypes.push(item);
          expandedEvidence.push(null);
        }
      } else {
        const value = enumArguments?.get(index);
        if (value) expandedEnums?.set(expandedTypes.length, value);
        expandedTypes.push(types[index]);
        expandedEvidence.push(arg);
      }
    }
    types = expandedTypes;
    evidence = expandedEvidence;
    enumArguments = expandedEnums;
  }
  if (
    !types.every(
      (type, i) => primitiveTypes.has(type) || evidence?.[i] != null || enumArguments?.has(i),
    )
  )
    return undefined;
  if (!signatures.every((sig) => sig.filePath === signatures[0].filePath && sig.declarationRange))
    return undefined;
  signatures.sort(
    (a, b) =>
      Number(b.parameterTypes?.some(isLiteralParameter) ?? false) -
        Number(a.parameterTypes?.some(isLiteralParameter) ?? false) ||
      (declarations?.get(a.ownerId ?? '') ?? 0) - (declarations?.get(b.ownerId ?? '') ?? 0) ||
      byPosition(a.declarationRange!, b.declarationRange!),
  );
  for (const signature of signatures) {
    const applicable = acceptsPrimitiveArguments(
      signature,
      types,
      indexes,
      evidence,
      enumArguments,
    );
    if (applicable === undefined) return undefined;
    if (applicable) return signature;
  }
  return undefined;
}
