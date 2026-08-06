import type { ParsedFile, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { resolveInheritanceBaseInScope } from '../../scope-resolution/scope/walkers.js';
import { goPackageDir } from './package-clause.js';

type MethodSet = ReadonlyMap<string, readonly SymbolDefinition[]>;
type MutableMethodSet = Map<string, SymbolDefinition[]>;
type MethodSetEntry = {
  readonly overloads: readonly SymbolDefinition[];
  readonly depth: number;
  readonly ambiguous: boolean;
};
type MutableMethodSetEntries = Map<string, MethodSetEntry>;
/** A struct embedded in another, plus HOW it was embedded (`T` vs `*T`). */
type EmbeddedParent = { readonly structId: string; readonly asPointer: boolean };
/**
 * The two method sets Go defines for a defined type, kept separately because
 * they answer different questions and only one of them is assignability.
 *   `pointer` = MS(*T) — every method callable on a *T value.
 *   `value`   = MS(T)  — the subset callable on a T value.
 */
type DualMethodSet = { readonly value: MutableMethodSet; readonly pointer: MutableMethodSet };
/** Which method set satisfied an interface. `value` implies pointer too. */
export type GoReceiverForm = 'value' | 'pointer';
/** One structural implementor plus the form in which it implements. */
export type GoStructuralImplementor = {
  readonly structDefId: string;
  readonly receiverForm: GoReceiverForm;
};
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
  readonly parentStructIdsByStructId: ReadonlyMap<string, readonly EmbeddedParent[]>;
  readonly valueMethodsByStructId: ReadonlyMap<string, MethodSet>;
  readonly structIdsByMethodName: ReadonlyMap<string, ReadonlySet<string>>;
  readonly signatureContextByDefId: ReadonlyMap<string, SignatureContext>;
  readonly scopeIndexes: ScopeResolutionIndexes;
};

export function detectGoInterfaceImplementations(
  parsedFiles: readonly ParsedFile[],
  _indexes: ScopeResolutionIndexes,
  _model: SemanticModel,
): Map<string, GoStructuralImplementor[]> {
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
  const parentStructIdsByStructId = new Map<string, EmbeddedParent[]>();
  const valueMethodsByStructId = new Map<string, MethodSet>();
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
      // POINTER-receiver methods count toward the method set (#2813).
      //
      // Go's rule is per-type, and there are two types here: the method set of
      // `T` holds only its value-receiver methods, while the method set of `*T`
      // holds BOTH. #1966 kept only the value-receiver half, which makes the
      // `T` answer exactly right — and the `*T` answer permanently empty, so a
      // struct whose methods all read `func (r *T)` satisfied nothing and got
      // no IMPLEMENTS edge at all.
      //
      // That is the shape idiomatic Go actually writes: methods take pointer
      // receivers so they can mutate, and `*T` is what gets stored in an
      // interface-typed field. Excluding it did not make the graph
      // conservative, it made it silent — every call through such a field
      // resolved to the interface DECLARATION and `impact()` on the
      // implementation reported zero callers, indistinguishable from a symbol
      // that genuinely has none.
      //
      // GitNexus models one Struct node per type with no separate `*T` node, so
      // the two method sets cannot both be represented. This picks the `*T`
      // reading: the graph now answers "which types provide this interface's
      // behaviour", and no longer proves `var x I = T{}` invalid. That trade is
      // deliberate — blast radius is what every consumer of IMPLEMENTS asks for
      // (verified: MRO/METHOD_IMPLEMENTS derivation, community clustering, the
      // receiver-dispatch fan-out index, and the epistemic heritage probe; none
      // performs value-assignability checking).
      //
      // `goReceiverKind` is still stamped in method-owners.ts and is the hook a
      // future value/pointer-aware model would read; it is deliberately no
      // longer a filter here.
      const simpleName = simpleQualifiedName(def);
      if (simpleName === undefined || simpleName.length === 0) continue;

      addMethod(
        methodsByOwner,
        def.ownerId,
        methodSetKey(simpleName, def, signatureContextByDefId),
        def,
      );
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
          const simpleName = simpleQualifiedName(def);
          if (simpleName === undefined || simpleName.length === 0) continue;
          // Same key function as the struct side — an interface requiring an
          // unexported `seal()` must only be satisfied from its own package.
          addMethodOverload(methods, methodSetKey(simpleName, def, signatureContextByDefId), def);
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
      // `embeddedAsPointer` is the capture-layer record of `*T` vs `T`; the two
      // promote different method sets (go.dev/ref/spec#Struct_types).
      addParentStruct(
        parentStructIdsByStructId,
        structId,
        parent.nodeId,
        site.embeddedAsPointer === true,
      );
    }
  }

  const structMethodSetCache = new Map<string, DualEntries>();
  for (const structId of structsById.keys()) {
    const dual = collectStructMethodSet(
      structId,
      {
        parentStructIdsByStructId,
        methodsByOwner,
      },
      new Set(),
      structMethodSetCache,
    );
    if (dual === undefined) continue;
    // `pointer` is MS(*T) and is the superset, so it drives candidate lookup:
    // a type that implements only in pointer form is still an implementor.
    effectiveMethodsByStructId.set(structId, dual.pointer);
    valueMethodsByStructId.set(structId, dual.value);
    for (const methodName of dual.pointer.keys()) {
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
    valueMethodsByStructId,
    signatureContextByDefId,
    scopeIndexes: indexes,
  };
}

