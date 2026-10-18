/**
 * `resolveReferenceSites` — drain `ReferenceSite[]` from a finalized
 * `ScopeResolutionIndexes` into a `ReferenceIndex` by routing each site
 * through the appropriate scope-aware `Registry.lookup` (RFC §3.2 Phase 4).
 *
 * This is the missing producer that `emit-references.ts` (#925) was
 * waiting on. The two together form the registry-primary resolution
 * pipeline:
 *
 *     ScopeResolutionIndexes.referenceSites
 *        │  resolveReferenceSites
 *        ▼
 *     ReferenceIndex
 *        │  emitReferencesToGraph
 *        ▼
 *     graph: CALLS / ACCESSES / INHERITS / USES edges
 *
 * ## What this module does
 *
 *   - For each `ReferenceSite`, picks the registry by `kind`:
 *     · `call` / `inherits`        → MethodRegistry / ClassRegistry (call-form aware)
 *     · `read` / `write`           → FieldRegistry  (falls through to MethodRegistry for free names)
 *     · `type-reference`           → ClassRegistry
 *     · `import-use`               → all three (best-effort name-lookup)
 *   - Calls `Registry.lookup` with the site's `inScope`, optional
 *     explicit receiver, and arity.
 *   - Takes the top-ranked `Resolution` (best by confidence + tie-break
 *     cascade); folds it into a `Reference` record and bins by source scope.
 *
 * ## What this module does NOT do
 *
 *   - No AST walks. The `ReferenceSite[]` is already extracted.
 *   - No language switches. Per-language behavior flows through
 *     `RegistryProviders.arityCompatibility` (see `RegistryContext`).
 *   - No multi-candidate fan-out. We pick `[0]` per RFC §4.3 ("one-shot
 *     answer"). The full ranked list is preserved in the per-site
 *     resolution but not emitted as multiple edges; callers that want
 *     branch-on-ambiguity behavior should consume the registries directly.
 */

import {
  buildClassRegistry,
  buildFieldRegistry,
  buildMacroRegistry,
  buildMethodRegistry,
  CLASS_KINDS,
  EvidenceWeights,
  FIELD_KINDS,
  lookupLexicalName,
  METHOD_KINDS,
  type ClassRegistry,
  type FieldRegistry,
  type MacroRegistry,
  type MethodRegistry,
  type NameClaimResult,
  type Reference,
  type ReferenceIndex,
  type ReferenceSite,
  type RegistryContext,
  type RegistryProviders,
  type Resolution,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from './model/scope-resolution-indexes.js';
import {
  bindsTypeParameter,
  findClassBindingInScope,
  findEnclosingClassDef,
  lookupNameClaim,
  resolveQualifiedInheritanceBase,
} from './scope-resolution/scope/walkers.js';
import { normalizeQualifiedName } from './utils/qualified-name.js';
import {
  sourceBindingForDefinition,
  type SourceBindingRecorder,
} from './scope-resolution/source-binding-resolution.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ResolveReferencesInput {
  readonly scopes: ScopeResolutionIndexes;
  /** Provider hooks consumed by the registries (e.g. `arityCompatibility`). */
  readonly providers?: RegistryProviders;
  /** Required owner-keyed member lookup used by Step 2 receiver/MRO walks. */
  readonly ownedMembersByOwner: RegistryContext['ownedMembersByOwner'];
  readonly recordSourceBinding?: SourceBindingRecorder;
  /**
   * `ScopeResolver.isNamespaceMemberVisible`, bound to the provider. Consulted
   * for a type written through a namespace import (`x: ns.Type`): a declaration
   * the language will not let that qualifier reach yields no resolution. Absent
   * (the default) accepts whatever the namespace's target files declare.
   */
  readonly isNamespaceMemberVisible?: (def: SymbolDefinition) => boolean;
}

export interface ResolveStats {
  readonly sitesProcessed: number;
  readonly referencesEmitted: number;
  /**
   * Sites that produced no `Reference`. Almost always "the registry returned no
   * candidates", but it also counts a site declined before lookup because the
   * name is bound as a type parameter here (#2899) — a shadowed annotation names
   * no symbol in the graph, so "resolved to nothing" is the honest bucket for it.
   */
  readonly unresolved: number;
}

export interface ResolveReferencesOutput {
  readonly referenceIndex: ReferenceIndex;
  readonly stats: ResolveStats;
}

