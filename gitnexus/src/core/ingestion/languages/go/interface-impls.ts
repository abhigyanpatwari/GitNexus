import type { ParsedFile, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { resolveInheritanceBaseInScope } from '../../scope-resolution/scope/walkers.js';

type MethodSet = ReadonlyMap<string, readonly SymbolDefinition[]>;
type MutableMethodSet = Map<string, SymbolDefinition[]>;
type MethodSetEntry = {
  readonly overloads: readonly SymbolDefinition[];
  readonly depth: number;
  readonly ambiguous: boolean;
};
type MutableMethodSetEntries = Map<string, MethodSetEntry>;
type GoMethodDefinition = SymbolDefinition & { readonly goReceiverKind?: 'value' | 'pointer' };
type SignatureContext = {
  readonly packageQualifier: string | undefined;
  readonly importQualifiers: ReadonlyMap<string, string>;
};
type DetectionIndexes = {
  readonly interfaces: readonly SymbolDefinition[];
  readonly structsById: ReadonlyMap<string, SymbolDefinition>;
  readonly methodsByOwner: ReadonlyMap<string, MethodSet>;
  readonly effectiveMethodsByStructId: ReadonlyMap<string, MethodSet>;
  readonly interfaceById: ReadonlyMap<string, SymbolDefinition>;
  readonly interfaceOwnMethodsById: ReadonlyMap<string, MethodSet>;
  readonly embeddedSitesByInterfaceId: ReadonlyMap<string, readonly ReferenceSite[]>;
  readonly parentStructIdsByStructId: ReadonlyMap<string, readonly string[]>;
  readonly structIdsByMethodName: ReadonlyMap<string, ReadonlySet<string>>;
  readonly signatureContextByDefId: ReadonlyMap<string, SignatureContext>;
  readonly scopeIndexes: ScopeResolutionIndexes;
};

export function detectGoInterfaceImplementations(
  parsedFiles: readonly ParsedFile[],
  _indexes: ScopeResolutionIndexes,
  _model: SemanticModel,
): Map<string, string[]> {
  return detectGoInterfaceImplementationsFromIndexes(buildDetectionIndexes(parsedFiles, _indexes));
}

function buildDetectionIndexes(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): DetectionIndexes {
  const interfaces: SymbolDefinition[] = [];
  const structsById = new Map<string, SymbolDefinition>();
  const methodsByOwner = new Map<string, Map<string, SymbolDefinition[]>>();
  const effectiveMethodsByStructId = new Map<string, MethodSet>();
  const interfaceById = new Map<string, SymbolDefinition>();
  const interfaceOwnMethodsById = new Map<string, MethodSet>();
  const embeddedSitesByInterfaceId = new Map<string, ReferenceSite[]>();
  const parentStructIdsByStructId = new Map<string, string[]>();
  const structIdsByMethodName = new Map<string, Set<string>>();
  const signatureContextByDefId = new Map<string, SignatureContext>();
  const interfaceIdByScopeId = new Map<string, string>();
  const structIdByScopeId = new Map<string, string>();

  for (const parsed of parsedFiles) {
    const signatureContext = signatureContextForFile(parsed, indexes);
    for (const def of parsed.localDefs) {
      signatureContextByDefId.set(def.nodeId, signatureContext);
      if (def.type === 'Interface') {
        interfaces.push(def);
        interfaceById.set(def.nodeId, def);
        continue;
      }
      if (def.type === 'Struct') {
        structsById.set(def.nodeId, def);
        continue;
      }
      if (def.type !== 'Method' && def.type !== 'Function') continue;
      if (def.ownerId === undefined) continue;
      if (isPointerReceiverMethod(def)) continue;
      const methodName = simpleQualifiedName(def);
      if (methodName === undefined || methodName.length === 0) continue;

      addMethod(methodsByOwner, def.ownerId, methodName, def);
    }
  }

  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      const iface = scope.ownedDefs.find((def) => def.type === 'Interface');
      if (iface !== undefined) interfaceIdByScopeId.set(scope.id, iface.nodeId);
      const struct = scope.ownedDefs.find((def) => def.type === 'Struct');
      if (struct !== undefined) structIdByScopeId.set(scope.id, struct.nodeId);
    }
  }

  for (const parsed of parsedFiles) {
    const childScopesByParent = new Map<string, (typeof parsed.scopes)[number][]>();
    for (const scope of parsed.scopes) {
      if (scope.parent === null) continue;
      const children = childScopesByParent.get(scope.parent) ?? [];
      children.push(scope);
      childScopesByParent.set(scope.parent, children);
    }

    for (const scope of parsed.scopes) {
      const ifaceId = interfaceIdByScopeId.get(scope.id);
      if (ifaceId === undefined) continue;
      const methods = new Map<string, SymbolDefinition[]>();
      for (const childScope of childScopesByParent.get(scope.id) ?? []) {
        for (const def of childScope.ownedDefs) {
          if (def.type !== 'Method' && def.type !== 'Function') continue;
          const methodName = simpleQualifiedName(def);
          if (methodName === undefined || methodName.length === 0) continue;
          addMethodOverload(methods, methodName, def);
        }
      }
      interfaceOwnMethodsById.set(ifaceId, methods);
    }

    for (const site of parsed.referenceSites) {
      if (site.kind !== 'inherits') continue;
      const ifaceId = interfaceIdByScopeId.get(site.inScope);
      if (ifaceId !== undefined) {
        const sites = embeddedSitesByInterfaceId.get(ifaceId) ?? [];
        sites.push(site);
        embeddedSitesByInterfaceId.set(ifaceId, sites);
        continue;
      }

      const structId = structIdByScopeId.get(site.inScope);
      if (structId === undefined) continue;
      const parent = resolveInheritanceBaseInScope(site.inScope, site.name, indexes);
      if (parent === undefined || parent.type !== 'Struct') continue;
      addParentStruct(parentStructIdsByStructId, structId, parent.nodeId);
    }
  }

  const structMethodSetCache = new Map<string, MutableMethodSetEntries>();
  for (const structId of structsById.keys()) {
    const effective = collectStructMethodSet(
      structId,
      {
        parentStructIdsByStructId,
        methodsByOwner,
      },
      new Set(),
      structMethodSetCache,
    );
    if (effective === undefined) continue;
    effectiveMethodsByStructId.set(structId, effective);
    for (const methodName of effective.keys()) {
      addStructMethodCandidate(structIdsByMethodName, methodName, structId);
    }
  }

  return {
    interfaces,
    structsById,
    methodsByOwner,
    effectiveMethodsByStructId,
    interfaceById,
    interfaceOwnMethodsById,
    embeddedSitesByInterfaceId,
    parentStructIdsByStructId,
    structIdsByMethodName,
    signatureContextByDefId,
    scopeIndexes: indexes,
  };
}

