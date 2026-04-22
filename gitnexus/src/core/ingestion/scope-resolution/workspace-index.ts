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

import type { ParsedFile, Scope } from 'gitnexus-shared';

export interface WorkspaceResolutionIndex {
  /** Class def `nodeId` → that class's `Scope`. */
  readonly classScopeByDefId: ReadonlyMap<string, Scope>;

  /** Module scope by file path. */
  readonly moduleScopeByFile: ReadonlyMap<string, Scope>;
}

export function buildWorkspaceResolutionIndex(
  parsedFiles: readonly ParsedFile[],
): WorkspaceResolutionIndex {
  const classScopeByDefId = new Map<string, Scope>();
  const moduleScopeByFile = new Map<string, Scope>();

  for (const parsed of parsedFiles) {
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope !== undefined) moduleScopeByFile.set(parsed.filePath, moduleScope);

    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const cd = scope.ownedDefs.find((d) => d.type === 'Class');
      if (cd !== undefined) classScopeByDefId.set(cd.nodeId, scope);
    }
  }

  return { classScopeByDefId, moduleScopeByFile };
}