/** Preserve every candidate for callers that must reject ambiguous edits. */
export function createReferenceLookup(
  input: ResolveReferencesInput,
): (site: ReferenceSite) => readonly Resolution[] {
  const scopes = input.scopes;
  let currentSite: ReferenceSite | undefined;
  let lexicalClaim: NameClaimResult | undefined;
  const ctx: RegistryContext = {
    // Finalized call candidates belong to the provider-aware free-call and
    // receiver passes, which enforce ownership and edge deduplication. Keep
    // the primary call registry lexical; value/type reads still need imports.
    lexicalLookup: (scope, name, options) =>
      currentSite?.kind === 'call'
        ? lookupLexicalName(scope, name, { scopes: scopes.scopeTree }, options)
        : lookupNameClaim(scope, name, scopes, options),
    onLexicalClaim:
      input.recordSourceBinding === undefined
        ? undefined
        : (name, claim) => {
            if (name === currentSite?.name) lexicalClaim = claim;
          },
    scopes: scopes.scopeTree,
    defs: scopes.defs,
    qualifiedNames: scopes.qualifiedNames,
    moduleScopes: scopes.moduleScopes,
    ownedMembersByOwner: input.ownedMembersByOwner,
    methodDispatch: scopes.methodDispatch,
    providers: input.providers ?? {},
  };
  const classes = buildClassRegistry(ctx);
  const methods = buildMethodRegistry(ctx);
  const fields = buildFieldRegistry(ctx);
  const macros = buildMacroRegistry(ctx);
  return (site) => {
    if (site.kind === 'type-reference' && site.rawQualifiedName !== undefined) {
      const scope = site.lookupScope ?? site.inScope;
      const qualified = normalizeQualifiedName(site.rawQualifiedName);
      const root = qualified.split('.', 1)[0]!;
      const options = { position: site.atRange, purpose: site.lookupPurpose ?? ('type' as const) };
      const claim = lookupNameClaim(scope, root, scopes, options);
      if (
        claim.status === 'blocked' ||
        bindsTypeParameter(scope, root, scopes) ||
        (claim.bindings.length > 0 &&
          claim.bindings.every(
            ({ def }) =>
              !CLASS_KINDS.includes(def.type) && def.type !== 'Namespace' && def.type !== 'Module',
          ))
      ) {
        input.recordSourceBinding?.(site, {
          status: 'blocked',
          targetDefIds: [],
          basis: 'qualified-type-root',
        });
        return [];
      }
      // Namespace aliases are file handles; imported type/module definitions
      // are owners. Preserve the former's file constraint and require the
      // latter to own the exact qualified declaration.
      const namespaceImport = claim.imports.some((edge) => edge.kind === 'namespace');
      const definition = namespaceImport
        ? findClassBindingInScope(scope, qualified, scopes, undefined, {
            ...options,
            uniqueQualifiedNameFallback: false,
            namespaceMemberVisible: input.isNamespaceMemberVisible,
          })
        : resolveQualifiedInheritanceBase(
            scope,
            site.rawQualifiedName,
            scopes,
            findEnclosingClassDef(scope, scopes),
          );
      if (
        definition === undefined ||
        (!namespaceImport &&
          ((claim.imports.length > 0 && claim.bindings.length === 0) ||
            !claim.bindings.every(({ def }) => qualifierOwnsDefinition(def, definition, scopes))))
      ) {
        input.recordSourceBinding?.(site, {
          status: 'unresolved',
          targetDefIds: [],
          basis: 'qualified-type',
        });
        return [];
      }
      const resolution: Resolution = {
        def: definition,
        confidence: Math.min(1, EvidenceWeights.globalQualified + EvidenceWeights.kindMatch),
        evidence: [
          { kind: 'global-qualified', weight: EvidenceWeights.globalQualified },
          { kind: 'kind-match', weight: EvidenceWeights.kindMatch },
        ],
      };
      input.recordSourceBinding?.(site, {
        ...sourceBindingForDefinition(definition, 'qualified-type'),
        evidence: resolution.evidence,
      });
      return [resolution];
    }
    currentSite = site;
    lexicalClaim = undefined;
    const resolutions = lookupForSite(
      site,
      classes,
      methods,
      fields,
      macros,
      scopes,
      input.recordSourceBinding,
    );
    const claim = lexicalClaim as NameClaimResult | undefined;
    if (input.recordSourceBinding !== undefined) {
      if (resolutions.length > 0) {
        const targetDefIds = [...new Set(resolutions.map((resolution) => resolution.def.nodeId))];
        const evidence = resolutions.flatMap((resolution) => resolution.evidence);
        const hasFallback = evidence.some(
          (item) =>
            item.kind === 'global-name' ||
            item.kind === 'global-qualified' ||
            item.kind === 'dynamic-import-unresolved' ||
            (item.kind === 'arity-match' && item.weight < 0),
        );
        input.recordSourceBinding(site, {
          ...sourceBindingForDefinition(
            resolutions[0]!.def,
            hasFallback ? 'registry-fallback' : 'registry',
            claim?.bindings,
            claim?.scope?.id,
          ),
          status: hasFallback ? 'unresolved' : targetDefIds.length === 1 ? 'resolved' : 'ambiguous',
          targetDefIds,
          ...(!hasFallback &&
          targetDefIds.length > 1 &&
          targetDefIds.every((id) => claim?.bindings.some((binding) => binding.def.nodeId === id))
            ? { candidatesComplete: true as const }
            : {}),
          evidence,
        });
      } else if (claim !== undefined && claim.status !== 'absent') {
        input.recordSourceBinding(site, {
          status: 'blocked',
          targetDefIds: [],
          basis: 'lexical-name-claim',
        });
      }
    }
    currentSite = undefined;
    return resolutions;
  };
}