function detectGoInterfaceImplementationsFromIndexes(
  indexes: DetectionIndexes,
): Map<string, GoStructuralImplementor[]> {
  const implementations = new Map<string, GoStructuralImplementor[]>();
  const methodSetCache = new Map<string, MutableMethodSet>();
  for (const iface of indexes.interfaces) {
    const required = collectInterfaceMethodSet(iface, indexes, new Set(), methodSetCache);
    if (required === undefined || required.size === 0) continue;
    if (!methodSetHasVerifiableSignatures(required)) continue;

    const implementors: GoStructuralImplementor[] = [];
    for (const structId of candidateStructIdsFor(required, indexes)) {
      const pointerSet = indexes.effectiveMethodsByStructId.get(structId);
      if (pointerSet === undefined) continue;
      // MS(*T) is the superset: if it does not satisfy, neither does MS(T).
      if (!methodSetSatisfies(pointerSet, required, indexes.signatureContextByDefId)) continue;
      // Then ask the narrower question separately — does the VALUE type satisfy?
      // This is the distinction `var x I = T{}` turns on, and it is a fact about
      // the program, not a heuristic.
      const valueSet = indexes.valueMethodsByStructId.get(structId);
      const satisfiesByValue =
        valueSet !== undefined &&
        methodSetSatisfies(valueSet, required, indexes.signatureContextByDefId);
      implementors.push({
        structDefId: structId,
        receiverForm: satisfiesByValue ? 'value' : 'pointer',
      });
    }
    if (implementors.length > 0) implementations.set(iface.nodeId, implementors);
  }

  return implementations;
}

/**
 * The key a method occupies in a method set.
 *
 * Go spec, Uniqueness of identifiers: "Two identifiers are different if they are
 * spelled differently, **or if they appear in different packages and are not
 * exported**." So an UNEXPORTED method name is scoped to its declaring package —
 * `seal` in package `sealed` is a different identifier from `seal` in package
 * `foreign`, and a type outside `sealed` can never satisfy `interface { seal() }`.
 * That is the whole basis of the sealed-interface idiom.
 *
 * Matching on the bare name made those types satisfy each other, which is a
 * FALSE implementation rather than an over-approximation. Qualifying the key
 * with the declaring package for unexported names makes the comparison exact.
 *
 * Exported names are deliberately left unqualified: the spec makes them the same
 * identifier across packages, which is what allows cross-package interface
 * satisfaction to work at all.
 */
function methodSetKey(
  simpleName: string,
  def: SymbolDefinition,
  signatureContextByDefId: ReadonlyMap<string, SignatureContext>,
): string {
  if (isExportedGoIdentifier(simpleName)) return simpleName;
  const pkg = signatureContextByDefId.get(def.nodeId)?.packageQualifier;
  return pkg === undefined ? simpleName : `${pkg}\u0000${simpleName}`;
}

/**
 * Go spec, Exported identifiers: exported iff the first character is a Unicode
 * uppercase letter (category Lu). Method names always satisfy the second clause
 * (they are method names), so the first character is the whole test.
 */
function isExportedGoIdentifier(name: string): boolean {
  const first = name.codePointAt(0);
  if (first === undefined) return false;
  const ch = String.fromCodePoint(first);
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
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
  parentStructIdsByStructId: Map<string, EmbeddedParent[]>,
  structId: string,
  parentStructId: string,
  asPointer: boolean,
): void {
  const parents = parentStructIdsByStructId.get(structId) ?? [];
  parents.push({ structId: parentStructId, asPointer });
  parentStructIdsByStructId.set(structId, parents);
}

/** The two entry maps built in parallel: MS(T) and MS(*T). */
type DualEntries = {
  readonly value: MutableMethodSetEntries;
  readonly pointer: MutableMethodSetEntries;
};

