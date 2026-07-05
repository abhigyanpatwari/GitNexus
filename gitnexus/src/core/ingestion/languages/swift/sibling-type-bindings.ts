/**
 * Swift same-module return-type typeBinding mirroring for the
 * `mirrorNamespaceTypeBindings` hook.
 *
 * Swift gives every file in a module (an SPM target) visibility of every
 * sibling's top-level declarations without a syntactic `import`. For a
 * chained call like
 *
 *   App.swift:    let user = getUser(); user.save()   // user → getUser → ?
 *   Models.swift: func getUser() -> User { … }        // getUser → User
 *
 * to resolve `user.save()` cross-file, App.swift's scope chain must be
 * able to follow `getUser → User`. The function return-type binding
 * (`getUser → User`) lives on Models.swift's module scope, so we mirror
 * sibling module-scope typeBindings into the importer's module scope —
 * the same trick Go uses (`mirrorGoNamespaceTypeBindings`), but Swift has
 * no namespace-import edges, so module membership is the SPM target
 * subtree (`Sources/<Target>/…`): threaded in via the SPM target map
 * (`resolutionConfig` → `coerceSwiftTargets`) and grouped by
 * `groupSwiftFilesBySpmTarget` (replicating legacy `groupSwiftFilesByTarget`;
 * no-source-dir → all files form one `__default__` module).
 *
 * Runs after `populateNamespaceSiblings` and before
 * `propagateImportedReturnTypes`, so the SCC-ordered propagation pass
 * sees the mirrored bindings and chains `user → getUser → User` to the
 * terminal class. Each mirrored binding is chain-followed inside its
 * source module first so we mirror the terminal type, not an intermediate
 * intra-module reference. `Scope.typeBindings` is mutated via the
 * sanctioned non-frozen Map cast (Contract Invariant I6).
 */

import type { ParsedFile, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../scope-resolution/workspace-index.js';
import { followChainPostFinalize } from '../../scope-resolution/passes/imported-return-types.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';

export function mirrorSwiftSiblingTypeBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  resolutionConfig?: unknown,
): void {
  const moduleScopeByFile = workspaceIndex.moduleScopeByFile;

  // Group files by SPM target subtree (the module). No-source-dir → all
  // files in one `__default__` bucket.
  const targets = coerceSwiftTargets(resolutionConfig);
  const filesByTarget = groupSwiftFilesBySpmTarget(
    parsedFiles,
    (parsed) => parsed.filePath,
    targets,
  );

  for (const [, group] of filesByTarget) {
    if (group.length < 2) continue; // no siblings to mirror from
    const files = group.map((parsed) => parsed.filePath);
    for (const importerFile of files) {
      const importerModule = moduleScopeByFile.get(importerFile);
      if (importerModule === undefined) continue;

      for (const sourceFile of files) {
        if (sourceFile === importerFile) continue;
        const sourceModule = moduleScopeByFile.get(sourceFile);
        if (sourceModule === undefined) continue;

        for (const [name, ref] of sourceModule.typeBindings) {
          if (name.length === 0) continue;
          // A local annotation on the importer must win over a sibling's.
          if (importerModule.typeBindings.has(name)) continue;

          const terminal = followChainPostFinalize(ref, sourceModule.id, indexes);
          (importerModule.typeBindings as Map<string, TypeRef>).set(name, terminal);
        }
      }
    }
  }
}