function qualifierOwnsDefinition(
  qualifier: SymbolDefinition,
  definition: SymbolDefinition,
  scopes: ScopeResolutionIndexes,
): boolean {
  const visited = new Set<string>();
  for (
    let owner: SymbolDefinition | undefined = definition;
    owner !== undefined && !visited.has(owner.nodeId);
    owner = owner.ownerId === undefined ? undefined : scopes.defs.get(owner.ownerId)
  ) {
    if (owner.nodeId === qualifier.nodeId) return true;
    visited.add(owner.nodeId);
  }
  // Namespace declarations can be distributed across files. Their full semantic
  // qualification, unlike a class-valued local binding, identifies the owner.
  if (qualifier.type !== 'Namespace' && qualifier.type !== 'Module') return false;
  const prefix = normalizeQualifiedName(qualifier.qualifiedName ?? '');
  return (
    prefix.length > 0 &&
    normalizeQualifiedName(definition.qualifiedName ?? '').startsWith(`${prefix}.`)
  );
}

/**
 * Resolve every `ReferenceSite` in `scopes.referenceSites` against the
 * matching registry and produce a `ReferenceIndex` keyed by source scope
 * + target def.
 */
export function resolveReferenceSites(input: ResolveReferencesInput): ResolveReferencesOutput {
  const { scopes } = input;
  const lookup = createReferenceLookup(input);

  // bySourceScope is the canonical index; byTargetDef is derived from it.
  const bySourceScope = new Map<ScopeId, Reference[]>();
  const byTargetDef = new Map<string, Reference[]>();

  let sitesProcessed = 0;
  let referencesEmitted = 0;
  let unresolved = 0;

  for (const site of scopes.referenceSites) {
    // value-ref sites resolve post-finalize (imports live in finalized
    // bindings the registries can't see — same reason free calls need
    // `emitFreeCallFallback`). `emitPropertyDispatchCalls` owns their
    // resolution and emission entirely (#2437).
    if (site.kind === 'value-ref') continue;
    sitesProcessed++;

    const resolutions = lookup(site);
    if (resolutions.length === 0) {
      unresolved++;
      continue;
    }

    const top = resolutions[0]!;
    const ref = buildReference(site, top);
    referencesEmitted++;

    // Source grouping follows the graph caller; lookup has already used the
    // site's lexical environment, which may differ for a framework invocation.
    let bySource = bySourceScope.get(ref.fromScope);
    if (bySource === undefined) {
      bySource = [];
      bySourceScope.set(ref.fromScope, bySource);
    }
    bySource.push(ref);

    let byTarget = byTargetDef.get(top.def.nodeId);
    if (byTarget === undefined) {
      byTarget = [];
      byTargetDef.set(top.def.nodeId, byTarget);
    }
    byTarget.push(ref);
  }

  // Freeze inner arrays so consumers don't accidentally mutate.
  const frozenBySource = new Map<ScopeId, readonly Reference[]>();
  for (const [k, v] of bySourceScope) frozenBySource.set(k, Object.freeze([...v]));
  const frozenByTarget = new Map<string, readonly Reference[]>();
  for (const [k, v] of byTargetDef) frozenByTarget.set(k, Object.freeze([...v]));

  return {
    referenceIndex: { bySourceScope: frozenBySource, byTargetDef: frozenByTarget },
    stats: { sitesProcessed, referencesEmitted, unresolved },
  };
}

// ─── Internal ───────────────────────────────────────────────────────────────

