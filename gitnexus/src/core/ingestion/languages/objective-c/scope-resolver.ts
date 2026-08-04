import type { ParsedFile, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';

import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cArityCompatibility } from '../c/arity.js';
import { cMergeBindings } from '../c/merge-bindings.js';
import { clearStaticNames, expandCWildcardNames, isStaticName } from '../c/static-linkage.js';
import { objectiveCProvider } from '../objective-c.js';
import { applyObjectiveCCaptureSideChannel } from './capture-side-channel.js';
import { populateObjectiveCWorkspaceOwners } from './ownership.js';
import { emitObjectiveCSourceSiteEdges } from './relationships.js';
import { resolveObjectiveCImportClosure } from './import-closure.js';
import { resolveObjectiveCImportTarget } from './import-target.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { parseObjectiveCTypeDescriptor } from './type-semantics.js';

type ObjectiveCResolutionScopes = Parameters<
  NonNullable<ScopeResolver['resolveReceiverMember']>
>[3];

const MAX_PROTOCOL_HIERARCHY_SIZE = 256;
const MAX_PROTOCOL_CONTRACT_TYPE_LENGTH = 4_096;
const OBJECTIVE_C_IDENTIFIER = /^[_\p{ID_Start}][_\p{ID_Continue}\u200C\u200D]*$/u;

function annotationValue(definition: SymbolDefinition, prefix: string): string | undefined {
  return definition.annotations
    ?.find((annotation) => annotation.startsWith(prefix))
    ?.slice(prefix.length);
}

function objectiveCDeclaredProtocolParents(
  definition: SymbolDefinition,
): readonly string[] | undefined {
  const encoded = annotationValue(definition, 'objc:protocol-parents:');
  if (encoded === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!Array.isArray(parsed) || parsed.length > MAX_PROTOCOL_HIERARCHY_SIZE) return undefined;
    const parents: string[] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 512 ||
        !OBJECTIVE_C_IDENTIFIER.test(value) ||
        seen.has(value)
      ) {
        return undefined;
      }
      seen.add(value);
      parents.push(value);
    }
    return parents;
  } catch {
    return undefined;
  }
}

function objectiveCDeclaredMemberCandidates(
  ownerId: string,
  signedSelector: string,
  model: Parameters<NonNullable<ScopeResolver['resolveReceiverMember']>>[4],
): readonly SymbolDefinition[] {
  const candidates = new Map<string, SymbolDefinition>();
  for (const definition of model.methods.lookupAllByOwner(ownerId, signedSelector)) {
    candidates.set(definition.nodeId, definition);
  }
  return [...candidates.values()];
}

/**
 * Protocol dispatch follows the nearest declaring protocol on every inherited
 * branch. A protocol's own declaration shadows all ancestors, while sibling
 * branches remain visible so incompatible contracts are reported as ambiguous.
 */
interface ObjectiveCProtocolCandidates {
  readonly frontier: readonly SymbolDefinition[];
  readonly requirementEvidence: readonly SymbolDefinition[];
}

