/**
 * The shape of `WorkspaceResolutionIndex` — the scope-tied lookup tables built
 * once per resolution run.
 *
 * A leaf module by design: it imports nothing from this package, so
 * `scope/walkers.ts` can type its `index` parameters against the contract
 * without importing the builder module that itself calls into `walkers.ts`.
 * `./workspace-index.ts` re-exports this type, so consumers may keep importing
 * `WorkspaceResolutionIndex` alongside `buildWorkspaceResolutionIndex` from
 * there.
 *
 * See `./workspace-index.ts` for what belongs in this index versus what belongs
 * on `SemanticModel`, and for the builder itself.
 */

import type { Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';

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
