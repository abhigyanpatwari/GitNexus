/**
 * `WorkspaceResolutionIndex` — pre-computed lookup tables built ONCE
 * per resolution run, after `populateOwners` and before any
 * resolution pass.
 *
 * Why: the resolution passes hammer the same lookup patterns
 * thousands of times per run. Without an index, every
 * `findOwnedMember` / `findExportedDef` / scope-by-defId lookup
 * walks `parsedFiles` linearly — O(N × D) per call, multiplied by
 * the (N × S × M) call count from the receiver-bound MRO chain.
 * One pre-built index turns those into O(1) `Map.get`.
 *
 * Build cost is one O(totalDefs) pass over `parsedFiles`. Pays for
 * itself on the very first MRO walk.
 *
 * The index is read-only after construction — passes that create
 * defs (e.g. provider.populateOwners) MUST run before the index is
 * built.
 */

import type { ParsedFile, Scope, SymbolDefinition } from 'gitnexus-shared';
import { simpleQualifiedName } from './graph-bridge/ids.js';

export interface WorkspaceResolutionIndex {
  /** Class def `nodeId` → that class's `Scope`. */
  readonly classScopeByDefId: ReadonlyMap<string, Scope>;

  /** Owner def `nodeId` → (simple-member-name → owned `SymbolDefinition`).
   *  Replaces `findOwnedMember`'s O(N × D) walk with O(1) lookup.
   *  Built from `parsed.localDefs` so class-owned members land in the
   *  right bucket via their `ownerId`. */
  readonly memberByOwner: ReadonlyMap<string, ReadonlyMap<string, SymbolDefinition>>;

  /** File path → (simple-name → first matching module-scope-owned
   *  `SymbolDefinition`). Backs `findExportedDef` — the lookup for
   *  `from mod import X` / `mod.X()` targets. Only defs directly
   *  owned by the file's `Module` scope are indexed here; methods,
   *  fields, and nested-function defs are NOT visible as file-level
   *  exports. First-seen-within-module wins. */
  readonly defsByFileAndName: ReadonlyMap<string, ReadonlyMap<string, SymbolDefinition>>;

  /** Workspace-wide simple-name fallback: simple-name → all matching
   *  module-scope-owned Function/Method/Constructor defs. Backs the
   *  `findExportedDefByName` fallback scan. Class methods and nested
   *  functions are NOT eligible here — they are not import-visible
   *  callables. */
  readonly callablesBySimpleName: ReadonlyMap<string, readonly SymbolDefinition[]>;

  /** Module scope by file path — used by cross-file return-type
   *  propagation and by per-file imports lookup. */
  readonly moduleScopeByFile: ReadonlyMap<string, Scope>;
}

export function buildWorkspaceResolutionIndex(
  parsedFiles: readonly ParsedFile[],
): WorkspaceResolutionIndex {
  const classScopeByDefId = new Map<string, Scope>();
  const moduleScopeByFile = new Map<string, Scope>();
  const memberByOwner = new Map<string, Map<string, SymbolDefinition>>();
  const defsByFileAndName = new Map<string, Map<string, SymbolDefinition>>();
  const callablesBySimpleName = new Map<string, SymbolDefinition[]>();

  for (const parsed of parsedFiles) {
    // module scope by file
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope !== undefined) moduleScopeByFile.set(parsed.filePath, moduleScope);

    // class scopes
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const cd = scope.ownedDefs.find((d) => d.type === 'Class');
      if (cd !== undefined) classScopeByDefId.set(cd.nodeId, scope);
    }

    // Module-export pass — populates the file-level export lookup
    // and the workspace callable fallback with ONLY module-level
    // defs. "Module-level" here means: defs owned by the module scope
    // OR by any scope whose parent is the module scope (top-level
    // class and function declarations live in their own Class /
    // Function scopes whose parent is the module scope — not in
    // moduleScope.ownedDefs).
    //
    // Methods (Function/Method defs whose owning scope's parent is a
    // Class scope) and nested-function defs (parent is another
    // Function scope) are intentionally excluded — they are not
    // import-visible as `from mod import X` / `mod.X()` targets.
    // Without this filter, a class method can win the file-level
    // export lookup by parse order and produce silently wrong CALLS
    // edges.
    let fileBucket = defsByFileAndName.get(parsed.filePath);
    if (fileBucket === undefined) {
      fileBucket = new Map();
      defsByFileAndName.set(parsed.filePath, fileBucket);
    }
    if (moduleScope !== undefined) {
      const addExport = (def: SymbolDefinition): void => {
        const simple = simpleQualifiedName(def);
        if (simple === undefined) return;
        // First-seen wins to match `findExportedDef` semantics.
        if (!fileBucket!.has(simple)) fileBucket!.set(simple, def);
        if (def.type === 'Function' || def.type === 'Method' || def.type === 'Constructor') {
          let bucket = callablesBySimpleName.get(simple);
          if (bucket === undefined) {
            bucket = [];
            callablesBySimpleName.set(simple, bucket);
          }
          bucket.push(def);
        }
      };
      // Defs directly owned by the module scope (rare — usually
      // module-level variable assignments and re-exports).
      for (const def of moduleScope.ownedDefs) addExport(def);
      // Defs whose containing scope is a direct child of the module
      // scope — top-level class declarations and top-level function
      // declarations each get their own scope with parent = module.
      for (const scope of parsed.scopes) {
        if (scope.parent !== moduleScope.id) continue;
        for (const def of scope.ownedDefs) addExport(def);
      }
    }

    // Member-by-owner pass — keyed on `ownerId`, so it must iterate
    // `parsed.localDefs` (class-owned defs live in nested class scopes,
    // not the module scope). Requires populateOwners to have run first.
    for (const def of parsed.localDefs) {
      const ownerId = (def as { ownerId?: string }).ownerId;
      if (ownerId === undefined) continue;
      const simple = simpleQualifiedName(def);
      if (simple === undefined) continue;
      let memberBucket = memberByOwner.get(ownerId);
      if (memberBucket === undefined) {
        memberBucket = new Map();
        memberByOwner.set(ownerId, memberBucket);
      }
      // First-seen wins to match `findOwnedMember` semantics.
      if (!memberBucket.has(simple)) memberBucket.set(simple, def);
    }
  }

  return {
    classScopeByDefId,
    memberByOwner,
    defsByFileAndName,
    callablesBySimpleName,
    moduleScopeByFile,
  };
}