function objectiveCProtocolMemberCandidates(
  owner: SymbolDefinition,
  signedSelector: string,
  scopes: Parameters<NonNullable<ScopeResolver['resolveReceiverMember']>>[3],
  model: Parameters<NonNullable<ScopeResolver['resolveReceiverMember']>>[4],
): ObjectiveCProtocolCandidates | undefined {
  const ancestorIds = scopes.methodDispatch.mroFor(owner.nodeId);
  if (ancestorIds.length > MAX_PROTOCOL_HIERARCHY_SIZE || ancestorIds.includes(owner.nodeId)) {
    return undefined;
  }

  const protocolAncestorIds: string[] = [];
  for (const ownerId of ancestorIds) {
    const definition = scopes.defs.get(ownerId);
    if (definition === undefined || definition.type !== 'Interface') return undefined;
    protocolAncestorIds.push(ownerId);
  }

  const directParentsByOwner = new Map<string, readonly string[]>();
  const directParents = (ownerId: string): readonly string[] | undefined => {
    const cached = directParentsByOwner.get(ownerId);
    if (cached !== undefined) return cached;
    const ownerDefinition = scopes.defs.get(ownerId);
    if (ownerDefinition === undefined || ownerDefinition.type !== 'Interface') return undefined;
    const declaredParentNames = objectiveCDeclaredProtocolParents(ownerDefinition);
    if (declaredParentNames === undefined) return undefined;
    const ancestors = scopes.methodDispatch.mroFor(ownerId);
    if (ancestors.length > MAX_PROTOCOL_HIERARCHY_SIZE || ancestors.includes(ownerId)) {
      return undefined;
    }
    const ancestorSet = new Set<string>();
    for (const ancestorId of ancestors) {
      const definition = scopes.defs.get(ancestorId);
      if (definition === undefined || definition.type !== 'Interface') return undefined;
      ancestorSet.add(ancestorId);
    }

    const parents: string[] = [];
    const expectedAncestors = new Set<string>();
    for (const name of declaredParentNames) {
      const parent = objectiveCNamedType(name, scopes, 'Interface');
      if (parent === undefined || !ancestorSet.has(parent.nodeId)) return undefined;
      parents.push(parent.nodeId);
      expectedAncestors.add(parent.nodeId);
      for (const ancestorId of scopes.methodDispatch.mroFor(parent.nodeId)) {
        expectedAncestors.add(ancestorId);
      }
    }
    if (
      expectedAncestors.size !== ancestorSet.size ||
      [...expectedAncestors].some((ancestorId) => !ancestorSet.has(ancestorId))
    ) {
      return undefined;
    }
    directParentsByOwner.set(ownerId, parents);
    return parents;
  };

  const memo = new Map<string, readonly SymbolDefinition[]>();
  const active = new Set<string>();
  const collectFrontier = (ownerId: string): readonly SymbolDefinition[] | undefined => {
    const cached = memo.get(ownerId);
    if (cached !== undefined) return cached;
    if (active.has(ownerId)) return undefined;
    active.add(ownerId);
    try {
      const direct = objectiveCDeclaredMemberCandidates(ownerId, signedSelector, model);
      if (direct.length > 0) {
        memo.set(ownerId, direct);
        return direct;
      }

      const parents = directParents(ownerId);
      if (parents === undefined) return undefined;
      const frontier = new Map<string, SymbolDefinition>();
      for (const parentId of parents) {
        const inherited = collectFrontier(parentId);
        if (inherited === undefined) return undefined;
        for (const definition of inherited) frontier.set(definition.nodeId, definition);
      }
      const definitions = [...frontier.values()];
      memo.set(ownerId, definitions);
      return definitions;
    } finally {
      active.delete(ownerId);
    }
  };

  const frontier = collectFrontier(owner.nodeId);
  if (frontier === undefined) return undefined;
  const requirementEvidence = new Map<string, SymbolDefinition>();
  for (const ownerId of [owner.nodeId, ...protocolAncestorIds]) {
    for (const definition of objectiveCDeclaredMemberCandidates(ownerId, signedSelector, model)) {
      requirementEvidence.set(definition.nodeId, definition);
    }
  }
  return { frontier, requirementEvidence: [...requirementEvidence.values()] };
}

function normalizedContractType(type: string | undefined): string | undefined {
  if (type === undefined || type.length === 0 || type.length > MAX_PROTOCOL_CONTRACT_TYPE_LENGTH) {
    return undefined;
  }
  const tokens = type.match(/[_\p{ID_Start}][_\p{ID_Continue}\u200C\u200D]*|\p{Number}+|[^\s]/gu);
  return tokens === null || tokens.length === 0 ? undefined : JSON.stringify(tokens);
}

function objectiveCProtocolContractKey(definition: SymbolDefinition): string {
  const selector = definition.qualifiedName?.split('.').pop() ?? '';
  const returnType = normalizedContractType(definition.returnType);
  const parameterTypes = definition.parameterTypes?.map(normalizedContractType);
  if (
    selector === '' ||
    returnType === undefined ||
    definition.parameterCount === undefined ||
    parameterTypes === undefined ||
    parameterTypes.length !== definition.parameterCount ||
    parameterTypes.some((parameterType) => parameterType === undefined)
  ) {
    return JSON.stringify(['incomplete', definition.nodeId]);
  }
  return JSON.stringify([
    selector,
    returnType,
    definition.parameterCount,
    definition.requiredParameterCount ?? definition.parameterCount,
    parameterTypes,
  ]);
}

function isOptionalProtocolMember(definition: SymbolDefinition): boolean {
  return definition.annotations?.includes('objc:protocol:optional') === true;
}

