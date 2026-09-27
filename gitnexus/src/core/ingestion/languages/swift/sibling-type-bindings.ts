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
 * sibling module-scope typeBindings where the importer can see them.
 *
 * Representation: one shared table per module in the language-neutral
 * `namespaceTypeBindings` channel (`swift-module:<key>`), made visible to each
 * member's module scope through `accessibleNamespacesByScope`. The chain
 * walkers (`findReceiverTypeBinding`, `followChainPostFinalize`) consult it
 * after the file's own scope chain, so a local annotation still wins. The
 * earlier form copied every sibling's bindings into every file's scope,
 * O(files² × names) (#3355); C# made the same move in #1871.
 *
 * Runs after `populateNamespaceSiblings` and before
 * `propagateImportedReturnTypes`. Each binding is chain-followed inside its
 * source module first so the table holds the terminal type, not an
 * intermediate intra-module reference. First declaration wins a name.
 */

import type { ParsedFile, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../scope-resolution/workspace-index.js';
import { followChainPostFinalize } from '../../scope-resolution/passes/imported-return-types.js';
import { groupSwiftFilesByModule } from './target-grouping.js';
import { grantSwiftModuleAccess, swiftModuleNamespace } from './target-siblings.js';

export function mirrorSwiftSiblingTypeBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  resolutionConfig?: unknown,
): void {
  const moduleScopeByFile = workspaceIndex.moduleScopeByFile;
  const namespaceTypes = indexes.namespaceTypeBindings as Map<string, Map<string, TypeRef>>;
  const modules = groupSwiftFilesByModule(
    parsedFiles,
    (parsed) => parsed.filePath,
    resolutionConfig,
    { allMemberships: true },
  );

  for (const [moduleKey, members] of modules) {
    if (members.length < 2) continue; // no siblings to mirror from
    const namespace = swiftModuleNamespace(moduleKey);
    let table = namespaceTypes.get(namespace);
    if (table === undefined) {
      table = new Map();
      namespaceTypes.set(namespace, table);
    }
    for (const parsed of members) {
      const sourceModule = moduleScopeByFile.get(parsed.filePath);
      if (sourceModule === undefined) continue;
      for (const [name, ref] of sourceModule.typeBindings) {
        if (name.length === 0 || table.has(name)) continue;
        table.set(name, followChainPostFinalize(ref, sourceModule.id, indexes));
      }
    }
    grantSwiftModuleAccess(members, namespace, indexes);
  }
}