/**
 * Pick the right registry for the site's `kind` and call `lookup`.
 *
 * The kind→registry mapping mirrors `mapKindToType` in `emit-references.ts`:
 *
 *   | site.kind        | primary registry  | acceptedKinds source         |
 *   |------------------|-------------------|------------------------------|
 *   | `call`           | MethodRegistry    | METHOD_KINDS (Method/Func/Ctor)
 *   | `inherits`       | ClassRegistry     | CLASS_KINDS                  |
 *   | `type-reference` | ClassRegistry     | CLASS_KINDS (type-parameter shadow guard, #2899) |
 *   | `read`/`write`   | FieldRegistry     | FIELD_KINDS                  |
 *   | `import-use`     | tiered fallback   | METHOD ∪ CLASS ∪ FIELD       |
 *   | `value-ref`      | (skipped here)    | post-finalize walker in `emitPropertyDispatchCalls` |
 *   | `macro`          | MacroRegistry     | MACRO_KINDS (`Macro` only)   |
 *
 * `macro` has its own single-kind registry so a macro invocation
 * (`log!(…)`) resolves ONLY to a `macro_rules! log` definition and never
 * to a same-named free function — macros and functions are disjoint
 * namespaces (the false-`CALLS`-edge class flagged in the #1934 review).
 *
 * `import-use` doesn't have a single registry — the imported name might
 * be a class, a function, or a constant. Try each in priority order and
 * return the first non-empty result. Provenance still flows through the
 * scope's `bindings` (Step 1 lexical hit), so the lookup is correct
 * regardless of which registry surfaces the def.
 */
