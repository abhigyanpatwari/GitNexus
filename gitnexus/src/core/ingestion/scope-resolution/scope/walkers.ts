/**
 * Scope-chain lookup primitives shared across language providers.
 *
 * Five functions:
 *   - `findReceiverTypeBinding` — walk scope.typeBindings up the chain
 *     for a receiver name.
 *   - `lookupBindingsAt` — read finalized + augmented binding refs at
 *     one scope, deduped by `def.nodeId`. The dual-source-aware
 *     primitive every other binding lookup composes with.
 *   - `findClassBindingInScope` — walk scope.bindings + the indexes via
 *     `lookupBindingsAt` for a class-kind binding.
 *   - `findOwnedMember` — find a method/field owned by a class def
 *     across all parsed files by (ownerId, simpleName).
 *   - `findExportedDef` — find a file-level exported def (top-of-module
 *     class / function) by simpleName.
 *
 * Next-consumer contract: every OO or module-capable language hits the
 * same pre-finalize / post-finalize binding split and the same
 * "resolve member on owner with MRO" pattern. All four are reusable
 * as-is for TypeScript, Java, Kotlin, Ruby, etc.
 */

import type { BindingRef, ParsedFile, ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';

const EMPTY_BINDINGS: readonly BindingRef[] = Object.freeze([]);

/**
 * Look up binding refs at `scopeId` for `name`, consulting both the
 * finalize-owned `bindings` channel and the post-finalize
 * `bindingAugmentations` channel (see invariant I8 in
 * `contract/scope-resolver.ts`). Finalized refs come first; augmented
 * refs append, deduped by `def.nodeId` so a sibling that's also
 * explicitly imported doesn't double-emit.
 *
 * Returns a shared frozen empty array when neither channel has the
 * name — callers can compare against `=== EMPTY_BINDINGS` if they
 * want a fast-path miss check. The bucket arrays are returned by
 * reference when only one channel populates them; the merged path
 * allocates a fresh array.
 *
 * Walker primitives (`findClassBindingInScope`,
 * `findCallableBindingInScope`, `findExportedDefByName`) and
 * post-finalize passes that read finalized bindings (e.g.
 * `propagateImportedReturnTypes`, `namespace-targets`) MUST go
 * through this helper instead of `scopes.bindings.get(...)` directly,
 * so the augmentation channel is always visible.
 */
export function lookupBindingsAt(
  scopeId: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): readonly BindingRef[] {
  const finalized = scopes.bindings.get(scopeId)?.get(name);
  const augmented = scopes.bindingAugmentations.get(scopeId)?.get(name);
  const fLen = finalized?.length ?? 0;
  const aLen = augmented?.length ?? 0;
  if (fLen === 0 && aLen === 0) return EMPTY_BINDINGS;
  if (aLen === 0) return finalized!;
  if (fLen === 0) return augmented!;
  const seen = new Set<string>();
  const out: BindingRef[] = [];
  for (const r of finalized!) {
    seen.add(r.def.nodeId);
    out.push(r);
  }
  for (const r of augmented!) {
    if (seen.has(r.def.nodeId)) continue;
    out.push(r);
  }
  return out;
}

const EMPTY_NAMES: Iterable<string> = Object.freeze([]) as readonly string[];

/**
 * Return the union of bound names at `scopeId` across both the
 * finalized and augmented channels. Companion to `lookupBindingsAt`
 * for callers that need to iterate every name at a scope (e.g.
 * `propagateImportedReturnTypes`). Order is not guaranteed; callers
 * that need stable iteration should sort externally.
 *
 * Fast paths (zero allocation) when at most one channel is populated:
 * returns the underlying `Map.keys()` iterator directly. Only when both
 * channels carry names do we materialize a `Set` for deduplication.
 */
export function namesAtScope(scopeId: ScopeId, scopes: ScopeResolutionIndexes): Iterable<string> {
  const finalized = scopes.bindings.get(scopeId);
  const augmented = scopes.bindingAugmentations.get(scopeId);
  const fSize = finalized?.size ?? 0;
  const aSize = augmented?.size ?? 0;
  if (fSize === 0 && aSize === 0) return EMPTY_NAMES;
  if (aSize === 0) return finalized!.keys();
  if (fSize === 0) return augmented!.keys();
  const out = new Set<string>(finalized!.keys());
  for (const name of augmented!.keys()) out.add(name);
  return out;
}

/**
 * True when a def's `type` names a class-like declaration — every kind
 * that collapses to `@scope.class` in the scope-extractor query contract.
 *
 * Semantics widened historically from `'Class' | 'Interface'` to cover
 * C#-shape languages (struct, record, enum, trait). Languages that emit
 * only `'Class'` are unaffected — the extra kinds never appear in their
 * parsed output.
 */
export function isClassLike(t: string): boolean {
  return (
    t === 'Class' ||
    t === 'Interface' ||
    t === 'Struct' ||
    t === 'Record' ||
    t === 'Enum' ||
    t === 'Trait'
  );
}

/**
 * Walk the scope chain from `startScope` looking for a typeBinding
 * named `receiverName`. Returns the TypeRef or undefined if no binding
 * exists in the chain.
 */
export function findReceiverTypeBinding(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;
    const typeRef = scope.typeBindings.get(receiverName);
    if (typeRef !== undefined) return typeRef;
    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Look up a class-like binding by name in the given scope's chain.
 *
 * "Class-like" covers `Class | Interface | Struct | Record | Enum |
 * Trait` via the shared `isClassLike` predicate — every kind that
 * collapses to `@scope.class` in the scope-extractor query contract.
 *
 * Walks the scope chain upward and consults TWO sources at each step:
 *   1. `scope.bindings` — populated during scope-extraction Pass 2 with
 *      local declarations (`origin: 'local'`).
 *   2. The cross-file finalized + augmented bindings, via
 *      `lookupBindingsAt` (per I8: finalized = canonical immutable
 *      output; augmented = post-finalize hooks like
 *      `populateNamespaceSiblings`).
 *
 * Without (2) we'd miss every cross-file class-receiver call.
 */
export function findClassBindingInScope(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;

    const localBindings = scope.bindings.get(receiverName);
    if (localBindings !== undefined) {
      for (const b of localBindings) {
        if (isClassLike(b.def.type)) return b.def;
      }
    }

    const importedBindings = lookupBindingsAt(currentId, receiverName, scopes);
    for (const b of importedBindings) {
      if (isClassLike(b.def.type)) return b.def;
    }

    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Look up a callable (Function/Method/Constructor) by name in the
 * given scope's chain. Uses the dual-source pattern (scope.bindings +
 * `lookupBindingsAt` for finalized + augmented) so cross-file
 * imports are visible — without it free calls to imported functions
 * never resolve via the post-pass.
 *
 * Mirrors `findClassBindingInScope` exactly; only the accepted
 * def-type predicate differs.
 */
export function findCallableBindingInScope(
  startScope: ScopeId,
  callableName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;

    const localBindings = scope.bindings.get(callableName);
    if (localBindings !== undefined) {
      for (const b of localBindings) {
        if (b.def.type === 'Function' || b.def.type === 'Method' || b.def.type === 'Constructor') {
          return b.def;
        }
      }
    }

    const importedBindings = lookupBindingsAt(currentId, callableName, scopes);
    for (const b of importedBindings) {
      if (b.def.type === 'Function' || b.def.type === 'Method' || b.def.type === 'Constructor') {
        return b.def;
      }
    }

    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Populate `ownerId` on every def structurally owned by a Class
 * scope — methods (defs in Function scopes whose parent is Class)
 * and class-body fields (defs directly in Class scopes).
 *
 * Generic OO ownership rule. Languages that want richer ownership
 * (e.g. inner-class qualification) can compose with this as a base
 * step.
 *
 * Mutates `parsed.localDefs` in place via type cast — `SymbolDefinition`
 * is `readonly` for consumers but the extractor returns plain objects.
 * Defs are shared by reference between `localDefs` and `Scope.ownedDefs`,
 * so this single mutation is visible from both sides.
 */
export function populateClassOwnedMembers(parsed: ParsedFile): void {
  const scopesById = new Map<ScopeId, ParsedFile['scopes'][number]>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  // Promote a def's qualifiedName from `methodName` to `ClassName.methodName`
  // when the def sits inside a class. Without this, two classes in the
  // same file that share a method name collide at the graph-bridge lookup
  // (`node-lookup.ts` keys by (filePath, qualifiedName) and falls back to
  // simple name only). Python's scope query doesn't emit
  // `@declaration.qualified_name` for nested methods, so the finalized
  // defs arrive here with simple names — we stamp the qualifier while
  // we're already walking class scopes for ownerId.
  const qualify = (def: SymbolDefinition, classDef: SymbolDefinition): void => {
    const q = def.qualifiedName;
    if (q === undefined || q.length === 0) return;
    if (q.includes('.')) return; // already qualified (dotted)
    const classQ = classDef.qualifiedName;
    if (classQ === undefined || classQ.length === 0) return;
    (def as { qualifiedName: string }).qualifiedName = `${classQ}.${q}`;
  };

  // Depth invariant (verified empirically against Python scope-extractor
  // 2026-04-21): a nested `def helper` declared inside a method body
  // lives in its OWN Function scope whose parent is the method's Function
  // scope (not the Class scope). That means the `parentScope.kind ===
  // 'Class'` branch below only matches DIRECT class-scope children —
  // method defs themselves — and never stamps arbitrary nested defs with
  // `ownerId = classDef.nodeId`. If an adversarial reviewer raises this
  // as a potential false-attribution bug, verify first with a scope dump
  // on `class U: def save(self): def helper(): ...` — helper.ownerId will
  // remain undefined. The theoretical concern is real only if the
  // extractor ever stops creating scopes for inner defs.
  for (const scope of parsed.scopes) {
    // Methods: function scope whose parent is a Class scope. Owner is
    // the parent's class-like def.
    if (scope.parent !== null) {
      const parentScope = scopesById.get(scope.parent);
      if (parentScope !== undefined && parentScope.kind === 'Class') {
        const classDef = parentScope.ownedDefs.find((d) => isClassLike(d.type));
        if (classDef !== undefined) {
          for (const def of scope.ownedDefs) {
            (def as { ownerId?: string }).ownerId = classDef.nodeId;
            qualify(def, classDef);
          }
        }
      }
    }
    // Class-body fields: defs directly owned by a Class scope (the
    // class-like def itself excluded).
    if (scope.kind === 'Class') {
      const classDef = scope.ownedDefs.find((d) => isClassLike(d.type));
      if (classDef !== undefined) {
        for (const def of scope.ownedDefs) {
          if (def === classDef) continue;
          (def as { ownerId?: string }).ownerId = classDef.nodeId;
          qualify(def, classDef);
        }
      }
    }
  }
}

/**
 * Walk a scope chain upward looking for the innermost enclosing
 * Class scope and return that class's def. Used by per-language
 * `super` receiver branches to discover the dispatch base.
 */
export function findEnclosingClassDef(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;
    if (scope.kind === 'Class') {
      const cd = scope.ownedDefs.find((d) => isClassLike(d.type));
      if (cd !== undefined) return cd;
    }
    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Find a free-function def by simple name across all parsed files,
 * preferring scope-chain-visible bindings (import + finalized scope
 * bindings) before falling back to a workspace-wide simple-name scan.
 *
 * The fallback scan is intentionally loose so per-language compound
 * resolvers can find a callable target even when the binding chain
 * doesn't surface it (e.g. cross-package re-exports the finalize
 * pass missed). Strictly-typed languages may want to disable the
 * fallback by simply not calling this helper from their compound
 * resolver.
 */
export function findExportedDefByName(
  name: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = inScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) break;
    const local = scope.bindings.get(name);
    if (local !== undefined) {
      for (const b of local) {
        if (b.def.type === 'Function' || b.def.type === 'Method') return b.def;
      }
    }
    const finalized = lookupBindingsAt(currentId, name, scopes);
    for (const b of finalized) {
      if (b.def.type === 'Function' || b.def.type === 'Method') return b.def;
    }
    currentId = scope.parent;
  }
  // Workspace-wide fallback: iterate every file's Module scope (via
  // the scope-tied `moduleScopeByFile` lookup) and return the first
  // locally-declared callable binding matching `name`. First-seen-
  // by-file wins; bindings filtered to `origin === 'local'` and the
  // callable types Function/Method/Constructor. We walk scopes here
  // rather than consult `SemanticModel.symbols.lookupCallableByName`
  // because the `origin === 'local'` module-export-visibility filter
  // is a scope concept the raw symbol index doesn't express.
  for (const [, moduleScope] of index.moduleScopeByFile) {
    const refs = moduleScope.bindings.get(name);
    if (refs === undefined) continue;
    for (const ref of refs) {
      if (ref.origin !== 'local') continue;
      const t = ref.def.type;
      if (t === 'Function' || t === 'Method' || t === 'Constructor') return ref.def;
    }
  }
  return undefined;
}

/**
 * Find a member of a class by simple name — delegates to
 * `SemanticModel.methods` (methods / functions / constructors) with a
 * fallback to `SemanticModel.fields` (properties / fields /
 * variables). After `runScopeResolution`'s reconciliation pass
 * populates both registries from `parsed.localDefs[i].ownerId`
 * (post-`populateOwners`), this is the single authoritative view of
 * class membership — no parallel scope-resolution index needed.
 *
 * Returns the first-seen overload for methods without arity or
 * return-type narrowing. Callers that need arity-aware dispatch use
 * `lookupMethodByOwner(owner, name, argCount)` directly.
 */
export function findOwnedMember(
  ownerDefId: string,
  memberName: string,
  model: SemanticModel,
): SymbolDefinition | undefined {
  const method = model.methods.lookupAllByOwner(ownerDefId, memberName)[0];
  if (method !== undefined) return method;
  return model.fields.lookupFieldByOwner(ownerDefId, memberName);
}

/**
 * Find a file-level def (top-of-module class / function / variable)
 * by simple name — consults the target file's Module scope's
 * finalized bindings. Only defs bound at module-scope with
 * `origin === 'local'` qualify, matching the historical
 * "module-export-visible" semantics. Class methods and class-body
 * fields bind at their containing class scope and are naturally
 * excluded.
 *
 * Reads from `WorkspaceResolutionIndex.moduleScopeByFile` (scope-tied
 * lookup that doesn't live on `SemanticModel`). This intentionally
 * does NOT call `lookupBindingsAt`: `findExportedDef` answers "what
 * did the target file declare locally at module scope?", while
 * `bindingAugmentations` models importer-side visibility created by
 * post-finalize hooks. Callers that need importer-visible exports use
 * `findExportedDefByName`, which is dual-channel aware.
 */
export function findExportedDef(
  targetFile: string,
  memberName: string,
  index: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  const moduleScope = index.moduleScopeByFile.get(targetFile);
  if (moduleScope === undefined) return undefined;
  const refs = moduleScope.bindings.get(memberName);
  if (refs === undefined) return undefined;
  for (const ref of refs) {
    if (ref.origin === 'local') return ref.def;
  }
  return undefined;
}
