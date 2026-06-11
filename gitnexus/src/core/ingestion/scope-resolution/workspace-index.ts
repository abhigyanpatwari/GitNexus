/**
 * `WorkspaceResolutionIndex` — scope-tied lookup tables built ONCE
 * per resolution run, after `populateOwners` and before any
 * resolution pass.
 *
 * ## Scope (what lives here vs. what lives in `SemanticModel`)
 *
 * This index carries only the lookups that return a `Scope` — things
 * `SemanticModel` structurally cannot provide:
 *
 *   - `classScopeByDefId` — class def `nodeId` → `Scope`. Needed so
 *     passes can read `scope.bindings`, `scope.typeBindings`, and
 *     `scope.ownedDefs`. SemanticModel's `TypeRegistry` carries class
 *     metadata but not the `Scope`.
 *   - `classScopeIdToDefId` — inverse of `classScopeByDefId`. O(1)
 *     reverse lookup (Scope.id → class def nodeId) for the implicit-
 *     `this` overload picker.
 *   - `moduleScopeByFile` — file path → `Scope` of the root `Module`.
 *     Used by cross-file return-type propagation, `findExportedDef`,
 *     and `findExportedDefByName`'s workspace-wide fallback.
 *     SymbolTable indexes symbols, not scopes.
 *
 * Symbol lookups live on `SemanticModel`:
 *   - Owner-keyed method lookup → `model.methods.lookupAllByOwner`
 *     (populated by the legacy parse phase via `symbolTable.add` AND
 *     by scope-resolution's reconciliation pass in `runScopeResolution`,
 *     which adds `parsed.localDefs[i].ownerId` entries missed by the
 *     legacy extractor for registry-primary languages).
 *   - Name-keyed callable lookup → `model.methods.lookupMethodByName`
 *     and `model.symbols.lookupCallableByName`.
 *   - File-indexed symbol lookup → `model.symbols.lookupExactAll`.
 *
 * This split preserves the single-source-of-truth invariant
 * documented in `ScopeResolver`'s contract file: symbol-indexed
 * lookups live on `SemanticModel` for the whole codebase; only
 * scope-shaped lookups (which `SemanticModel` doesn't carry) live
 * here.
 *
 * Build cost is O(totalScopes). Read-only after construction.
 */

import type { ParsedFile, Scope, ScopeId, ScopeTree, SymbolDefinition } from 'gitnexus-shared';
import { isClassLike } from './scope/walkers.js';

export interface WorkspaceResolutionIndex {
  /** Class def `nodeId` → that class's `Scope`. */
  readonly classScopeByDefId: ReadonlyMap<string, Scope>;

  /** Inverse of `classScopeByDefId`: class `Scope.id` → class def `nodeId`.
   *  Built in the same pass; used by the implicit-`this` overload picker
   *  in `free-call-fallback.ts` to skip an O(C) reverse scan. */
  readonly classScopeIdToDefId: ReadonlyMap<ScopeId, string>;

  /** Module scope by file path. */
  readonly moduleScopeByFile: ReadonlyMap<string, Scope>;

  /** Precomputed `simpleName → first module-local callable def` (the
   *  workspace-wide fallback of `findExportedDefByName`). Materialized here
   *  ONCE from the resident module scopes so that fallback is an O(1) lookup
   *  instead of an O(files) scan over every module scope's bindings on each
   *  unresolved free call — which, under the disk-backed scopeTree, would
   *  otherwise fault every module scope in from disk per call (the throughput
   *  killer). "First module-local callable in `moduleScopeByFile` order" is the
   *  exact semantics the old scan returned, so it is byte-identical. */
  readonly exportedCallableByName: ReadonlyMap<string, SymbolDefinition>;
}

/**
 * A `ReadonlyMap<K, Scope>` view backed by a `K → ScopeId` map plus a
 * `ScopeTree`, holding **no `Scope` objects of its own** — `.get` fetches via
 * `scopeTree.getScope(id)`. Out-of-core scope index: the previous `Map<K, Scope>` form pinned every
 * class + module `Scope` (and its heavy `bindings` payload) through emit, which
 * defeated the disk-backed scope seal (the scopes stayed resident via this
 * index). Delegating to the `scopeTree` means the index pins only ids, so once
 * the tree seals to disk the scopes become collectible. Value-identical to a
 * stored `Scope` (`getScope` returns the same object resident, or a
 * value-identical revived one from disk), and iteration follows the `idByKey`
 * insertion order = the old map's order, so consumers are byte-identical.
 */