function lookupForSite(
  site: ReferenceSite,
  classRegistry: ClassRegistry,
  methodRegistry: MethodRegistry,
  fieldRegistry: FieldRegistry,
  macroRegistry: MacroRegistry,
  scopes: ScopeResolutionIndexes,
  recordSourceBinding?: SourceBindingRecorder,
): readonly Resolution[] {
  const lookupScope = site.lookupScope ?? site.inScope;
  const lookupOptions = {
    lookupPosition: site.atRange,
    lookupPurpose:
      site.lookupPurpose ??
      (site.kind === 'inherits' || site.kind === 'type-reference'
        ? ('type' as const)
        : ('value' as const)),
  };
  switch (site.kind) {
    case 'call': {
      const opts: Parameters<MethodRegistry['lookup']>[2] = {
        ...lookupOptions,
        ...(site.arity !== undefined ? { callsite: { arity: site.arity } } : {}),
        ...(site.explicitReceiver !== undefined ? { explicitReceiver: site.explicitReceiver } : {}),
      };
      return methodRegistry.lookup(site.name, lookupScope, opts);
    }
    case 'inherits': {
      return classRegistry.lookup(site.name, lookupScope, lookupOptions);
    }
    case 'type-reference': {
      // A TYPE PARAMETER SHADOWS A DECLARED TYPE OF THE SAME NAME (#2899).
      //
      // `export function unwrap<Result>(value: Result): Result` names the
      // parameter, not the `interface Result` next to it — tsc resolves BOTH
      // annotations to the parameter. Nothing in the type-reference path knew
      // that a parameter binds a name, so each annotation minted a `USES` edge
      // into the interface at the same confidence as a real consumer and
      // indistinguishable from one. Blast radius is every generic whose
      // parameter name collides with a declared type — `Result`, `Key`,
      // `Value`, `Item`, `Node`, `Options`, `Config`, `Props`, `State`.
      //
      // ASKED HERE, ON `site.name`, BECAUSE SHADOWING IS A PROPERTY OF THE NAME
      // WRITTEN AT THE SITE. This is the last point that still holds the
      // spelling — a `Reference` keeps only the resolved def — so a guard placed
      // after resolution has to substitute the DEF's name for the written one
      // and is then wrong in BOTH directions from the same substitution. It
      // deletes a genuine edge wherever the two differ and the def's name
      // happens to match a parameter (`import { Payload as ApiPayload }` written
      // inside `pluck<Payload>`), and it keeps a false one wherever the def's
      // name is qualified or position-suffixed and the written name is the
      // parameter (`Inner` resolving to `Host.Inner`, or a function-local
      // `Result@12:4`). Neither failure is recoverable from the resolved id,
      // because the information the question needs was never in it.
      //
      // TYPE REFERENCES ONLY, which is what asking on `kind` rather than on the
      // emitted EDGE TYPE buys. `mapReferenceKindToEdgeType` folds `value-ref`
      // (#2437) and `macro` (#1934) into the same `USES` edge, and neither is a
      // type annotation — a value or a macro whose name collides with an
      // enclosing type parameter is a different construct in a different
      // namespace, and dropping it would be a second false-negative class
      // bought with the fix for the first.
      //
      // Reuses the predicate #2833 introduced for the CALL-receiver path, which
      // stopped a workspace `class T` answering for `<T>` but never reached type
      // references. Absence is not evidence there and is not here:
      // `typeParameters` is populated only by languages whose captures were
      // extended for it, so a POSITIVE match declines and an absent list changes
      // nothing — which is what keeps every unconverted language unchanged.
      if (bindsTypeParameter(lookupScope, site.name, scopes)) {
        recordSourceBinding?.(site, {
          status: 'blocked',
          targetDefIds: [],
          basis: 'type-parameter',
        });
        return [];
      }
      return classRegistry.lookup(site.name, lookupScope, lookupOptions);
    }
    case 'read':
    case 'write': {
      // Try field first; fall through to method then class so bare-name
      // reads of a function (e.g. `cb = save`) still resolve.
      const fieldOpts: Parameters<FieldRegistry['lookup']>[2] = {
        ...lookupOptions,
        ...(site.explicitReceiver !== undefined ? { explicitReceiver: site.explicitReceiver } : {}),
      };
      const fieldHits = fieldRegistry.lookup(site.name, lookupScope, fieldOpts);
      // A BARE IDENTIFIER is not a member access. With no receiver there is no
      // object whose `Property` this could be, so a hit on one is a false edge:
      // in JS/TS/Python/Ruby a field read needs `this.` / `self.` / `@`, and the
      // bare name means the nearest lexical binding instead.
      //
      // Observed: `class Box { baseUrl = '...'; pick() { const baseUrl = ...;
      // return baseUrl; } }` linked the block-local read to `Box.baseUrl`,
      // duplicating the legitimate `this.baseUrl` edge. That predates the
      // TypeScript captures added here — JavaScript has emitted bare-identifier
      // reads since A2 and no class fixture exercised the shadow.
      //
      // Callables are deliberately still reachable: `cb = save` naming a
      // top-level function is a real bare-name reference, which is why the
      // method/class fallbacks below are untouched.
      const receiverlessFieldHits =
        site.explicitReceiver === undefined
          ? fieldHits.filter((hit) => hit.def?.type !== 'Property')
          : fieldHits;
      if (receiverlessFieldHits.length > 0) return receiverlessFieldHits;
      const methodHits = methodRegistry.lookup(site.name, lookupScope, lookupOptions);
      if (methodHits.length > 0) return methodHits;
      return classRegistry.lookup(site.name, lookupScope, lookupOptions);
    }
    case 'import-use': {
      // Try class, method, then field. The lexical-hit Step 1 in
      // `lookupCore` handles the actual binding lookup; the choice of
      // registry only narrows `acceptedKinds`.
      const classHits = classRegistry.lookup(site.name, lookupScope, lookupOptions);
      if (classHits.length > 0) return classHits;
      const methodHits = methodRegistry.lookup(site.name, lookupScope, lookupOptions);
      if (methodHits.length > 0) return methodHits;
      return fieldRegistry.lookup(site.name, lookupScope, lookupOptions);
    }
    case 'value-ref': {
      // Unreachable — filtered before lookup (post-finalize resolution in
      // `emitPropertyDispatchCalls`, #2437). Kept for switch exhaustiveness.
      return [];
    }
    case 'macro': {
      // Macro-only namespace: resolves against `Macro`-labeled defs, never
      // functions. No receiver, no arity — see `MacroRegistry`.
      return macroRegistry.lookup(site.name, lookupScope);
    }
  }
}

/** Compose a `Reference` record from a site + its top resolution. */
function buildReference(site: ReferenceSite, top: Resolution): Reference {
  return {
    fromScope: site.callerScope ?? site.inScope,
    toDef: top.def.nodeId,
    atRange: site.atRange,
    kind: site.kind,
    // The call form survives resolution so the graph bridge can mark
    // construction sites (`callForm: 'constructor'`) on the CALLS edge it
    // emits — a `Reference` otherwise keeps only the resolved def.
    ...(site.kind === 'call' && site.callForm !== undefined ? { callForm: site.callForm } : {}),
    ...(site.kind === 'call' && site.staticGated === true ? { staticGated: true } : {}),
    confidence: top.confidence,
    evidence: top.evidence,
  };
}

// Re-export the kind sets so consumers don't have to import them
// separately when constructing custom resolution flows. The mappings
// stay in `gitnexus-shared` (single source of truth); this is a
// convenience pass-through only.
export { CLASS_KINDS, METHOD_KINDS, FIELD_KINDS };
