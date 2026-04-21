/**
 * Scope-chain lookup primitives shared across language providers.
 *
 * Four functions:
 *   - `findReceiverTypeBinding` — walk scope.typeBindings up the chain
 *     for a receiver name.
 *   - `findClassBindingInScope` — walk scope.bindings + indexes.bindings
 *     (pre-finalize + post-finalize) for a class-kind binding. Dual-
 *     source is required because the cross-file finalize pass produces
 *     a separate bindings map that is not merged back into scope.bindings.
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

import type { ParsedFile, ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';

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
 * Look up a class-kind binding by name in the given scope's chain.
 *
 * Walks the scope chain upward and consults TWO sources at each step:
 *   1. `scope.bindings` — populated during scope-extraction Pass 2 with
 *      local declarations (`origin: 'local'`).
 *   2. `indexes.bindings` — populated by the cross-file finalize pass
 *      with import/namespace/wildcard/reexport origins.
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
        if (b.def.type === 'Class' || b.def.type === 'Interface') return b.def;
      }
    }

    const finalizedScopeBindings = scopes.bindings.get(currentId);
    const importedBindings = finalizedScopeBindings?.get(receiverName);
    if (importedBindings !== undefined) {
      for (const b of importedBindings) {
        if (b.def.type === 'Class' || b.def.type === 'Interface') return b.def;
      }
    }

    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Look up a callable (Function/Method/Constructor) by name in the
 * given scope's chain. Uses the dual-source pattern (scope.bindings +
 * indexes.bindings) so cross-file imports are visible — without it
 * free calls to imported functions never resolve via the post-pass.
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

    const finalizedScopeBindings = scopes.bindings.get(currentId);
    const importedBindings = finalizedScopeBindings?.get(callableName);
    if (importedBindings !== undefined) {
      for (const b of importedBindings) {
        if (b.def.type === 'Function' || b.def.type === 'Method' || b.def.type === 'Constructor') {
          return b.def;
        }
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
  // simple name only). Python's `scopes.scm` doesn't emit
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
    // the parent's Class def.
    if (scope.parent !== null) {
      const parentScope = scopesById.get(scope.parent);
      if (parentScope !== undefined && parentScope.kind === 'Class') {
        const classDef = parentScope.ownedDefs.find((d) => d.type === 'Class');
        if (classDef !== undefined) {
          for (const def of scope.ownedDefs) {
            (def as { ownerId?: string }).ownerId = classDef.nodeId;
            qualify(def, classDef);
          }
        }
      }
    }
    // Class-body fields: defs directly owned by a Class scope (the
    // class def itself excluded).
    if (scope.kind === 'Class') {
      const classDef = scope.ownedDefs.find((d) => d.type === 'Class');
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
      const cd = scope.ownedDefs.find((d) => d.type === 'Class');
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
    const finalized = scopes.bindings.get(currentId)?.get(name);
    if (finalized !== undefined) {
      for (const b of finalized) {
        if (b.def.type === 'Function' || b.def.type === 'Method') return b.def;
      }
    }
    currentId = scope.parent;
  }
  // Workspace-wide fallback: O(1) lookup via the pre-built
  // `callablesBySimpleName` index. First-seen-by-file wins (matches
  // the previous nested-loop semantics where the outer iteration is
  // `parsedFiles`).
  return index.callablesBySimpleName.get(name)?.[0];
}

/**
 * Find a member of a class by simple name — O(1) lookup via the
 * pre-built `memberByOwner` index from `WorkspaceResolutionIndex`.
 *
 * Pre-index baseline: O(N × D) per call (full parsedFiles scan).
 * Indexed: O(1) `Map.get`. The receiver-bound dispatcher calls this
 * up to (sites × MRO depth) times per workspace.
 */
export function findOwnedMember(
  ownerDefId: string,
  memberName: string,
  index: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  return index.memberByOwner.get(ownerDefId)?.get(memberName);
}

/**
 * Find a file-level def (top-of-module class / function / variable)
 * by `simpleName` — O(1) lookup via the pre-built
 * `defsByFileAndName` index.
 */
export function findExportedDef(
  targetFile: string,
  memberName: string,
  index: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  return index.defsByFileAndName.get(targetFile)?.get(memberName);
}