function detectGoInterfaceImplementationsFromIndexes(
  indexes: DetectionIndexes,
): Map<string, string[]> {
  const implementations = new Map<string, string[]>();
  const methodSetCache = new Map<string, MutableMethodSet>();
  for (const iface of indexes.interfaces) {
    const required = collectInterfaceMethodSet(iface, indexes, new Set(), methodSetCache);
    if (required === undefined || required.size === 0) continue;
    if (!methodSetHasVerifiableSignatures(required)) continue;

    const implementors: string[] = [];
    for (const structId of candidateStructIdsFor(required, indexes)) {
      const actual = indexes.effectiveMethodsByStructId.get(structId);
      if (actual === undefined) continue;
      if (methodSetSatisfies(actual, required, indexes.signatureContextByDefId)) {
        implementors.push(structId);
      }
    }
    if (implementors.length > 0) implementations.set(iface.nodeId, implementors);
  }

  return implementations;
}

function addMethod(
  methodsByOwner: Map<string, Map<string, SymbolDefinition[]>>,
  ownerId: string,
  methodName: string,
  def: SymbolDefinition,
): void {
  let methods = methodsByOwner.get(ownerId);
  if (methods === undefined) {
    methods = new Map<string, SymbolDefinition[]>();
    methodsByOwner.set(ownerId, methods);
  }
  addMethodOverload(methods, methodName, def);
}

function addMethodOverload(
  methods: Map<string, SymbolDefinition[]>,
  methodName: string,
  def: SymbolDefinition,
): void {
  const overloads = methods.get(methodName) ?? [];
  overloads.push(def);
  methods.set(methodName, overloads);
}

function addStructMethodCandidate(
  structIdsByMethodName: Map<string, Set<string>>,
  methodName: string,
  structId: string,
): void {
  const structIds = structIdsByMethodName.get(methodName) ?? new Set<string>();
  structIds.add(structId);
  structIdsByMethodName.set(methodName, structIds);
}

function addParentStruct(
  parentStructIdsByStructId: Map<string, string[]>,
  structId: string,
  parentStructId: string,
): void {
  const parents = parentStructIdsByStructId.get(structId) ?? [];
  parents.push(parentStructId);
  parentStructIdsByStructId.set(structId, parents);
}