function collectStructMethodSet(
  structId: string,
  indexes: Pick<DetectionIndexes, 'methodsByOwner' | 'parentStructIdsByStructId'>,
  visiting: Set<string>,
  cache: Map<string, DualEntries>,
): DualMethodSet | undefined {
  const entries = collectStructMethodEntries(structId, indexes, visiting, cache);
  if (entries === undefined) return undefined;
  return {
    value: methodEntriesToMethodSet(entries.value),
    pointer: methodEntriesToMethodSet(entries.pointer),
  };
}

/**
 * Build MS(T) and MS(*T) together, applying the spec's promotion table exactly
 * (go.dev/ref/spec#Method_sets, #Struct_types):
 *
 *   declared receiver T   -> in MS(T) and MS(*T)
 *   declared receiver *T  -> in MS(*T) only
 *   S embeds T  (value)   -> MS(S) gets P's MS(T); MS(*S) gets P's MS(*T)
 *   S embeds *T (pointer) -> MS(S) AND MS(*S) both get P's MS(*T)
 *
 * The last row is the one that makes the embed FORM load-bearing: with
 * `func (b *Base) Ping()`, `struct{ Base }` does not implement a `Ping`
 * interface by value while `struct{ *Base }` does. Collapsing the forms gives
 * both the same answer and one of them is then wrong.
 */
function collectStructMethodEntries(
  structId: string,
  indexes: Pick<DetectionIndexes, 'methodsByOwner' | 'parentStructIdsByStructId'>,
  visiting: Set<string>,
  cache: Map<string, DualEntries>,
): DualEntries | undefined {
  const cached = cache.get(structId);
  if (cached !== undefined) {
    return { value: cloneMethodEntries(cached.value), pointer: cloneMethodEntries(cached.pointer) };
  }
  if (visiting.has(structId)) return undefined;
  visiting.add(structId);

  const own = indexes.methodsByOwner.get(structId);
  // MS(*T) holds every declared method; MS(T) drops the pointer-receiver ones.
  const pointer = directMethodEntries(own);
  const value = directMethodEntries(filterValueReceiverMethods(own));

  for (const parent of indexes.parentStructIdsByStructId.get(structId) ?? []) {
    const parentEntries = collectStructMethodEntries(parent.structId, indexes, visiting, cache);
    if (parentEntries === undefined) {
      visiting.delete(structId);
      return undefined;
    }
    // Embedding by POINTER lifts the parent's pointer-receiver methods into the
    // embedder's VALUE method set; embedding by value does not.
    const promotedIntoValue = parent.asPointer ? parentEntries.pointer : parentEntries.value;
    promoteEntries(value, promotedIntoValue);
    promoteEntries(pointer, parentEntries.pointer);
  }

  visiting.delete(structId);
  cache.set(structId, { value: cloneMethodEntries(value), pointer: cloneMethodEntries(pointer) });
  return { value, pointer };
}

/** Merge one depth-level of promoted entries, preserving the shallowest-depth
 *  and ambiguity rules the selector spec defines. */
function promoteEntries(target: MutableMethodSetEntries, source: MutableMethodSetEntries): void {
  for (const [methodName, entry] of source) {
    if (entry.ambiguous) continue;
    mergePromotedMethodEntry(target, methodName, {
      overloads: entry.overloads,
      depth: entry.depth + 1,
      ambiguous: false,
    });
  }
}

/** MS(T) excludes methods declared with a `*T` receiver. */
function filterValueReceiverMethods(methods: MethodSet | undefined): MutableMethodSet | undefined {
  if (methods === undefined) return undefined;
  const out = new Map<string, SymbolDefinition[]>();
  for (const [name, overloads] of methods) {
    const valueOnly = overloads.filter(
      (def) => (def as GoMethodDefinition).goReceiverKind !== 'pointer',
    );
    if (valueOnly.length > 0) out.set(name, valueOnly);
  }
  return out;
}

/** Receiver-kind sidecar stamped by `populateGoOwners` (method-owners.ts). */
type GoMethodDefinition = SymbolDefinition & { readonly goReceiverKind?: 'value' | 'pointer' };

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

/** The package directory, or `undefined` for a repo-root file.
 *
 *  Shares `goPackageDir` with the package-clause resolver rather than repeating
 *  its normalize-and-slice (#2837): the two disagree only on how they spell "no
 *  directory", so the difference stays here, at the one call site that cares. */
function packageQualifierForFile(filePath: string): string | undefined {
  const packageDir = goPackageDir(filePath);
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