class ScopeByKeyView<K> implements ReadonlyMap<K, Scope> {
  constructor(
    private readonly idByKey: ReadonlyMap<K, ScopeId>,
    private readonly scopeTree: ScopeTree,
  ) {}

  get(key: K): Scope | undefined {
    const id = this.idByKey.get(key);
    return id === undefined ? undefined : this.scopeTree.getScope(id);
  }
  has(key: K): boolean {
    return this.idByKey.has(key);
  }
  get size(): number {
    return this.idByKey.size;
  }
  *entries(): MapIterator<[K, Scope]> {
    for (const [k, id] of this.idByKey) {
      const s = this.scopeTree.getScope(id);
      if (s !== undefined) yield [k, s];
    }
  }
  keys(): MapIterator<K> {
    return this.idByKey.keys();
  }
  *values(): MapIterator<Scope> {
    for (const [, s] of this.entries()) yield s;
  }
  forEach(cb: (value: Scope, key: K, map: ReadonlyMap<K, Scope>) => void, thisArg?: unknown): void {
    for (const [k, s] of this.entries()) cb.call(thisArg, s, k, this);
  }
  [Symbol.iterator](): MapIterator<[K, Scope]> {
    return this.entries();
  }
}

/**
 * Build the workspace scope-lookup index. When `scopeTree` is supplied (the live
 * pipeline), the `Scope`-valued maps are id-backed views that delegate to it —
 * so this index never pins `Scope` objects and the disk seal can actually
 * reclaim them. Without it (unit tests), the legacy direct `Map<K, Scope>` form
 * is returned unchanged.
 */
export function buildWorkspaceResolutionIndex(
  parsedFiles: readonly ParsedFile[],
  scopeTree?: ScopeTree,
): WorkspaceResolutionIndex {
  const classScopeIdByDefId = new Map<string, ScopeId>();
  const classScopeIdToDefId = new Map<ScopeId, string>();
  const moduleScopeIdByFile = new Map<string, ScopeId>();
  const exportedCallableByName = new Map<string, SymbolDefinition>();
  // Back-compat (no scopeTree): keep the direct Scope-object maps.
  const classScopeByDefIdDirect = scopeTree === undefined ? new Map<string, Scope>() : undefined;
  const moduleScopeByFileDirect = scopeTree === undefined ? new Map<string, Scope>() : undefined;

  for (const parsed of parsedFiles) {
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope !== undefined) {
      moduleScopeIdByFile.set(parsed.filePath, moduleScope.id);
      moduleScopeByFileDirect?.set(parsed.filePath, moduleScope);
      // Precompute the findExportedDefByName workspace fallback: first
      // module-local (origin 'local') callable per name, first file wins —
      // read from the resident bindings here, ONCE.
      for (const [name, refs] of moduleScope.bindings) {
        if (exportedCallableByName.has(name)) continue;
        for (const ref of refs) {
          if (ref.origin !== 'local') continue;
          const t = ref.def.type;
          if (t === 'Function' || t === 'Method' || t === 'Constructor') {
            exportedCallableByName.set(name, ref.def);
            break;
          }
        }
      }
    }

    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const cd = scope.ownedDefs.find((d) => isClassLike(d.type));
      if (cd !== undefined) {
        classScopeIdByDefId.set(cd.nodeId, scope.id);
        classScopeIdToDefId.set(scope.id, cd.nodeId);
        classScopeByDefIdDirect?.set(cd.nodeId, scope);
      }
    }
  }

  const classScopeByDefId: ReadonlyMap<string, Scope> =
    scopeTree === undefined
      ? classScopeByDefIdDirect!
      : new ScopeByKeyView(classScopeIdByDefId, scopeTree);
  const moduleScopeByFile: ReadonlyMap<string, Scope> =
    scopeTree === undefined
      ? moduleScopeByFileDirect!
      : new ScopeByKeyView(moduleScopeIdByFile, scopeTree);

  return { classScopeByDefId, classScopeIdToDefId, moduleScopeByFile, exportedCallableByName };
}