function collectStructMethodSet(
  structId: string,
  indexes: Pick<DetectionIndexes, 'methodsByOwner' | 'parentStructIdsByStructId'>,
  visiting: Set<string>,
  cache: Map<string, MutableMethodSetEntries>,
): MutableMethodSet | undefined {
  const entries = collectStructMethodEntries(structId, indexes, visiting, cache);
  return entries === undefined ? undefined : methodEntriesToMethodSet(entries);
}

function collectStructMethodEntries(
  structId: string,
  indexes: Pick<DetectionIndexes, 'methodsByOwner' | 'parentStructIdsByStructId'>,
  visiting: Set<string>,
  cache: Map<string, MutableMethodSetEntries>,
): MutableMethodSetEntries | undefined {
  const cached = cache.get(structId);
  if (cached !== undefined) return cloneMethodEntries(cached);
  if (visiting.has(structId)) return undefined;
  visiting.add(structId);

  const merged = directMethodEntries(indexes.methodsByOwner.get(structId));

  for (const parentStructId of indexes.parentStructIdsByStructId.get(structId) ?? []) {
    const parentEntries = collectStructMethodEntries(parentStructId, indexes, visiting, cache);
    if (parentEntries === undefined) {
      visiting.delete(structId);
      return undefined;
    }
    for (const [methodName, entry] of parentEntries) {
      if (entry.ambiguous) continue;
      mergePromotedMethodEntry(merged, methodName, {
        overloads: entry.overloads,
        depth: entry.depth + 1,
        ambiguous: false,
      });
    }
  }

  visiting.delete(structId);
  cache.set(structId, cloneMethodEntries(merged));
  return merged;
}

function collectInterfaceMethodSet(
  iface: SymbolDefinition,
  indexes: DetectionIndexes,
  visiting: Set<string>,
  cache: Map<string, MutableMethodSet>,
): MutableMethodSet | undefined {
  const cached = cache.get(iface.nodeId);
  // NOTE: Returns a direct reference to the cached map. Callers (the detection
  // loop in detectGoInterfaceImplementationsFromIndexes) only READ the result
  // (keys/values passed to candidateStructIdsFor and methodSetSatisfies). If a
  // future caller needs to mutate the returned map, it must clone first — the
  // cache entry is shared and must remain immutable after this function returns.
  if (cached !== undefined) return cached;
  if (visiting.has(iface.nodeId)) return undefined;
  visiting.add(iface.nodeId);

  const ownMethods =
    indexes.methodsByOwner.get(iface.nodeId) ?? indexes.interfaceOwnMethodsById.get(iface.nodeId);
  const merged = cloneMethodSet(ownMethods);

  const embeddedInterfaces = embeddedInterfacesFor(iface, indexes);
  if (embeddedInterfaces === undefined) {
    visiting.delete(iface.nodeId);
    return undefined;
  }

  for (const embeddedIface of embeddedInterfaces) {
    const embeddedMethods = collectInterfaceMethodSet(embeddedIface, indexes, visiting, cache);
    if (embeddedMethods === undefined) {
      visiting.delete(iface.nodeId);
      return undefined;
    }
    mergeMethodSet(merged, embeddedMethods);
  }

  visiting.delete(iface.nodeId);
  // Store a clone in the cache so the returned `merged` reference is independent.
  // This protects the cache from mutation if a caller modifies the return value.
  cache.set(iface.nodeId, cloneMethodSet(merged));
  return merged;
}

function embeddedInterfacesFor(
  iface: SymbolDefinition,
  indexes: DetectionIndexes,
): SymbolDefinition[] | undefined {
  const embedded: SymbolDefinition[] = [];
  for (const site of indexes.embeddedSitesByInterfaceId.get(iface.nodeId) ?? []) {
    const resolved = resolveEmbeddedInterface(site, indexes);
    if (resolved === undefined) return undefined;
    embedded.push(resolved);
  }
  return embedded;
}

function candidateStructIdsFor(required: MethodSet, indexes: DetectionIndexes): Iterable<string> {
  let result: Set<string> | undefined;
  for (const name of required.keys()) {
    const candidates = indexes.structIdsByMethodName.get(name);
    if (candidates === undefined) return [];
    if (result === undefined) {
      // First method name: start with its full candidate set (copy to avoid
      // corrupting the shared index).
      result = new Set(candidates);
    } else {
      // Intersect: keep only struct IDs present in this method's candidate set.
      // Iterate a snapshot to avoid mutating while iterating.
      const toDelete: string[] = [];
      for (const id of result) {
        if (!candidates.has(id)) toDelete.push(id);
      }
      for (const id of toDelete) result.delete(id);
    }
    if (result.size === 0) return []; // Early exit: no struct has all required methods
  }
  return result === undefined ? indexes.structsById.keys() : result;
}

