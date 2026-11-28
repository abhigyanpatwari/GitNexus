import {
  makeScopeId,
  type BindingRef,
  type CallResultAssignmentSite,
  type CallableFlowSite,
  type ParsedFile,
  type Range,
  type ReferenceSite,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type {
  ReceiverMemberResolution,
  ScopeResolver,
} from '../../scope-resolution/contract/scope-resolver.js';
import {
  findAllCallableBindingsInScope,
  findClassBindingInScope,
  findReceiverTypeBinding,
  lookupNameClaim,
} from '../../scope-resolution/scope/walkers.js';
import { narrowOverloadCandidates } from '../../scope-resolution/passes/overload-narrowing.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import {
  callNullModes,
  type CallNullMode,
  overloadNameTable,
  receiverTypeIsOutOfScope,
} from './global-declarations.js';
import {
  acceptsArgumentEvidence,
  callRangeKey,
  isLiteralParameter,
  type ArgumentCompatibility,
  type ArgumentEvidence,
  type CallEvidence,
} from './argument-evidence.js';
import { declarationScope } from './module-kind.js';
import { typeApplicationArguments } from '../../utils/template-arguments.js';
import { acceptsEnum, enumArgument, indexEnumArguments } from './enum-arguments.js';

type Argument = Extract<CallableFlowSite, { kind: 'argument' }>;
const argumentsByCall = new WeakMap<ReferenceSite, Argument[]>();
const evidenceByCall = new WeakMap<ReferenceSite, (ArgumentEvidence | null)[]>();

function isSpreadArgument(arg: ArgumentEvidence | null): arg is { spread: string | null } {
  return typeof arg === 'object' && arg !== null && 'spread' in arg;
}

function hasSpreadArguments(site: ReferenceSite): boolean {
  return evidenceByCall.get(site)?.some(isSpreadArgument) ?? false;
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
export const primitiveTypes: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'null',
  'undefined',
]);

function isNullish(type: string): boolean {
  return type === 'null' || type === 'undefined';
}

type OverloadFamilies = {
  methodOwners: Map<string, Set<string>>;
  functionIds: Set<string>;
  functionNames: Set<string>;
};

function collectFunctionNames(
  bindings: ReadonlyMap<string, readonly BindingRef[]>,
  families: OverloadFamilies,
): void {
  for (const [name, refs] of bindings) {
    if (refs.some(({ def }) => families.functionIds.has(def.nodeId)))
      families.functionNames.add(name);
  }
}

function collectMethodOwner(
  def: SymbolDefinition,
  firstOwner: Map<string, string>,
  methodOwners: Map<string, Set<string>>,
): void {
  if (def.type !== 'Method' || !def.isOverloadSignature || !def.qualifiedName || !def.ownerId)
    return;
  const previous = firstOwner.get(def.qualifiedName);
  if (!previous) {
    firstOwner.set(def.qualifiedName, def.ownerId);
    return;
  }
  const name = simpleQualifiedName(def) ?? '';
  const owners = methodOwners.get(name);
  if (owners) {
    owners.add(previous);
    owners.add(def.ownerId);
  } else {
    methodOwners.set(name, new Set([previous, def.ownerId]));
  }
}

function collectOverloadedFunctionIds(scope: Scope, functionIds: Set<string>): void {
  for (const bindings of scope.bindings.values()) {
    if (!bindings.some(({ def }) => def.type === 'Function' && def.isOverloadSignature)) continue;
    for (const { def } of bindings) {
      if (def.type === 'Function') functionIds.add(def.nodeId);
    }
  }
}

function collectLocalOverloads(file: ParsedFile, families: OverloadFamilies): void {
  const firstOwner = new Map<string, string>();
  let hasFreeSignatures = false;
  for (const def of file.localDefs) {
    if (def.type === 'Function' && def.isOverloadSignature) hasFreeSignatures = true;
    collectMethodOwner(def, firstOwner, families.methodOwners);
  }
  if (!hasFreeSignatures) return;
  for (const scope of file.scopes) collectOverloadedFunctionIds(scope, families.functionIds);
  // Extraction can bind only declarations from this file. Cross-file names
  // arrive through the finalized binding maps below.
  for (const scope of file.scopes) collectFunctionNames(scope.bindings, families);
}

