import type { BindingRef, ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

/**
 * Expand Go dot imports (`import . "pkg"`) into binding augmentations.
 *
 * Go dot imports are treated as wildcard imports in the scope model.
 * The shared `expandsWildcardTo` hook defaults to returning `[]` for Go
 * because it can't easily access the target module's exported defs
 * (it only receives a `ScopeId`). Instead we post-process wildcard
 * import edges and augment bindings with the target file's exported
 * (uppercase) defs — the same augmentation channel used by
 * `populateGoPackageSiblings` for same-package cross-file visibility.
 */
export function expandGoDotImports(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  for (const parsed of parsedFiles) {
    const moduleEdges = indexes.imports.get(parsed.moduleScope);
    if (moduleEdges === undefined) continue;

    const wildcardTargets: string[] = [];
    for (const edge of moduleEdges) {
      // Go dot imports start as `kind: 'wildcard'`; finalize materializes
      // them as `wildcard-expanded` import edges.
      if (edge.kind !== 'wildcard-expanded' && edge.kind !== 'dynamic-resolved') {
        continue;
      }
      if (edge.targetFile === null) continue;
      if (!wildcardTargets.includes(edge.targetFile)) wildcardTargets.push(edge.targetFile);
    }
    if (wildcardTargets.length === 0) continue;

    for (const targetFile of wildcardTargets) {
      const targetModule = indexes.moduleScopes.byFilePath.get(targetFile);
      if (targetModule === undefined) continue;

      // Walk target module's local bindings — these are the exported symbols.
      const targetBindings = indexes.bindings.get(targetModule);
      if (targetBindings === undefined) continue;

      for (const [name, refs] of targetBindings) {
        if (name.length === 0) continue;
        // V1: ASCII-only export check; Unicode uppercase identifiers (e.g. Ñame)
        // are not recognized as exported. Conforms to Go community convention.
        const first = name[0]!;
        if (first < 'A' || first > 'Z') continue;

        // Check if the importer already has this name.
        const importerBindings = indexes.bindings.get(parsed.moduleScope);
        if (importerBindings?.has(name)) continue;

        let augBucket = augmentations.get(parsed.moduleScope);
        if (augBucket === undefined) {
          augBucket = new Map<string, BindingRef[]>();
          augmentations.set(parsed.moduleScope, augBucket);
        }

        let entries = augBucket.get(name);
        if (entries === undefined) {
          entries = [];
          augBucket.set(name, entries);
        }

        for (const ref of refs) {
          if (ref.origin !== 'local') continue;
          if (entries.some((e) => e.def.nodeId === ref.def.nodeId)) continue;
          entries.push({ def: ref.def, origin: 'wildcard' });
        }
      }
    }
  }
}

export function expandGoWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((parsed) => parsed.moduleScope === targetModuleScope);
  if (target === undefined) return [];

  const names: string[] = [];
  for (const def of target.localDefs) {
    const name = simpleName(def);
    if (name === '') continue;
    // V1: ASCII-only export check; see expandGoDotImports for full note.
    const first = name[0]!;
    if (first < 'A' || first > 'Z') continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function simpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}