function resolveEmbeddedInterface(
  site: ReferenceSite,
  indexes: DetectionIndexes,
): SymbolDefinition | undefined {
  const bound = resolveInheritanceBaseInScope(site.inScope, site.name, indexes.scopeIndexes);
  if (bound !== undefined) return bound.type === 'Interface' ? bound : undefined;

  const simpleName = simpleTypeName(site.name);
  const matches: SymbolDefinition[] = [];
  for (const iface of indexes.interfaceById.values()) {
    if (iface.qualifiedName === site.name || iface.qualifiedName === simpleName) {
      matches.push(iface);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function simpleTypeName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

function cloneMethodSet(methods: MethodSet | undefined): MutableMethodSet {
  const clone = new Map<string, SymbolDefinition[]>();
  if (methods === undefined) return clone;
  for (const [name, overloads] of methods) {
    clone.set(name, [...overloads]);
  }
  return clone;
}

function directMethodEntries(methods: MethodSet | undefined): MutableMethodSetEntries {
  const entries = new Map<string, MethodSetEntry>();
  if (methods === undefined) return entries;
  for (const [name, overloads] of methods) {
    entries.set(name, { overloads: [...overloads], depth: 0, ambiguous: false });
  }
  return entries;
}

function cloneMethodEntries(entries: ReadonlyMap<string, MethodSetEntry>): MutableMethodSetEntries {
  const clone = new Map<string, MethodSetEntry>();
  for (const [name, entry] of entries) {
    clone.set(name, { ...entry, overloads: [...entry.overloads] });
  }
  return clone;
}

function methodEntriesToMethodSet(entries: ReadonlyMap<string, MethodSetEntry>): MutableMethodSet {
  const methods = new Map<string, SymbolDefinition[]>();
  for (const [name, entry] of entries) {
    if (entry.ambiguous) continue;
    methods.set(name, [...entry.overloads]);
  }
  return methods;
}

function mergePromotedMethodEntry(
  target: MutableMethodSetEntries,
  methodName: string,
  candidate: MethodSetEntry,
): void {
  const existing = target.get(methodName);
  if (existing === undefined || candidate.depth < existing.depth) {
    target.set(methodName, candidate);
    return;
  }
  if (candidate.depth > existing.depth) return;
  target.set(methodName, { overloads: [], depth: candidate.depth, ambiguous: true });
}

function mergeMethodSet(target: MutableMethodSet, source: MethodSet): void {
  for (const [name, overloads] of source) {
    const existing = target.get(name) ?? [];
    existing.push(...overloads);
    target.set(name, existing);
  }
}

function methodSetSatisfies(
  actual: MethodSet,
  required: MethodSet,
  signatureContextByDefId: ReadonlyMap<string, SignatureContext>,
): boolean {
  for (const [name, requiredOverloads] of required) {
    const actualOverloads = actual.get(name);
    if (actualOverloads === undefined) return false;
    for (const requiredMethod of requiredOverloads) {
      // Fast arity pre-filter: if the required method has a known parameter
      // count, reject immediately when no actual overload matches it. This
      // avoids the expensive signature normalization loop for obvious mismatches.
      if (requiredMethod.parameterCount !== undefined) {
        if (!actualOverloads.some((a) => a.parameterCount === requiredMethod.parameterCount)) {
          return false;
        }
      }
      if (!hasCompatibleMethod(actualOverloads, requiredMethod, signatureContextByDefId)) {
        return false;
      }
    }
  }
  return true;
}

function hasCompatibleMethod(
  actualOverloads: readonly SymbolDefinition[],
  requiredMethod: SymbolDefinition,
  signatureContextByDefId: ReadonlyMap<string, SignatureContext>,
): boolean {
  if (!hasVerifiableSignature(requiredMethod)) return false;
  return actualOverloads.some((actualMethod) =>
    signaturesCompatible(actualMethod, requiredMethod, signatureContextByDefId),
  );
}

function methodSetHasVerifiableSignatures(methods: MethodSet): boolean {
  for (const overloads of methods.values()) {
    if (!overloads.some(hasVerifiableSignature)) return false;
  }
  return true;
}

function isPointerReceiverMethod(def: SymbolDefinition): boolean {
  return (def as GoMethodDefinition).goReceiverKind === 'pointer';
}

function hasVerifiableSignature(def: SymbolDefinition): boolean {
  return (
    def.parameterCount !== undefined ||
    def.requiredParameterCount !== undefined ||
    (def.parameterTypes !== undefined && def.parameterTypes.length > 0) ||
    def.returnType !== undefined
  );
}

function signaturesCompatible(
  actual: SymbolDefinition,
  required: SymbolDefinition,
  signatureContextByDefId: ReadonlyMap<string, SignatureContext>,
): boolean {
  const actualContext = signatureContextByDefId.get(actual.nodeId);
  const requiredContext = signatureContextByDefId.get(required.nodeId);
  return (
    countsCompatible(actual.parameterCount, required.parameterCount) &&
    countsCompatible(actual.requiredParameterCount, required.requiredParameterCount) &&
    parameterTypesCompatible(
      actual.parameterTypes,
      required.parameterTypes,
      actualContext,
      requiredContext,
    ) &&
    returnTypesCompatible(actual.returnType, required.returnType, actualContext, requiredContext)
  );
}

function countsCompatible(actual: number | undefined, required: number | undefined): boolean {
  return actual === undefined || required === undefined || actual === required;
}

function parameterTypesCompatible(
  actual: readonly string[] | undefined,
  required: readonly string[] | undefined,
  actualContext: SignatureContext | undefined,
  requiredContext: SignatureContext | undefined,
): boolean {
  if (actual === undefined || required === undefined) return true;
  if (actual.length !== required.length) return false;
  return actual.every((type, index) => {
    const actualType = normalizeSignatureType(type, actualContext);
    const requiredType = normalizeSignatureType(required[index]!, requiredContext);
    return actualType !== undefined && requiredType !== undefined && actualType === requiredType;
  });
}

function returnTypesCompatible(
  actual: string | undefined,
  required: string | undefined,
  actualContext: SignatureContext | undefined,
  requiredContext: SignatureContext | undefined,
): boolean {
  if (required === undefined) return actual === undefined;
  if (actual === undefined) return false;
  const actualType = normalizeSignatureType(actual, actualContext);
  const requiredType = normalizeSignatureType(required, requiredContext);
  return actualType !== undefined && requiredType !== undefined && actualType === requiredType;
}

function normalizeSignatureType(typeName: string, context?: SignatureContext): string | undefined {
  // Go type identity includes pointer/slice/map/variadic shape and package
  // qualifiers. Only erase whitespace and qualify bare local type names; stripping
  // `*`, `[]`, `...`, or `pkg.` would make non-identical signatures compare equal.
  const compact = typeName.replace(/\s+/g, '');
  if (context === undefined) return compact;
  return qualifyGoSignatureTypes(compact, context);
}

function qualifyGoSignatureTypes(typeName: string, context: SignatureContext): string | undefined {
  let unresolvedQualifier = false;
  const qualified = typeName.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (token, offset, source) => {
    if (GO_BUILTIN_TYPES.has(token)) return token;
    if (hasPackageQualifierDot(source, offset)) return token;
    if (source[offset + token.length] === '.') {
      const qualifier = context.importQualifiers.get(token);
      if (qualifier !== undefined) return qualifier;
      unresolvedQualifier = true;
      return token;
    }
    if (context.packageQualifier === undefined) return token;
    return `${context.packageQualifier}.${token}`;
  });
  return unresolvedQualifier ? undefined : qualified;
}

function hasPackageQualifierDot(source: string, offset: number): boolean {
  return source[offset - 1] === '.' && source[offset - 2] !== '.';
}

function signatureContextForFile(
  parsed: ParsedFile,
  indexes: ScopeResolutionIndexes,
): SignatureContext {
  const importQualifiers = new Map<string, string>();
  const importEdges = indexes.imports?.get(parsed.moduleScope) ?? [];
  for (const edge of importEdges) {
    if (edge.kind !== 'namespace' || edge.targetFile === null) continue;
    const qualifier = packageQualifierForFile(edge.targetFile);
    if (qualifier !== undefined) importQualifiers.set(edge.localName, qualifier);
  }
  return {
    packageQualifier: packageQualifierForFile(parsed.filePath),
    importQualifiers,
  };
}

function packageQualifierForFile(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) return undefined;
  const packageDir = normalized.slice(0, slash);
  return packageDir.length === 0 ? undefined : packageDir;
}

const GO_BUILTIN_TYPES = new Set([
  'any',
  'bool',
  'byte',
  'comparable',
  'complex64',
  'complex128',
  'error',
  'float32',
  'float64',
  'func',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'interface',
  'map',
  'rune',
  'string',
  'struct',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'chan',
]);