function protocolRequirementOrder(definition: SymbolDefinition): number {
  if (definition.annotations?.includes('objc:protocol:required') === true) return 0;
  return isOptionalProtocolMember(definition) ? 2 : 1;
}

function objectiveCNamedType(
  name: string,
  scopes: ObjectiveCResolutionScopes,
  expectedType: 'Class' | 'Interface' = 'Class',
): SymbolDefinition | undefined {
  const matches = (scopes.qualifiedNames.get(name) ?? [])
    .map((id) => scopes.defs.get(id))
    .filter((definition): definition is SymbolDefinition => definition !== undefined)
    .filter((definition) => definition.type === expectedType)
    .filter((definition) => annotationValue(definition, 'objc:site:') !== 'category-host');

  for (const role of ['implementation', 'declaration', 'forward-declaration']) {
    const atRole = matches.filter(
      (definition) => annotationValue(definition, 'objc:site:') === role,
    );
    if (atRole.length === 1) return atRole[0];
    if (atRole.length > 1) return undefined;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function objectiveCClassMemberCandidates(
  ownerName: string,
  candidateNames: readonly string[],
  scopes: ObjectiveCResolutionScopes,
  model: Parameters<NonNullable<ScopeResolver['resolveReceiverMember']>>[4],
): readonly SymbolDefinition[] {
  const logicalOwnerNames: string[] = [ownerName];
  const seenOwnerNames = new Set(logicalOwnerNames);
  const primaryOwner = objectiveCNamedType(ownerName, scopes, 'Class');
  if (primaryOwner !== undefined) {
    for (const ownerId of [
      primaryOwner.nodeId,
      ...scopes.methodDispatch.mroFor(primaryOwner.nodeId),
    ]) {
      const definition = scopes.defs.get(ownerId);
      const logicalName =
        definition === undefined
          ? undefined
          : (annotationValue(definition, 'objc:owner:') ??
            definition.qualifiedName?.split('.').pop());
      if (logicalName !== undefined && !seenOwnerNames.has(logicalName)) {
        seenOwnerNames.add(logicalName);
        logicalOwnerNames.push(logicalName);
      }
    }
  }

  for (const logicalOwnerName of logicalOwnerNames) {
    const siteOwnerIds = new Set<string>();
    for (const id of scopes.qualifiedNames.get(logicalOwnerName) ?? []) {
      const definition = scopes.defs.get(id);
      if (definition?.type === 'Class') siteOwnerIds.add(definition.nodeId);
    }
    const candidates = new Map<string, SymbolDefinition>();
    for (const siteOwnerId of siteOwnerIds) {
      for (const candidateName of candidateNames) {
        for (const definition of model.methods.lookupAllByOwner(siteOwnerId, candidateName)) {
          candidates.set(definition.nodeId, definition);
        }
      }
    }
    if (candidates.size === 0) continue;
    const runtimeCandidates = [...candidates.values()].filter((definition) => {
      const role = annotationValue(definition, 'objc:site:');
      return role === 'implementation' || role === 'synthesized';
    });
    return runtimeCandidates.length > 0 ? runtimeCandidates : [...candidates.values()];
  }
  return [];
}

function objectiveCClassMemberCandidatesForOwner(
  owner: SymbolDefinition,
  candidateNames: readonly string[],
  scopes: ObjectiveCResolutionScopes,
  model: Parameters<NonNullable<ScopeResolver['resolveReceiverMember']>>[4],
): readonly SymbolDefinition[] {
  const ownerName = annotationValue(owner, 'objc:owner:') ?? owner.qualifiedName?.split('.').pop();
  if (ownerName !== undefined) {
    return objectiveCClassMemberCandidates(ownerName, candidateNames, scopes, model);
  }
  const candidates = new Map<string, SymbolDefinition>();
  for (const ownerId of [owner.nodeId, ...scopes.methodDispatch.mroFor(owner.nodeId)]) {
    for (const candidateName of candidateNames) {
      for (const definition of model.methods.lookupAllByOwner(ownerId, candidateName)) {
        candidates.set(definition.nodeId, definition);
      }
    }
    if (candidates.size > 0) return [...candidates.values()];
  }
  return [];
}

function objectiveCTypedReceiverMember(
  typeRef: TypeRef,
  _receiverName: string,
  memberName: string,
  callsite: Parameters<NonNullable<ScopeResolver['resolveReceiverMember']>>[2],
  scopes: Parameters<NonNullable<ScopeResolver['resolveReceiverMember']>>[3],
  model: Parameters<NonNullable<ScopeResolver['resolveReceiverMember']>>[4],
): ReturnType<NonNullable<ScopeResolver['resolveTypedReceiverMember']>> {
  const descriptor = parseObjectiveCTypeDescriptor(typeRef.declaredSpelling ?? typeRef.rawName);
  if (descriptor.receiverForm === 'dynamic' || descriptor.receiverForm === 'related-result') {
    return { kind: 'unresolved' as const, reason: 'objective-c: dynamic-receiver' };
  }
  const selector = memberName.replace(/^[+-]/, '');
  const explicitSigns = new Set(
    (callsite.candidateNames ?? [])
      .map((candidate) => candidate[0])
      .filter((sign): sign is '+' | '-' => sign === '+' || sign === '-'),
  );
  const dispatchSign =
    explicitSigns.size === 1
      ? explicitSigns.values().next().value!
      : descriptor.receiverForm === 'class-object'
        ? '+'
        : '-';
  const capturedCandidates = (callsite.candidateNames ?? []).filter((candidate) =>
    candidate.startsWith(dispatchSign),
  );
  const signedSelectors =
    capturedCandidates.length > 0
      ? [...new Set(capturedCandidates)]
      : [`${dispatchSign}${selector}`];

  if (
    descriptor.baseName !== undefined &&
    descriptor.baseName !== 'id' &&
    descriptor.baseName !== 'Class'
  ) {
    const concreteCandidates = objectiveCClassMemberCandidates(
      descriptor.baseName,
      signedSelectors,
      scopes,
      model,
    );
    if (concreteCandidates.length === 1) {
      return { kind: 'resolved' as const, definition: concreteCandidates[0]! };
    }
    if (concreteCandidates.length > 1) {
      return {
        kind: 'ambiguous' as const,
        candidateIds: concreteCandidates.map((candidate) => candidate.nodeId).sort(),
      };
    }
  }

  const protocolOwners = descriptor.protocols
    .map((name) => objectiveCNamedType(name, scopes, 'Interface'))
    .filter((definition): definition is SymbolDefinition => definition !== undefined);
  if (protocolOwners.length !== descriptor.protocols.length) {
    return { kind: 'unresolved' as const, reason: 'objective-c: unknown-protocol' };
  }
  const candidates = new Map<string, SymbolDefinition>();
  const requirementEvidence = new Map<string, SymbolDefinition>();
  for (const owner of protocolOwners) {
    for (const signedSelector of signedSelectors) {
      const protocolCandidates = objectiveCProtocolMemberCandidates(
        owner,
        signedSelector,
        scopes,
        model,
      );
      if (protocolCandidates === undefined) {
        return { kind: 'unresolved' as const, reason: 'objective-c: invalid-protocol-hierarchy' };
      }
      for (const definition of protocolCandidates.frontier) {
        candidates.set(definition.nodeId, definition);
      }
      for (const definition of protocolCandidates.requirementEvidence) {
        requirementEvidence.set(definition.nodeId, definition);
      }
    }
  }
  if (candidates.size === 0) {
    return {
      kind: 'unresolved' as const,
      reason:
        descriptor.baseName === undefined && protocolOwners.length === 0
          ? 'objective-c: unknown-receiver'
          : 'objective-c: member-missing',
    };
  }
  const contracts = new Map<string, SymbolDefinition[]>();
  for (const definition of candidates.values()) {
    const key = objectiveCProtocolContractKey(definition);
    const equivalent = contracts.get(key) ?? [];
    equivalent.push(definition);
    contracts.set(key, equivalent);
  }
  if (contracts.size > 1) {
    return { kind: 'ambiguous' as const, candidateIds: [...candidates.keys()].sort() };
  }
  const equivalentDefinitions = [...contracts.values()][0]!;
  const definition = equivalentDefinitions.slice().sort((left, right) => {
    const requirementOrder = protocolRequirementOrder(left) - protocolRequirementOrder(right);
    return requirementOrder !== 0
      ? requirementOrder
      : (left.sourceIdentity ?? left.nodeId).localeCompare(right.sourceIdentity ?? right.nodeId);
  })[0]!;
  const optional = [...requirementEvidence.values()].every(isOptionalProtocolMember);
  return {
    kind: 'resolved' as const,
    definition,
    confidence: optional ? 0.6 : 0.85,
    reason: optional ? 'objective-c: optional-protocol-dispatch' : 'objective-c: protocol-dispatch',
  };
}

function selectorBelongsToFamily(selector: string, family: string): boolean {
  const candidate = selector.replace(/^_+/, '');
  if (!candidate.startsWith(family)) return false;
  const next = candidate[family.length];
  return next === undefined || !/[a-z]/.test(next);
}

function isObjectiveCRelatedMethodFamily(method: SymbolDefinition): boolean {
  const signedSelector = method.qualifiedName?.split('.').pop() ?? '';
  const kind = signedSelector[0];
  const selector = signedSelector.slice(1).split(':', 1)[0] ?? '';
  return kind === '+'
    ? selectorBelongsToFamily(selector, 'alloc') || selectorBelongsToFamily(selector, 'new')
    : kind === '-'
      ? selectorBelongsToFamily(selector, 'init') ||
        selector === 'self' ||
        selector === 'retain' ||
        selector === 'autorelease'
      : false;
}

function isObjectiveCMethodFamilyReturnCompatible(
  method: SymbolDefinition,
  scopes: ObjectiveCResolutionScopes,
): boolean {
  if (method.returnType === undefined) return false;
  const descriptor = parseObjectiveCTypeDescriptor(method.returnType);
  if (descriptor.receiverForm === 'related-result') return true;
  // Bare `id` remains a dynamic RECEIVER, but is an object-compatible RETURN
  // type even when declaration qualifiers/nullability surround it.
  if (descriptor.baseName === 'id') return true;
  if (
    descriptor.baseName === undefined ||
    descriptor.baseName === 'Class' ||
    descriptor.receiverForm !== 'instance' ||
    !method.returnType.includes('*')
  ) {
    return false;
  }

  const declaredOwnerName = annotationValue(method, 'objc:owner:');
  const declaredOwner =
    declaredOwnerName === undefined
      ? method.ownerId === undefined
        ? undefined
        : scopes.defs.get(method.ownerId)
      : objectiveCNamedType(declaredOwnerName, scopes, 'Class');
  if (declaredOwner === undefined) return false;

  const compatibleNames = [
    declaredOwner.nodeId,
    ...scopes.methodDispatch.mroFor(declaredOwner.nodeId),
  ]
    .map((ownerId) => scopes.defs.get(ownerId))
    .filter((owner): owner is SymbolDefinition => owner !== undefined)
    .flatMap((owner) => {
      const sourceOwner = annotationValue(owner, 'objc:owner:');
      const qualifiedName = owner.qualifiedName?.split('.').pop();
      return [sourceOwner, qualifiedName].filter((name): name is string => name !== undefined);
    });
  return compatibleNames.includes(descriptor.baseName);
}

function resolveObjectiveCRelatedResultOwner(
  method: SymbolDefinition,
  receiverOwner: SymbolDefinition,
  scopes: ObjectiveCResolutionScopes,
): SymbolDefinition | undefined {
  if (method.returnType === undefined) return undefined;
  const descriptor = parseObjectiveCTypeDescriptor(method.returnType);
  if (descriptor.receiverForm === 'related-result') return receiverOwner;
  if (!isObjectiveCMethodFamilyReturnCompatible(method, scopes)) return undefined;
  return isObjectiveCRelatedMethodFamily(method) ? receiverOwner : undefined;
}

function resolveObjectiveCDeclaredResultOwner(
  method: SymbolDefinition,
  scopes: ObjectiveCResolutionScopes,
): SymbolDefinition | undefined {
  if (method.returnType === undefined) return undefined;
  const descriptor = parseObjectiveCTypeDescriptor(method.returnType);
  if (
    descriptor.receiverForm !== 'instance' ||
    descriptor.baseName === undefined ||
    descriptor.baseName === 'id' ||
    descriptor.baseName === 'Class'
  ) {
    return undefined;
  }
  return objectiveCNamedType(descriptor.baseName, scopes, 'Class');
}

function objectiveCReceiverKindForTypeName(typeName: string): 'class' | 'instance' | undefined {
  const descriptor = parseObjectiveCTypeDescriptor(typeName);
  if (descriptor.receiverForm === 'class-object') return 'class';
  if (descriptor.receiverForm === 'instance') return 'instance';
  return undefined;
}

function objectiveCReceiverKindForTypeRef(typeRef: TypeRef): 'class' | 'instance' | undefined {
  return objectiveCReceiverKindForTypeName(typeRef.declaredSpelling ?? typeRef.rawName);
}

function objectiveCReceiverChainResultTypeRef(
  method: Parameters<NonNullable<ScopeResolver['receiverChainResultTypeRef']>>[0],
  scopes: Parameters<NonNullable<ScopeResolver['receiverChainResultTypeRef']>>[1],
  index: Parameters<NonNullable<ScopeResolver['receiverChainResultTypeRef']>>[2],
): TypeRef | undefined {
  if (method.returnType === undefined || method.ownerId === undefined) return undefined;
  const declaredAtScope = index.classScopeByDefId.get(method.ownerId)?.id;
  if (declaredAtScope === undefined) return undefined;
  const declaredSpelling = method.returnType.trim();
  const descriptor = parseObjectiveCTypeDescriptor(declaredSpelling);
  if (
    descriptor.receiverForm === 'related-result' ||
    (isObjectiveCRelatedMethodFamily(method) &&
      isObjectiveCMethodFamilyReturnCompatible(method, scopes))
  ) {
    return undefined;
  }
  const rawName = descriptor.baseName;
  if (rawName === undefined) return undefined;
  return {
    rawName,
    ...(rawName === declaredSpelling ? {} : { declaredSpelling }),
    declaredAtScope,
    source: 'return-annotation',
  };
}

function objectiveCReceiverChainBaseKind(
  receiverName: string,
  typeRef: TypeRef | undefined,
  scopes: ObjectiveCResolutionScopes,
): 'class' | 'instance' | undefined {
  if (typeRef === undefined) return 'class';
  if (
    (receiverName.trim() === 'self' || receiverName.trim() === 'super') &&
    typeRef.source === 'self'
  ) {
    const declaringScope = scopes.scopeTree.getScope(typeRef.declaredAtScope);
    const methods =
      declaringScope?.ownedDefs.filter((definition) => definition.type === 'Method') ?? [];
    if (methods.length !== 1 || methods[0]!.isStatic === undefined) return undefined;
    return methods[0]!.isStatic ? 'class' : 'instance';
  }
  return objectiveCReceiverKindForTypeRef(typeRef);
}

function resolveObjectiveCSuperOwner(
  enclosingClass: SymbolDefinition,
  scopes: ObjectiveCResolutionScopes,
): SymbolDefinition | undefined {
  if (annotationValue(enclosingClass, 'objc:site:') !== 'category-host') {
    return enclosingClass;
  }
  const ownerName = annotationValue(enclosingClass, 'objc:owner:');
  return ownerName === undefined ? undefined : objectiveCNamedType(ownerName, scopes, 'Class');
}

export const objectiveCScopeResolver: ScopeResolver = {
  language: SupportedLanguages.ObjectiveC,
  languageProvider: objectiveCProvider,
  importEdgeReason: 'objective-c-scope: import',

  loadResolutionConfig: () => {
    clearStaticNames();
    return null;
  },

  applyCaptureSideChannel: applyObjectiveCCaptureSideChannel,

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, _resolutionConfig, context) => {
    const isSystem =
      context?.parsedImport?.kind === 'wildcard' && context.parsedImport.isSystem === true;
    return context?.parsedFiles === undefined
      ? resolveObjectiveCImportTarget(targetRaw, fromFile, allFilePaths, { isSystem })
      : resolveObjectiveCImportClosure(targetRaw, fromFile, allFilePaths, context.parsedFiles, {
          isSystem,
        });
  },

  collectScopeContextPaths({
    primaryFilePaths,
    preExtractedByPath,
    entryFileContents,
    allScannedPaths,
  }) {
    const visited = new Set(primaryFilePaths);
    const queue = [...primaryFilePaths];
    const fallbackParsed = new Map<string, ParsedFile>();
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      if (current === undefined) continue;
      let parsed = preExtractedByPath.get(current) ?? fallbackParsed.get(current);
      if (parsed === undefined) {
        const source = entryFileContents.get(current);
        if (source !== undefined) {
          parsed = extractParsedFile(objectiveCProvider, source, current);
          if (parsed !== undefined) fallbackParsed.set(current, parsed);
        }
      }
      if (parsed === undefined) continue;

      for (const parsedImport of parsed.parsedImports) {
        const target = resolveObjectiveCImportTarget(
          parsedImport.targetRaw,
          current,
          allScannedPaths,
          {
            isSystem: parsedImport.kind === 'wildcard' && parsedImport.isSystem,
          },
        );
        if (target === null || !/\.h$/i.test(target) || visited.has(target)) continue;
        visited.add(target);
        queue.push(target);
      }
    }
    return visited;
  },

  // A C/C++-classified header in the Objective-C import closure must be
  // re-extracted with the Objective-C grammar. The authoritative cached shard
  // remains untouched and is still reused by its primary language pass.
  acceptPreExtractedParsedFile: (parsed: ParsedFile) =>
    parsed.language === SupportedLanguages.ObjectiveC,

  expandsWildcardTo: expandCWildcardNames,

  mergeBindings: (existing, incoming, scopeId) => cMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, definition) => cArityCompatibility(definition, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize, {
      includeImplementsFor: (owner) => owner.type === 'Interface',
    }),

  populateOwners: (parsed) => populateClassOwnedMembers(parsed),
  populateWorkspaceOwners: (parsedFiles) => populateObjectiveCWorkspaceOwners(parsedFiles),

  emitHeritageEdges: (graph, parsedFiles, nodeLookup) =>
    emitObjectiveCSourceSiteEdges(graph, parsedFiles, nodeLookup),

  isSuperReceiver: (receiver) => receiver.trim() === 'super',
  resolveThisViaEnclosingClass: true,
  isEnclosingClassReceiver: (receiver) => receiver.trim() === 'self',

  resolveReceiverMember(ownerDef, memberName, callsite, scopes, model, context) {
    const rawCandidates = callsite.candidateNames ?? [memberName];
    const candidateNames =
      context?.receiverKind === 'class'
        ? rawCandidates.filter((candidate) => candidate.startsWith('+'))
        : context?.receiverKind === 'instance'
          ? rawCandidates.filter((candidate) => candidate.startsWith('-'))
          : rawCandidates;
    if (candidateNames.length === 0) return undefined;
    const candidates = objectiveCClassMemberCandidatesForOwner(
      ownerDef,
      candidateNames,
      scopes,
      model,
    );
    if (candidates.length === 1) {
      return { kind: 'resolved', definition: candidates[0]! };
    }
    if (candidates.length > 1) {
      return {
        kind: 'ambiguous',
        candidateIds: candidates.map((candidate) => candidate.nodeId).sort(),
      };
    }
    return context?.receiverKind === 'class'
      ? { kind: 'unresolved', reason: 'objective-c: member-missing' }
      : undefined;
  },
  resolveClassNameReceiversViaMemberHook: true,

  resolveTypedReceiverMember: objectiveCTypedReceiverMember,
  resolveTypedReceiverChainsViaMemberHook: true,
  resolveRelatedResultOwner: (method, receiverOwner, _callsite, scopes) =>
    resolveObjectiveCRelatedResultOwner(method, receiverOwner, scopes),
  resolveReceiverChainResultOwner: (method, _receiverOwner, _callsite, scopes) =>
    resolveObjectiveCDeclaredResultOwner(method, scopes),
  receiverChainMemberCandidates: (memberName, receiverKind) => {
    if (/^[+-]/.test(memberName)) return [memberName];
    if (receiverKind === 'class') return [`+${memberName}`];
    if (receiverKind === 'instance') return [`-${memberName}`];
    return [];
  },
  receiverChainBaseKind: (receiverName, typeRef, _receiverOwner, scopes) =>
    objectiveCReceiverChainBaseKind(receiverName, typeRef, scopes),
  receiverChainResultKind: (method, resultTypeRef, relatedResult) => {
    if (relatedResult) return 'instance';
    if (resultTypeRef !== undefined) return objectiveCReceiverKindForTypeRef(resultTypeRef);
    return method.returnType === undefined
      ? undefined
      : objectiveCReceiverKindForTypeName(method.returnType);
  },
  receiverChainResultTypeRef: objectiveCReceiverChainResultTypeRef,
  resolveSuperReceiverOwner: resolveObjectiveCSuperOwner,

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,

  allowGlobalFreeCallFallback: true,

  isFileLocalDef: (definition: SymbolDefinition) => {
    const simpleName = definition.qualifiedName?.split('.').pop() ?? '';
    return isStaticName(definition.filePath, simpleName);
  },
};
