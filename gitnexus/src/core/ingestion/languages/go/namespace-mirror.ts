import type { ParsedFile, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../scope-resolution/workspace-index.js';
import { followChainPostFinalize } from '../../scope-resolution/passes/imported-return-types.js';

/**
 * Mirror exported typeBindings from namespace-import target modules
 * into the importer's module scope.
 *
 * Go uses namespace imports (`import "pkg"`) where the target package's
 * exported symbols are visible as `pkg.Func`. For cross-package return-type
 * resolution to work, the importer needs the target package's exported
 * typeBindings (e.g. `NewUser → User`) mirrored into its own module scope.
 *
 * Exported-symbol filter: Go uses uppercase first letter for exported names.
 */
export function mirrorGoNamespaceTypeBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
): void {
  const moduleScopeByFile = workspaceIndex.moduleScopeByFile;

  for (const parsed of parsedFiles) {
    const importerModule = moduleScopeByFile.get(parsed.filePath);
    if (importerModule === undefined) continue;

    const moduleEdges = indexes.imports.get(importerModule.id);
    if (moduleEdges === undefined) continue;

    const nsTargets = new Map<string, string[]>();
    for (const edge of moduleEdges) {
      if (edge.kind !== 'namespace' || edge.targetFile === null) continue;
      let targets = nsTargets.get(edge.localName);
      if (targets === undefined) {
        targets = [];
        nsTargets.set(edge.localName, targets);
      }
      if (!targets.includes(edge.targetFile)) targets.push(edge.targetFile);
    }

    for (const targetFiles of nsTargets.values()) {
      for (const targetFile of targetFiles) {
        const sourceModule = moduleScopeByFile.get(targetFile);
        if (sourceModule === undefined) continue;

        for (const [name, ref] of sourceModule.typeBindings) {
          if (name.length === 0) continue;
          const first = name[0]!;
          if (first < 'A' || first > 'Z') continue;
          if (importerModule.typeBindings.has(name)) continue;

          const terminal = followChainPostFinalize(ref, sourceModule.id, indexes);
          (importerModule.typeBindings as Map<string, TypeRef>).set(name, terminal);
        }
      }
    }
  }
}