function indexOverloadFamilies(files: readonly ParsedFile[], indexes: ScopeResolutionIndexes) {
  const families: OverloadFamilies = {
    methodOwners: new Map(),
    functionIds: new Set(),
    functionNames: new Set(),
  };
  for (const file of files) collectLocalOverloads(file, families);
  // A lookup can reach an overload only through a spelling bound to a member
  // of its declaration family. Include the implementation since a default
  // import or a re-export can expose just that member under a different name.
  freeOverloadNames.set(indexes.scopeTree, families.functionNames);
  if (families.functionIds.size) {
    for (const bindings of indexes.bindings.values()) collectFunctionNames(bindings, families);
    for (const bindings of indexes.bindingAugmentations.values())
      collectFunctionNames(bindings, families);
    const namespaceTables = new Set(
      Array.from(indexes.namespaceFqnBindings.values(), overloadNameTable),
    );
    for (const bindings of namespaceTables) collectFunctionNames(bindings, families);
    collectFunctionNames(indexes.workspaceFqnBindings, families);
  }
  return families;
}

function indexReferenceCalls(
  sites: readonly ReferenceSite[],
  families: OverloadFamilies,
  argumentFacts?: CallEvidence,
) {
  const hasOverload = sites.some(
    (site) =>
      site.kind === 'call' &&
      (families.methodOwners.has(site.name) ||
        (site.callForm === 'free' && families.functionNames.has(site.name))),
  );
  const calls = hasOverload ? new Map<string, ReferenceSite>() : undefined;
  for (const site of sites) {
    if (site.kind !== 'call') continue;
    if (calls) {
      const key = callRangeKey(site.atRange);
      calls.set(key, site);
      const evidence = argumentFacts?.[key];
      if (evidence) evidenceByCall.set(site, evidence);
    }
    argumentsByCall.delete(site);
    receiverCalls.delete(site);
  }
  return calls;
}

type UsesByScope = Map<string, Map<ScopeId, OverloadUse[]>>;

function assignmentScopes(assignments: readonly CallResultAssignmentSite[]): UsesByScope {
  const usesByScope: UsesByScope = new Map();
  for (const { lhs, inScope } of assignments) {
    let scopes = usesByScope.get(lhs);
    if (!scopes) {
      scopes = new Map();
      usesByScope.set(lhs, scopes);
    }
    if (!scopes.has(inScope)) scopes.set(inScope, []);
  }
  return usesByScope;
}

function recordArgumentUse(
  fact: CallableFlowSite,
  calls: ReadonlyMap<string, ReferenceSite>,
  families: OverloadFamilies,
  usesByScope: UsesByScope,
  indexes: ScopeResolutionIndexes,
): void {
  if (
    fact.kind !== 'argument' ||
    (fact.source.expressionKind !== 'binding' && fact.source.expressionKind !== 'bound-member')
  )
    return;
  const call = calls.get(callRangeKey(fact.callSite));
  if (!call || call.argumentTypes?.[fact.parameterIndex] !== '') return;
  const owners = families.methodOwners.get(call.name);
  if (!owners && !(call.callForm === 'free' && families.functionNames.has(call.name))) return;
  const args = argumentsByCall.get(call);
  if (args) args.push(fact);
  else argumentsByCall.set(call, [fact]);
  if (!owners || fact.source.expressionKind === 'bound-member') return;
  const scopes = usesByScope.get(fact.source.name);
  if (!scopes) return;
  const use = { argument: fact, call, owners };
  let scope = indexes.scopeTree.getScope(fact.source.inScope);
  while (scope) {
    scopes.get(scope.id)?.push(use);
    if (scope.bindings.has(fact.source.name) || scope.lexicalNames?.has(fact.source.name)) break;
    scope = indexes.scopeTree.getParent(scope.id);
  }
}

function chainedReceiver(outer: ReferenceSite, calls: ReadonlyMap<string, ReferenceSite>) {
  const receiver = outer.explicitReceiver?.name;
  if (!receiver?.endsWith(')')) return undefined;
  const { startLine, startCol } = outer.atRange;
  const lines = receiver.split('\n');
  const inner = calls.get(
    callRangeKey({
      startLine,
      startCol,
      endLine: startLine + lines.length - 1,
      endCol: (lines.length === 1 ? startCol : 0) + (lines.at(-1)?.length ?? 0),
    }),
  );
  if (inner && inner !== outer) return { outer, inner };
}

