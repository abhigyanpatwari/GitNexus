import type { ParsedFile, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type {
  StructuralImplementationResult,
  UndecidedSatisfaction,
} from '../../scope-resolution/contract/scope-resolver.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { resolveInheritanceBaseInScope } from '../../scope-resolution/scope/walkers.js';
import { goPackageDir } from './package-clause.js';
import {
  matchingGoDelimiter,
  readGoTypeParameters,
  splitTopLevelGoList,
} from './generic-type-parameters.js';

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
/**
 * Whether a type satisfies an interface — or whether we could not tell.
 *
 * `undecided` is the state #2873 was missing. It means a required signature
 * named something we could not give an identity to (a package qualifier with no
 * recoverable import path), so the comparison was never actually performed.
 * Folding it into `unsatisfied` is what let `impact()` answer a confident zero
 * for a method that in fact had callers.
 *
 * It stays distinct from `unsatisfied` in exactly one direction: an undecided
 * pair mints NO edge (a speculative one would fan out into fabricated CALLS),
 * but it IS reported, so the answer downstream is a lower bound instead of a
 * fact. Compare `go/types`, which folds the same case the other way — its
 * `hasAllMethods` returns true for an invalid type — because a type checker's
 * job is to avoid cascading errors, not to bound a blast radius.
 */
type Verdict = 'satisfied' | 'unsatisfied' | 'undecided';
/** One structural implementor plus the form in which it implements. */
export type GoStructuralImplementor = {
  readonly structDefId: string;
  readonly receiverForm: GoReceiverForm;
};
type SignatureContext = {
  readonly packageQualifier: string | undefined;
  /** Every token this file may write before a `.`, mapped to the package it
   *  names. Keyed on the token the SOURCE uses, which is the import's local name
   *  except where that had to be recovered from the path (`…/bar/v2` -> `bar`).
   *  An `undefined` value is a name that is claimed but has no agreeable
   *  qualifier; it reads the same as an absent key at the one consumer. */
  readonly importQualifiers: ReadonlyMap<string, string | undefined>;
};
type DetectionIndexes = {
  readonly interfaces: readonly SymbolDefinition[];
  readonly structsById: ReadonlyMap<string, SymbolDefinition>;
  readonly methodsByOwner: ReadonlyMap<string, MethodSet>;
  readonly effectiveMethodsByStructId: ReadonlyMap<string, MethodSet>;
  /** Every interface in the program keyed by `qualifiedName`, `null` where more
   *  than one declares that name — the single probe behind
   *  {@link uniqueInterfaceNamed}. */
  readonly interfacesByQualifiedName: ReadonlyMap<string, SymbolDefinition | null>;
  readonly interfaceOwnMethodsById: ReadonlyMap<string, MethodSet>;
  readonly embeddedSitesByInterfaceId: ReadonlyMap<string, readonly ReferenceSite[]>;
  readonly parentStructIdsByStructId: ReadonlyMap<string, readonly EmbeddedParent[]>;
  readonly valueMethodsByStructId: ReadonlyMap<string, MethodSet>;
  readonly structIdsByMethodName: ReadonlyMap<string, ReadonlySet<string>>;
  readonly signatureContextByDefId: ReadonlyMap<string, SignatureContext>;
  /** Type-parameter names, in declaration order, for every GENERIC interface.
   *  Absence means "not generic" and is the gate on the whole instantiation
   *  path — no entry, nothing below runs. */
  readonly typeParametersByInterfaceId: ReadonlyMap<string, readonly string[]>;
  /**
   * Every distinct instantiation of each generic interface observed anywhere in
   * the program: interface id → the instantiation's normalized type ARGUMENTS,
   * keyed by that list joined — which is what deduplicates it.
   *
   * An instantiation is nothing but that list. `Repo[User]` reduces to the type
   * arguments ALREADY normalized in the signature context of the file that wrote
   * them, so a cross-package `repo.Repo[model.User]` and the implementor's own
   * `model.User` compare as the same type without either side re-qualifying the
   * other's spelling.
   */
  readonly instantiationsByInterfaceId: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly scopeIndexes: ScopeResolutionIndexes;
};

export function detectGoInterfaceImplementations(
  parsedFiles: readonly ParsedFile[],
  _indexes: ScopeResolutionIndexes,
  _model: SemanticModel,
): StructuralImplementationResult {
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
  const typeParametersByInterfaceId = new Map<string, readonly string[]>();
  const signatureContextByFilePath = new Map<string, SignatureContext>();

  for (const parsed of parsedFiles) {
    const signatureContext = signatureContextForFile(parsed, indexes);
    signatureContextByFilePath.set(parsed.filePath, signatureContext);
    for (const def of parsed.localDefs) {
      signatureContextByDefId.set(def.nodeId, signatureContext);
      if (def.type === 'Interface') {
        interfaces.push(def);
        interfaceById.set(def.nodeId, def);
        const typeParameters = readGoTypeParameters(def);
        if (typeParameters !== undefined) {
          typeParametersByInterfaceId.set(def.nodeId, typeParameters);
        }
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

  // Built from the nodeId-keyed map, so a def that appears in two ParsedFiles is
  // one interface here just as it is one there — not a name collision with
  // itself.
  const interfacesByQualifiedName = new Map<string, SymbolDefinition | null>();
  for (const iface of interfaceById.values()) {
    const name = iface.qualifiedName;
    if (name === undefined || name.length === 0) continue;
    interfacesByQualifiedName.set(name, interfacesByQualifiedName.has(name) ? null : iface);
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
    interfacesByQualifiedName,
    interfaceOwnMethodsById,
    embeddedSitesByInterfaceId,
    parentStructIdsByStructId,
    structIdsByMethodName,
    valueMethodsByStructId,
    signatureContextByDefId,
    typeParametersByInterfaceId,
    // Gated on the repo declaring at least one generic interface. A Go codebase
    // with none — the overwhelming majority — never runs the harvest at all,
    // which matters because the spellings it would scan (`[]byte`,
    // `map[string]X`) are among the commonest types in the language.
    instantiationsByInterfaceId:
      typeParametersByInterfaceId.size === 0
        ? new Map()
        : collectGoInstantiations(
            parsedFiles,
            signatureContextByFilePath,
            typeParametersByInterfaceId,
            interfacesByQualifiedName,
            indexes,
          ),
    scopeIndexes: indexes,
  };
}

/**
 * Every distinct instantiation of a generic interface written anywhere in the
 * program, resolved and deduplicated in one pass.
 *
 * Go records no instantiation anywhere on the DECLARATION — `Repo[User]` exists
 * only where it is written — so the sites are the field/parameter/variable type
 * spellings the capture layer already preserved: `TypeRef.declaredSpelling`
 * (which keeps the arguments `rawName` drops), and the def-side `declaredType` /
 * `parameterTypes` / `returnType`.
 *
 * A spelling is scanned rather than parsed as a whole, so decorated and nested
 * forms yield their inner instantiations too: `[]Repo[User]`, `*Repo[User]` and
 * `map[string]Repo[User]` all yield `Repo[User]`, and `Outer[Repo[User]]` yields
 * both — each of which really is an instantiation present in the program. False
 * bases (`map[` scans as base `map`) resolve to no interface and drop out.
 */
function collectGoInstantiations(
  parsedFiles: readonly ParsedFile[],
  signatureContextByFilePath: ReadonlyMap<string, SignatureContext>,
  typeParametersByInterfaceId: ReadonlyMap<string, readonly string[]>,
  interfacesByQualifiedName: ReadonlyMap<string, SymbolDefinition | null>,
  indexes: ScopeResolutionIndexes,
): ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> {
  // One map where there were two on the same key: the inner map's KEY is the
  // joined argument list, so holding it is the deduplication.
  const argsByInterfaceId = new Map<string, Map<string, readonly string[]>>();
  // A base name resolves once per scope. The bracket gate below cannot filter
  // Go's commonest types — `map[string]string` scans as base `map` — so the
  // FALSE bases dominate this pass, and each one otherwise re-walks the whole
  // scope chain for a name that will never bind.
  const basesInScope = new Map<string, SymbolDefinition | null>();
  const resolveBase = (baseName: string, inScope: string): SymbolDefinition | undefined => {
    // NUL-joined for the same reason `methodSetKey` is: it cannot occur in Go
    // source, so no two (scope, name) pairs can collide on one key.
    const key = `${inScope}\u0000${baseName}`;
    const memo = basesInScope.get(key);
    if (memo !== undefined) return memo ?? undefined;
    const iface = resolveGoInstantiationBase(baseName, inScope, interfacesByQualifiedName, indexes);
    basesInScope.set(key, iface ?? null);
    return iface;
  };
  const record = (
    spelling: string | undefined,
    inScope: string,
    context: SignatureContext,
  ): void => {
    // Cheap gate first: most Go type spellings have no bracket at all, and the
    // scan below is the only per-spelling cost this pass adds.
    if (spelling === undefined || !spelling.includes('[')) return;
    for (const { baseName, rawArgs } of parseGoInstantiationSpellings(spelling)) {
      const iface = resolveBase(baseName, inScope);
      if (iface === undefined) continue;
      const typeParameters = typeParametersByInterfaceId.get(iface.nodeId);
      // A partial or over-long argument list is not a valid instantiation
      // ("For a generic type, all type arguments must always be provided
      // explicitly" — go.dev/ref/spec#Instantiations), so there is nothing to
      // substitute and the site is dropped.
      if (typeParameters === undefined || typeParameters.length !== rawArgs.length) continue;
      const normalizedArgs = normalizeGoTypeArguments(rawArgs, context);
      if (normalizedArgs === undefined) continue;
      let byArgs = argsByInterfaceId.get(iface.nodeId);
      if (byArgs === undefined) {
        byArgs = new Map<string, readonly string[]>();
        argsByInterfaceId.set(iface.nodeId, byArgs);
      }
      const key = normalizedArgs.join(',');
      if (!byArgs.has(key)) byArgs.set(key, normalizedArgs);
    }
  };

  for (const parsed of parsedFiles) {
    const context = signatureContextByFilePath.get(parsed.filePath);
    if (context === undefined) continue;
    for (const scope of parsed.scopes) {
      for (const binding of scope.typeBindings.values()) {
        record(binding.declaredSpelling ?? binding.rawName, scope.id, context);
      }
      for (const def of scope.ownedDefs) {
        record(def.declaredType, scope.id, context);
        record(def.returnType, scope.id, context);
        for (const parameterType of def.parameterTypes ?? []) {
          record(parameterType, scope.id, context);
        }
      }
    }
  }
  return argsByInterfaceId;
}

/** Every `Ident[…]` / `pkg.Ident[…]` application in a type spelling, with its
 *  top-level (comma-separated, delimiter-balanced) arguments. */
function parseGoInstantiationSpellings(
  spelling: string,
): Array<{ readonly baseName: string; readonly rawArgs: readonly string[] }> {
  const out: Array<{ baseName: string; rawArgs: string[] }> = [];
  const namePattern = /[A-Za-z_][A-Za-z0-9_.]*(?=\[)/g;
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(spelling)) !== null) {
    const open = match.index + match[0].length;
    const close = matchingGoDelimiter(spelling, open);
    if (close === -1) continue;
    const rawArgs = splitTopLevelGoList(spelling.slice(open + 1, close));
    if (rawArgs.length === 0) continue;
    out.push({ baseName: match[0], rawArgs });
  }
  return out;
}

/** Normalize each type argument in the context of the file that WROTE it, or
 *  `undefined` when any of them carries an unresolvable import qualifier — a
 *  half-normalized argument list would compare against nothing meaningful. */
function normalizeGoTypeArguments(
  rawArgs: readonly string[],
  context: SignatureContext,
): string[] | undefined {
  const normalizedArgs: string[] = [];
  for (const rawArg of rawArgs) {
    const normalized = normalizeSignatureType(rawArg, context);
    if (normalized === undefined) return undefined;
    normalizedArgs.push(normalized);
  }
  return normalizedArgs;
}

/**
 * Bind an instantiation's base name to the generic interface it names.
 *
 * Goes through `resolveInheritanceBaseInScope` first — the same real scope
 * resolution the embedded-interface path uses — and falls back to a globally
 * UNIQUE name match.
 */
function resolveGoInstantiationBase(
  baseName: string,
  inScope: string,
  interfacesByQualifiedName: ReadonlyMap<string, SymbolDefinition | null>,
  indexes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  const bound = resolveInheritanceBaseInScope(inScope, simpleTypeName(baseName), indexes);
  if (bound !== undefined) return bound.type === 'Interface' ? bound : undefined;
  return uniqueInterfaceNamed(baseName, interfacesByQualifiedName);
}

/**
 * The one interface a written name denotes by NAME ALONE — the fallback both
 * name-match routes here share, once the real scope resolution above them has
 * declined.
 *
 * Ambiguity drops the site rather than guessing: two same-named interfaces in
 * different packages would otherwise cross-pollinate each other's
 * instantiations, and a dropped site only costs fan-out that does not exist
 * today anyway. A qualified spelling is tried under both its own name and its
 * simple tail, and a hit under EACH is two matches, so it declines as well.
 *
 * One probe rather than a scan of every interface in the program, which is what
 * made this quadratic: the bracket gate in `collectGoInstantiations` cannot
 * filter `map[…]` or `[]T`, so a Go program pays this once per bracketed
 * spelling it writes.
 */
function uniqueInterfaceNamed(
  name: string,
  interfacesByQualifiedName: ReadonlyMap<string, SymbolDefinition | null>,
): SymbolDefinition | undefined {
  const exact = interfacesByQualifiedName.get(name);
  if (exact === null) return undefined;
  const simpleName = simpleTypeName(name);
  if (simpleName === name) return exact;
  const simple = interfacesByQualifiedName.get(simpleName);
  if (simple === null) return undefined;
  if (exact !== undefined && simple !== undefined) return undefined;
  return exact ?? simple;
}

function detectGoInterfaceImplementationsFromIndexes(
  indexes: DetectionIndexes,
): StructuralImplementationResult {
  const implementations = new Map<string, GoStructuralImplementor[]>();
  const undecided: UndecidedSatisfaction[] = [];
  const methodSetCache = new Map<string, MutableMethodSet>();
  for (const iface of indexes.interfaces) {
    const required = collectInterfaceMethodSet(iface, indexes, new Set(), methodSetCache);
    if (required === undefined || required.size === 0) continue;
    if (!methodSetHasVerifiableSignatures(required)) continue;

    // Hoisted, not recomputed per set: `substituteMethodSet` rewrites
    // SIGNATURES and returns the identical key set, and `candidateStructIdsFor`
    // keys off nothing but those method names — so every set below has exactly
    // these candidates. Materialized because it is iterated once per
    // instantiation and one of the branches behind it yields a live iterator.
    const candidateStructIds = [...candidateStructIdsFor(required, indexes)];
    // The declaration's own method set, then one per observed instantiation.
    // The declaration set runs FIRST and unconditionally, so this is strictly
    // additive: every implementor found before #2855 is still found, in the
    // same order, and instantiation only ever appends.
    const formByStructId = new Map<string, GoReceiverForm>();
    const undecidedStructIds = new Set<string>();
    for (const candidateSet of [required, ...instantiatedMethodSetsFor(iface, required, indexes)]) {
      for (const structId of candidateStructIds) {
        if (formByStructId.get(structId) === 'value') continue;
        const pointerSet = indexes.effectiveMethodsByStructId.get(structId);
        if (pointerSet === undefined) continue;
        // MS(*T) is the superset: if it does not satisfy, neither does MS(T).
        const verdict = methodSetSatisfies(
          pointerSet,
          candidateSet,
          indexes.signatureContextByDefId,
        );
        if (verdict !== 'satisfied') {
          // `undecided` mints no edge — a speculative IMPLEMENTS would fan out
          // into fabricated CALLS through `emitReceiverBoundCalls`. It is
          // recorded instead, so `impact` can report a lower bound rather than
          // a confident zero (#2873). A decided `unsatisfied` records nothing:
          // that answer is trustworthy.
          if (verdict === 'undecided') undecidedStructIds.add(structId);
          continue;
        }
        // Then ask the narrower question separately — does the VALUE type satisfy?
        // This is the distinction `var x I = T{}` turns on, and it is a fact about
        // the program, not a heuristic.
        const valueSet = indexes.valueMethodsByStructId.get(structId);
        const satisfiesByValue =
          valueSet !== undefined &&
          methodSetSatisfies(valueSet, candidateSet, indexes.signatureContextByDefId) ===
            'satisfied';
        formByStructId.set(structId, satisfiesByValue ? 'value' : 'pointer');
        undecidedStructIds.delete(structId);
      }
    }
    const implementors: GoStructuralImplementor[] = [...formByStructId].map(
      ([structDefId, receiverForm]) => ({ structDefId, receiverForm }),
    );
    if (implementors.length > 0) implementations.set(iface.nodeId, implementors);
    if (undecidedStructIds.size > 0) {
      undecided.push({
        interfaceDefId: iface.nodeId,
        interfaceName: iface.qualifiedName,
        filePath: iface.filePath,
        undecidedCandidates: undecidedStructIds.size,
      });
    }
  }

  return { implementations, undecided };
}

/**
 * The method set of each observed INSTANTIATION of a generic interface.
 *
 * Go spec, Instantiations: "A generic function or type is instantiated by
 * substituting type arguments for the type parameters. … Each type argument is
 * substituted for its corresponding type parameter in the generic declaration. …
 * Instantiating a type results in a new non-generic named type." Combined with
 * Type definitions ("Generic types must be instantiated when they are used") the
 * consequence is that `Repo` is not a type at all and `Repo[User]` is — with
 * method set `{ Save(x User) }` after substitution. Implementing an interface
 * then asks whether a type "is an element of the type set of I", and Basic
 * interfaces defines that type set as "the set of types which implement all of
 * those methods". `UserRepo`, whose method set contains `Save(x User)`, is an
 * element of `Repo[User]`'s type set — so it implements `Repo[User]`, and a call
 * through a `Repo[User]`-typed field really can land on `UserRepo.Save`. Before
 * this, it could not: the required parameter type stayed the type PARAMETER `T`,
 * matched no implementor's `User`, and the interface got no IMPLEMENTS edge at
 * all. That is the same false-silence shape as #2813/#2829, one abstraction up.
 *
 * SUBSTITUTION, NOT ERASURE. `Repo[Order]` instantiates to `Save(x Order)` and
 * is NOT satisfied by a `Save(x User)` implementor. Treating `T` as a wildcard
 * would satisfy both and mint an edge Go does not have; the whole point of
 * #2829 was that an exact model beats an approximate one.
 *
 * WHAT THIS DELIBERATELY DOES NOT MODEL. GitNexus holds one node per generic
 * DECLARATION, not one per instantiation, so an interface instantiated at two
 * different arguments in the same program unions their implementors onto the one
 * `Repo` node — `Repo[User]` and `Repo[Order]` in the same repo both fan out to
 * every type satisfying either. That is the same one-node-per-declaration
 * over-approximation every nominal language in the graph already carries (a
 * Kotlin `class UserRepo : Repo<User>` yields `UserRepo IMPLEMENTS Repo`, argument
 * discarded), and it is bounded by the arguments the program actually writes —
 * strictly narrower than erasure, which admits arguments that appear nowhere.
 *
 * Constraints are out of reach by construction and that is correct: a generic
 * interface used as a CONSTRAINT (`func F[T Repo[X]](…)`) is written in a type
 * parameter list, which produces no type binding and no declared type, so no
 * such site is ever harvested. Non-basic interfaces — the union/type-set kind
 * that "may only be used as type constraints" (General interfaces) — declare no
 * methods and are already dropped by the empty-method-set guard above.
 */
function instantiatedMethodSetsFor(
  iface: SymbolDefinition,
  required: MethodSet,
  indexes: DetectionIndexes,
): MethodSet[] {
  const typeParameters = indexes.typeParametersByInterfaceId.get(iface.nodeId);
  if (typeParameters === undefined) return [];
  const instantiations = indexes.instantiationsByInterfaceId.get(iface.nodeId);
  if (instantiations === undefined || instantiations.size === 0) return [];
  const indexByName = new Map(typeParameters.map((name, index) => [name, index]));
  const sets: MethodSet[] = [];
  for (const normalizedArgs of instantiations.values()) {
    const substituted = substituteMethodSet(
      required,
      indexByName,
      normalizedArgs,
      indexes.signatureContextByDefId,
    );
    if (substituted !== undefined) sets.push(substituted);
  }
  return sets;
}

/**
 * Rewrite a required method set under one instantiation, or `undefined` when any
 * signature in it cannot be normalized (an unresolved import qualifier) — a
 * partially substituted set would compare a mix of instantiated and
 * uninstantiated types, so the instantiation is dropped whole.
 *
 * The substituted defs carry a synthetic node id that is deliberately absent
 * from `signatureContextByDefId`. Their parameter/return types come out of here
 * ALREADY normalized — the type arguments in the context that WROTE them, the
 * rest in the interface's own — and `normalizeSignatureType` with no context is
 * the identity beyond whitespace, so the comparison in `signaturesCompatible`
 * cannot re-qualify a spelling that is already fully qualified.
 */
function substituteMethodSet(
  required: MethodSet,
  indexByName: ReadonlyMap<string, number>,
  normalizedArgs: readonly string[],
  signatureContextByDefId: ReadonlyMap<string, SignatureContext>,
): MutableMethodSet | undefined {
  const out = new Map<string, SymbolDefinition[]>();
  for (const [name, overloads] of required) {
    const substitutedOverloads: SymbolDefinition[] = [];
    for (const def of overloads) {
      const context = signatureContextByDefId.get(def.nodeId);
      const parameterTypes: string[] = [];
      for (const parameterType of def.parameterTypes ?? []) {
        const substituted = substituteSignatureType(
          parameterType,
          indexByName,
          normalizedArgs,
          context,
        );
        if (substituted === undefined) return undefined;
        parameterTypes.push(substituted);
      }
      let returnType: string | undefined;
      if (def.returnType !== undefined) {
        returnType = substituteSignatureType(def.returnType, indexByName, normalizedArgs, context);
        if (returnType === undefined) return undefined;
      }
      substitutedOverloads.push({
        ...def,
        nodeId: `${def.nodeId}\u0000instantiated`,
        ...(def.parameterTypes !== undefined ? { parameterTypes } : {}),
        ...(returnType !== undefined ? { returnType } : {}),
      });
    }
    out.set(name, substitutedOverloads);
  }
  return out;
}

/**
 * Placeholder for the type argument at position `i` while its enclosing type is
 * normalized. NUL-delimited — the same separator `methodSetKey` already uses,
 * and for the same reason: it cannot occur in Go source.
 *
 * Both halves of that choice are load-bearing. `qualifyGoSignatureTypes` rewrites
 * only tokens matching `[A-Za-z_][A-Za-z0-9_]*`, which can start with neither NUL
 * nor a digit, so the placeholder survives normalization untouched; and
 * `normalizeSignatureType` strips `\s+` FIRST, so a whitespace-delimited
 * placeholder would lose its delimiters and become indistinguishable from an
 * array length (`[5]int`).
 */
const TYPE_PARAMETER_PLACEHOLDER = /\u0000(\d+)\u0000/g;

/**
 * Substitute type arguments into one signature type, preserving Go's type
 * identity rules for everything around them.
 *
 * Substitution happens BEFORE normalization and reinstatement AFTER, so the
 * argument's own spelling is never re-qualified by the interface's package while
 * the rest of the type still is: `[]T` in package `repo` with argument
 * `internal/model.User` yields `[]internal/model.User`, not
 * `[]repo.internal/model.User`. Pointer, slice, map and variadic shape survive
 * because only the identifier token is replaced (`*T` -> `*model.User`), which is
 * what makes `Save(x T)` and `Save(x *T)` stay different methods.
 */
function substituteSignatureType(
  typeName: string,
  indexByName: ReadonlyMap<string, number>,
  normalizedArgs: readonly string[],
  context: SignatureContext | undefined,
): string | undefined {
  const placeheld = typeName.replace(
    /[A-Za-z_][A-Za-z0-9_]*/g,
    (token, offset: number, source: string) => {
      // `pkg.T` names `T` in package `pkg`, never the type parameter `T`.
      if (hasPackageQualifierDot(source, offset)) return token;
      const index = indexByName.get(token);
      return index === undefined ? token : `\u0000${index}\u0000`;
    },
  );
  const normalized = normalizeSignatureType(placeheld, context);
  if (normalized === undefined) return undefined;
  return normalized.replace(TYPE_PARAMETER_PLACEHOLDER, (_match, digits: string) => {
    return normalizedArgs[Number(digits)] ?? _match;
  });
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
  return uniqueInterfaceNamed(site.name, indexes.interfacesByQualifiedName);
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
): Verdict {
  let undecided = false;
  for (const [name, requiredOverloads] of required) {
    const actualOverloads = actual.get(name);
    if (actualOverloads === undefined) return 'unsatisfied';
    for (const requiredMethod of requiredOverloads) {
      // Fast arity pre-filter: if the required method has a known parameter
      // count, reject immediately when no actual overload matches it. This
      // avoids the expensive signature normalization loop for obvious mismatches.
      if (requiredMethod.parameterCount !== undefined) {
        if (!actualOverloads.some((a) => a.parameterCount === requiredMethod.parameterCount)) {
          return 'unsatisfied';
        }
      }
      const verdict = compatibleMethodVerdict(
        actualOverloads,
        requiredMethod,
        signatureContextByDefId,
      );
      // A decided mismatch anywhere ends it — a type that provably lacks ONE
      // required method does not implement the interface, however many other
      // methods we could not read. Undecided keeps scanning for exactly that
      // reason: a hard no may still be waiting, and it is the better answer.
      if (verdict === 'unsatisfied') return 'unsatisfied';
      if (verdict === 'undecided') undecided = true;
    }
  }
  return undecided ? 'undecided' : 'satisfied';
}

function compatibleMethodVerdict(
  actualOverloads: readonly SymbolDefinition[],
  requiredMethod: SymbolDefinition,
  signatureContextByDefId: ReadonlyMap<string, SignatureContext>,
): Verdict {
  // Nothing in the interface's own method to compare against: this is missing
  // information, not a difference. It was a `false` before #2873.
  if (!hasVerifiableSignature(requiredMethod)) return 'undecided';
  let undecided = false;
  for (const actualMethod of actualOverloads) {
    const verdict = signaturesCompatible(actualMethod, requiredMethod, signatureContextByDefId);
    // One overload that provably matches settles the method — the unknowns on
    // the others cannot unsettle it. (Pyright does the same: a resolvable path
    // suppresses the partially-unknown diagnostic from the others.)
    if (verdict === 'satisfied') return 'satisfied';
    if (verdict === 'undecided') undecided = true;
  }
  return undecided ? 'undecided' : 'unsatisfied';
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
): Verdict {
  const actualContext = signatureContextByDefId.get(actual.nodeId);
  const requiredContext = signatureContextByDefId.get(required.nodeId);
  if (
    !countsCompatible(actual.parameterCount, required.parameterCount) ||
    !countsCompatible(actual.requiredParameterCount, required.requiredParameterCount)
  ) {
    return 'unsatisfied';
  }
  // A decided mismatch beats an unknown — it is the answer we can stand behind —
  // so the parameter verdict only short-circuits when it is `unsatisfied`.
  const parameters = parameterTypesVerdict(actual, required, actualContext, requiredContext);
  if (parameters === 'unsatisfied') return 'unsatisfied';
  const returns = returnTypeVerdict(
    actual.returnType,
    required.returnType,
    actualContext,
    requiredContext,
  );
  if (returns === 'unsatisfied') return 'unsatisfied';
  return parameters === 'undecided' || returns === 'undecided' ? 'undecided' : 'satisfied';
}

function countsCompatible(actual: number | undefined, required: number | undefined): boolean {
  return actual === undefined || required === undefined || actual === required;
}

function parameterTypesVerdict(
  actualDef: SymbolDefinition,
  requiredDef: SymbolDefinition,
  actualContext: SignatureContext | undefined,
  requiredContext: SignatureContext | undefined,
): Verdict {
  const actual = actualDef.parameterTypes;
  const required = requiredDef.parameterTypes;
  if (actual === undefined || required === undefined) {
    // A method that takes nothing has no list to carry — that is a decided
    // agreement, not a gap, and it is the shape of every `Close() error`.
    if (actualDef.parameterCount === 0 && requiredDef.parameterCount === 0) return 'satisfied';
    // Otherwise the types really are unread. This is where the old code assumed
    // `true` and called two signatures compatible without comparing them.
    return 'undecided';
  }
  if (actual.length !== required.length) return 'unsatisfied';
  // Indexed loop, not `entries()`: this is the innermost comparison in the
  // detection pass and runs once per parameter per candidate pair.
  let undecided = false;
  for (let index = 0; index < actual.length; index++) {
    const verdict = typeVerdict(actual[index]!, required[index]!, actualContext, requiredContext);
    if (verdict === 'unsatisfied') return 'unsatisfied';
    if (verdict === 'undecided') undecided = true;
  }
  return undecided ? 'undecided' : 'satisfied';
}

function returnTypeVerdict(
  actual: string | undefined,
  required: string | undefined,
  actualContext: SignatureContext | undefined,
  requiredContext: SignatureContext | undefined,
): Verdict {
  if (required === undefined) return actual === undefined ? 'satisfied' : 'unsatisfied';
  if (actual === undefined) return 'unsatisfied';
  return typeVerdict(actual, required, actualContext, requiredContext);
}

/** The one place a type spelling decides anything, and the only mint site of
 *  `undecided` below the method level: `normalizeSignatureType` returns
 *  `undefined` when a package qualifier has no identity we could recover, and
 *  two spellings we could not normalize are not thereby different. */
function typeVerdict(
  actual: string,
  required: string,
  actualContext: SignatureContext | undefined,
  requiredContext: SignatureContext | undefined,
): Verdict {
  const actualType = normalizeSignatureType(actual, actualContext);
  const requiredType = normalizeSignatureType(required, requiredContext);
  if (actualType === undefined || requiredType === undefined) return 'undecided';
  return actualType === requiredType ? 'satisfied' : 'unsatisfied';
}

/** Normalized form of every type spelling seen in a file, keyed by its context.
 *
 *  Normalization is a pure function of (spelling, context), and a context is
 *  immutable once built — so this is a cache, not state. It earns its keep
 *  because #2873 removed the early bail: a parameter list that named an
 *  out-of-repo type used to normalize to `undefined` and stop the comparison at
 *  parameter 0, and now every pair of (interface method, candidate struct) walks
 *  its whole signature, re-normalizing both sides once per candidate. */
const normalizedTypesByContext = new WeakMap<SignatureContext, Map<string, string | undefined>>();

function normalizeSignatureType(typeName: string, context?: SignatureContext): string | undefined {
  // Go type identity includes pointer/slice/map/variadic shape and package
  // qualifiers. Only erase whitespace and qualify bare local type names; stripping
  // `*`, `[]`, `...`, or `pkg.` would make non-identical signatures compare equal.
  const compact = typeName.replace(/\s+/g, '');
  if (context === undefined) return compact;
  let normalized = normalizedTypesByContext.get(context);
  if (normalized === undefined) {
    normalized = new Map();
    normalizedTypesByContext.set(context, normalized);
  }
  // `has`, not a truthiness check: `undefined` — "no agreeable identity" — is
  // itself a result worth caching, and it is the one this file mints most.
  if (normalized.has(compact)) return normalized.get(compact);
  const qualified = qualifyGoSignatureTypes(compact, context);
  normalized.set(compact, qualified);
  return qualified;
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
  // A key present with an `undefined` value means "in-repo, but no directory to
  // name it by" — a repo-ROOT package, whose own file spells its types bare, so
  // no qualifier either side can agree on exists. It still has to occupy the
  // name, or the fallback below would label a repo package external.
  const importQualifiers = new Map<string, string | undefined>();
  const importEdges = indexes.imports?.get(parsed.moduleScope) ?? [];
  for (const edge of importEdges) {
    if (edge.kind !== 'namespace' || edge.targetFile === null) continue;
    importQualifiers.set(edge.localName, packageQualifierForFile(edge.targetFile));
  }
  // An import that resolves to no file in the repository — every stdlib and
  // third-party package — still has an identity: its import path, which the
  // parsed directive kept even though the finalized `ImportEdge` did not (#2873).
  // Without this fallback `ctx context.Context` normalized to `undefined`, and
  // `undefined` reads as "signatures differ" on both sides at once, so two
  // textually identical methods compared unequal and Go interface satisfaction
  // only ever succeeded for builtin-only signatures.
  for (const directive of parsed.parsedImports) {
    if (directive.kind !== 'namespace') continue;
    const token = goImportToken(directive.localName, directive.targetRaw);
    // The edges ran first, so a token an in-repo import already claimed keeps
    // its package directory — the fallback fills gaps, it does not compete.
    if (importQualifiers.has(token)) continue;
    importQualifiers.set(token, externalPackageQualifier(directive.targetRaw));
  }
  return {
    packageQualifier: packageQualifierForFile(parsed.filePath),
    importQualifiers,
  };
}

/** Identity for a package that lives outside the repository.
 *
 *  The import path is the exact identity — `net/http` and `example.com/x/http`
 *  are different packages that both spell their qualifier `http`, so keying on
 *  the local name would make them compare equal. The prefix keeps the result in
 *  a namespace no in-repo qualifier can reach: no package directory can begin
 *  with the literal `extern:`. */
function externalPackageQualifier(importPath: string): string {
  return `extern:${importPath}`;
}

/** The token Go source writes before the `.` for this import.
 *
 *  An alias names its own token, so it is returned as-is. An unaliased import
 *  arrives here spelled as the last path segment, which is right until a module
 *  carries a major version: `github.com/foo/bar/v2` is written `bar` and
 *  `gopkg.in/yaml.v3` is written `yaml`, per the rule the go tool applies.
 *
 *  Deriving "aliased" from the path rather than from `importedName` is
 *  deliberate — the Go extractor sets both names to the alias when there is one
 *  (`import-decomposer.ts`), so the two fields never disagree.
 *
 *  A package whose name diverges from its path for any OTHER reason cannot be
 *  recovered without reading the dependency's own source, which is by definition
 *  outside the repository. Those stay unresolved, which is the safe direction. */
function goImportToken(localName: string, importPath: string): string {
  const segments = importPath.split('/').filter((segment) => segment.length > 0);
  const leaf = segments.pop() ?? importPath;
  if (localName !== leaf) return localName;
  const name = /^v\d+$/.test(leaf) ? (segments.pop() ?? leaf) : leaf;
  return name.replace(/\.v\d+$/, '');
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