function recordAssignmentUse(
  assignment: CallResultAssignmentSite,
  calls: ReadonlyMap<string, ReferenceSite>,
  families: OverloadFamilies,
  usesByScope: UsesByScope,
): void {
  const outer = calls.get(callRangeKey(assignment.callSite));
  let candidates = outer && families.methodOwners.get(outer.name);
  if (outer?.callForm === 'free') {
    candidates = families.functionNames.has(outer.name) ? families.functionIds : undefined;
  }
  const uses = usesByScope.get(assignment.lhs)?.get(assignment.inScope);
  if (!uses?.length && !candidates?.size) {
    usesByAssignment.delete(assignment);
    return;
  }
  const entry: AssignmentUse = { consumers: uses ?? [] };
  if (outer && candidates?.size) entry.producer = { call: outer, candidates };
  if (outer) {
    const receiver = chainedReceiver(outer, calls);
    if (receiver) entry.chainedReceiver = receiver;
  }
  usesByAssignment.set(assignment, entry);
}

/** Join worker facts after imports and their local aliases have been bound. */
export function indexTsCallArguments(
  files: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const families = indexOverloadFamilies(files, indexes);
  if (!families.methodOwners.size && !families.functionNames.size) return;
  for (const file of files) {
    indexEnumArguments(file, indexes);
    const argumentFacts = declarationScope(file.captureSideChannel)?.callArguments;
    const assignments = file.callResultAssignmentSites ?? [];
    if (!file.callableFlowSites?.length && !assignments.length && !argumentFacts) continue;
    const calls = indexReferenceCalls(file.referenceSites, families, argumentFacts);
    if (!calls) continue;
    const usesByScope = assignmentScopes(assignments);
    for (const fact of file.callableFlowSites ?? [])
      recordArgumentUse(fact, calls, families, usesByScope, indexes);
    for (const assignment of assignments)
      recordAssignmentUse(assignment, calls, families, usesByScope);
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

type EnumArgument = NonNullable<ReturnType<typeof enumArgument>>;
type CallArguments = {
  types: string[];
  evidence?: readonly (ArgumentEvidence | null)[];
  enumArguments?: Map<number, EnumArgument>;
};

type OverloadCheck = {
  call: CallArguments;
  mode: CallNullMode;
  indexes: ScopeResolutionIndexes;
  fieldUndefinedType: () => string | undefined;
};

type ParameterAnnotations = { fixed: readonly string[]; restElement?: string };

function restParameterAnnotations(
  params: readonly string[],
  formals: readonly string[],
  argumentCount: number,
): ParameterAnnotations | false | undefined {
  if (params.length !== formals.length - 1) return undefined;
  const rest = params.at(-1);
  if (!rest) return undefined;
  const fixed = params.slice(0, -1);
  const tuple = fixedPrimitiveTuple(rest);
  if (tuple) {
    const count = fixed.length + tuple.length;
    if (argumentCount > count || (tuple.length > 0 && argumentCount < count)) return false;
    if (argumentCount < fixed.length) return undefined;
    return { fixed: [...fixed, ...tuple] };
  }
  if (!rest.endsWith('[]') || argumentCount < fixed.length) return undefined;
  return { fixed, restElement: rest.slice(0, -2).trim() };
}

/** The receiver-oriented parameterTypes view strips array and generic wrappers.
 * Prefer the written annotation for argument compatibility. */
function parameterAnnotations(
  signature: SymbolDefinition,
  scope: Scope,
  argumentCount: number,
): ParameterAnnotations | false | undefined {
  const params =
    signature.declaredParameterTypes ??
    [...scope.typeBindings.values()]
      .filter((binding) => binding.source === 'parameter-annotation' && binding.bindingRange)
      .sort((a, b) => byPosition(a.bindingRange!, b.bindingRange!))
      .map((binding) => binding.declaredSpelling ?? binding.rawName);
  const formals = signature.parameterTypes;
  if (signature.parameterCount === undefined && formals?.at(-1) === 'params')
    return restParameterAnnotations(params, formals, argumentCount);
  if (params.length === signature.parameterCount) return { fixed: params };
  if (
    formals?.length === signature.parameterCount &&
    formals.every((p) => isLiteralParameter(p) || p.startsWith('{') || p.includes('=>'))
  )
    return { fixed: formals };
  return undefined;
}

function comparablePrimitive(part: string): boolean {
  if (primitiveTypes.has(part) || part === 'unknown' || part === 'any' || part === 'never')
    return true;
  if (!part.endsWith('[]')) return false;
  const element = part.slice(0, -2);
  return primitiveTypes.has(element) || element === 'unknown' || element === 'any';
}

function primitiveUnionAccepts(annotation: string, type: string, looseNull: boolean) {
  const alternatives = annotation.split('|').map((part) => part.trim());
  if (!alternatives.every(comparablePrimitive)) return undefined;
  return alternatives.some(
    (part) =>
      part === type || part === 'unknown' || part === 'any' || (looseNull && part !== 'never'),
  );
}

function acceptsParameter(
  signature: SymbolDefinition,
  scope: ScopeId,
  annotation: string,
  index: number,
  check: OverloadCheck,
): ArgumentCompatibility {
  const { call, mode, indexes, fieldUndefinedType } = check;
  const type = call.types[index];
  if (
    type === 'undefined' &&
    index >= (signature.requiredParameterCount ?? Infinity) &&
    signature.parameterCount !== undefined
  )
    return true;
  const looseNull = mode === 'loose' && isNullish(type);
  if (annotation.startsWith('[') && primitiveTypes.has(type) && fixedPrimitiveTuple(annotation))
    return looseNull;
  if (
    looseNull &&
    (isLiteralParameter(annotation) ||
      annotation === 'object' ||
      annotation === 'void' ||
      /^\{[^{}]*\}$/u.test(annotation) ||
      /^\([^()]*\)\s*=>/u.test(annotation))
  )
    return true;
  const enumValue = call.enumArguments?.get(index);
  const checked = enumValue
    ? acceptsEnum(annotation, enumValue, signature, scope, indexes)
    : acceptsArgumentEvidence(annotation, type, call.evidence?.[index], mode, fieldUndefinedType);
  return checked ?? primitiveUnionAccepts(annotation, type, looseNull);
}

function acceptsPrimitiveArguments(
  signature: SymbolDefinition,
  check: OverloadCheck,
): ArgumentCompatibility {
  if (!signature.declarationRange) return undefined;
  const count = check.call.types.length;
  if (
    (signature.parameterCount !== undefined && count > signature.parameterCount) ||
    count < (signature.requiredParameterCount ?? 0)
  )
    return false;
  const scope = check.indexes.scopeTree.getScope(
    makeScopeId({
      filePath: signature.filePath,
      range: signature.declarationRange,
      kind: 'Function',
    }),
  );
  if (!scope) return undefined;
  const params = parameterAnnotations(signature, scope, count);
  if (params === false) return false;
  if (!params) return undefined;
  let result: ArgumentCompatibility = true;
  for (let index = 0; index < count; index++) {
    const annotation = params.fixed[index] ?? params.restElement;
    if (annotation === undefined) return undefined;
    const checked = acceptsParameter(signature, scope.id, annotation, index, check);
    if (checked === false) return false;
    if (checked === undefined) result = undefined;
    else if (checked === 'assignable' && result === true) result = 'assignable';
  }
  return result;
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

function methodsForArguments(
  owner: SymbolDefinition,
  name: string,
  indexes: ScopeResolutionIndexes,
  model: SemanticModel,
  excludeMember?: (member: SymbolDefinition) => boolean,
): readonly SymbolDefinition[] {
  const methodsOnReceiver = (id: string) => {
    const methods = model.methods.lookupAllByOwner(id, name);
    return excludeMember && methods.length
      ? methods.filter((method) => !excludeMember(method))
      : methods;
  };
  const hasShadowingField = (id: string) =>
    model.fields.lookupAllByOwner(id, name).some((field) => !excludeMember?.(field));
  let methods = methodsOnReceiver(owner.nodeId);
  if (methods.length || hasShadowingField(owner.nodeId)) return methods;
  for (const ancestor of indexes.methodDispatch.mroFor(owner.nodeId)) {
    methods = methodsOnReceiver(ancestor);
    if (methods.length || hasShadowingField(ancestor)) break;
  }
  return methods;
}

export const resolveTsMemberArguments: ScopeResolver['resolveReceiverMember'] = (
  owner,
  name,
  site,
  indexes,
  model,
  excludeMember,
) => {
  if (receiverTypeIsOutOfScope(owner, site, indexes))
    return { kind: 'inapplicable', candidateIds: [] };
  const declarations = interfaceDeclarationOrder(owner, indexes);
  if (declarations) {
    const methods = [...declarations.keys()].flatMap((id) =>
      model.methods.lookupAllByOwner(id, name),
    );
    if (methods.length) return resolveTsOverloadSet(methods, site, indexes, declarations);
  }
  if (
    !site.argumentTypes ||
    (!argumentsByCall.has(site) && !evidenceByCall.has(site) && !site.argumentTypes.some(isNullish))
  )
    return undefined;
  const methods = methodsForArguments(owner, name, indexes, model, excludeMember);
  const signatures = methods.filter((def) => def.isOverloadSignature);
  // Static and instance overload families can share an owner and a spelling.
  if (signatures.length < 2 || methods.length - signatures.length > 1) return undefined;
  const selected = selectProjectOverload(signatures, site, indexes);
  if (selected === 'project-dependent')
    return { kind: 'unknown', candidateIds: signatures.map((sig) => sig.nodeId) };
  if (selected) return { kind: 'resolved', definition: selected };
  if (selected === null)
    return { kind: 'inapplicable', candidateIds: signatures.map((sig) => sig.nodeId) };
  return hasSpreadArguments(site)
    ? { kind: 'unknown', candidateIds: signatures.map((sig) => sig.nodeId) }
    : undefined;
};

export function resolveTsOverloadSet(
  signatures: SymbolDefinition[],
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
  declarations?: ReadonlyMap<string, number>,
): ReceiverMemberResolution {
  const selected = selectProjectOverload(signatures, site, indexes, declarations);
  if (selected === 'project-dependent')
    return { kind: 'unknown', candidateIds: signatures.map((sig) => sig.nodeId) };
  if (selected) return { kind: 'resolved', definition: selected };
  const spread = hasSpreadArguments(site);
  let candidates: readonly SymbolDefinition[] = [];
  if (selected !== null) {
    if (spread) {
      const fixedCount = evidenceByCall.get(site)!.filter((arg) => !isSpreadArgument(arg)).length;
      candidates = signatures.filter(
        (sig) => sig.parameterCount === undefined || fixedCount <= sig.parameterCount,
      );
    } else candidates = narrowOverloadCandidates(signatures, site.arity, site.argumentTypes);
  }
  if (!spread && candidates.length === 1) return { kind: 'resolved', definition: candidates[0] };
  return {
    kind: candidates.length ? 'unknown' : 'inapplicable',
    candidateIds: (candidates.length ? candidates : signatures).map((sig) => sig.nodeId),
  };
}

/** Null means every signature was disproved; undefined means no unique selection is known. */
export function selectTsPrimitiveOverload(
  signatures: SymbolDefinition[],
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
  declarations?: ReadonlyMap<string, number>,
): SymbolDefinition | null | undefined {
  const selected = selectProjectOverload(signatures, site, indexes, declarations);
  return selected === 'project-dependent' ? undefined : selected;
}

function boundCallArguments(
  site: ReferenceSite,
  argumentTypes: readonly string[],
  indexes: ScopeResolutionIndexes,
): CallArguments {
  const types = [...argumentTypes];
  let enumArguments: Map<number, EnumArgument> | undefined;
  for (const { source, parameterIndex } of argumentsByCall.get(site) ?? []) {
    if (source.expressionKind === 'bound-member') {
      const value =
        source.qualifiedName &&
        enumArgument(source.qualifiedName, source.inScope, indexes, source.atRange);
      if (value) {
        enumArguments ??= new Map();
        enumArguments.set(parameterIndex, value);
      }
      continue;
    }
    const binding = findReceiverTypeBinding(source.inScope, source.name, indexes, {
      purpose: 'value',
      position: source.atRange,
    });
    const type = binding?.declaredSpelling ?? binding?.rawName;
    if (type && primitiveTypes.has(type)) types[parameterIndex] = type;
  }
  return { types, evidence: evidenceByCall.get(site), enumArguments };
}

function expandSpreadArguments(
  call: CallArguments,
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
): CallArguments | undefined {
  if (!call.evidence?.some(isSpreadArgument)) return call;
  const types: string[] = [];
  const evidence: (ArgumentEvidence | null)[] = [];
  const enumArguments = call.enumArguments && new Map<number, EnumArgument>();
  for (const [index, arg] of call.evidence.entries()) {
    if (!isSpreadArgument(arg)) {
      const value = call.enumArguments?.get(index);
      if (value) enumArguments?.set(types.length, value);
      types.push(call.types[index]);
      evidence.push(arg);
      continue;
    }
    if (!arg.spread) return undefined;
    const binding = findReceiverTypeBinding(site.inScope, arg.spread, indexes, {
      purpose: 'value',
      position: site.atRange,
    });
    const items = fixedPrimitiveTuple(binding?.declaredSpelling ?? binding?.rawName);
    if (!items) return undefined;
    for (const item of items) {
      types.push(item);
      evidence.push(null);
    }
  }
  return { types, evidence, enumArguments };
}

// The identifier in `{ value: undefined }` can be a typed local binding.
function fieldUndefinedLookup(site: ReferenceSite, indexes: ScopeResolutionIndexes) {
  let shadowType: string | undefined;
  let checked = false;
  return () => {
    if (!checked) {
      const claim = lookupNameClaim(site.inScope, 'undefined', indexes, {
        purpose: 'value',
        position: site.atRange,
      });
      shadowType =
        claim.status === 'absent' && !claim.typeBinding
          ? 'undefined'
          : (claim.typeBinding?.declaredSpelling ?? claim.typeBinding?.rawName);
      checked = true;
    }
    return shadowType;
  };
}

function selectSignature(signatures: SymbolDefinition[], check: OverloadCheck) {
  let firstAssignable: SymbolDefinition | undefined;
  for (const signature of signatures) {
    const applicable = acceptsPrimitiveArguments(signature, check);
    if (applicable === undefined) return undefined;
    if (applicable === true) return signature;
    if (applicable === 'assignable') firstAssignable ??= signature;
  }
  return firstAssignable ?? null;
}

function hasNullishArgument(call: CallArguments) {
  return call.types.some((type, i) => {
    if (isNullish(type)) return true;
    const arg = call.evidence?.[i];
    return (
      typeof arg === 'object' &&
      arg !== null &&
      'fields' in arg &&
      arg.fields.some(([, fieldType]) => isNullish(fieldType))
    );
  });
}

function selectProjectOverload(
  signatures: SymbolDefinition[],
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
  declarations?: ReadonlyMap<string, number>,
): SymbolDefinition | null | undefined | 'project-dependent' {
  if (!site.argumentTypes) return undefined;
  const call = expandSpreadArguments(
    boundCallArguments(site, site.argumentTypes, indexes),
    site,
    indexes,
  );
  if (
    !call?.types.every(
      (type, i) =>
        primitiveTypes.has(type) || call.evidence?.[i] != null || call.enumArguments?.has(i),
    )
  )
    return undefined;
  if (!signatures.every((sig) => sig.filePath === signatures[0].filePath && sig.declarationRange))
    return undefined;
  signatures.sort(
    (a, b) =>
      Number((b.declaredParameterTypes ?? b.parameterTypes)?.some(isLiteralParameter) ?? false) -
        Number((a.declaredParameterTypes ?? a.parameterTypes)?.some(isLiteralParameter) ?? false) ||
      (declarations?.get(a.ownerId ?? '') ?? 0) - (declarations?.get(b.ownerId ?? '') ?? 0) ||
      byPosition(a.declarationRange!, b.declarationRange!),
  );
  const modes = callNullModes(site, indexes);
  const fieldUndefinedType = fieldUndefinedLookup(site, indexes);
  const select = (mode: CallNullMode) =>
    selectSignature(signatures, { call, mode, indexes, fieldUndefinedType });
  const first = select(modes[0]);
  if (modes.length === 1 || !hasNullishArgument(call)) return first;
  return modes.every((mode) => mode === modes[0] || select(mode) === first)
    ? first
    : 'project-dependent';
}
