/**
 * R `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by the
 * generic `runScopeResolution` orchestrator.
 *
 * Thin wiring: import resolution reuses `resolveRImportTarget`
 * (`import-resolvers/r.ts`), the adapter step 2 of this plan added over the
 * existing `resolveRImportInternal`, with the repo's local R packages
 * threaded through `loadRPackageConfig`. Heritage (R6 `inherit=`, S4
 * `contains=`) rides the generic `@reference.inherits` mechanism — R6/S4
 * base names are ordinary scope-bound class names, unlike Ruby's
 * `include`/`extend`, which are method calls and need a custom
 * `emitHeritageEdges` hook.
 */

import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { loadRPackageConfig } from '../../language-config.js';
import { resolveRImportTarget } from '../../import-resolvers/r.js';
import { rProvider } from '../r.js';
import { rArityCompatibility, rMergeBindings } from './simple-hooks.js';

/**
 * Enumerate all top-level names exported from a target module scope's file.
 * `library()`/`require()` are R's wildcard imports — every top-level name of
 * the named local package becomes visible, UNFILTERED by NAMESPACE (a
 * `library()`/`require()` call brings the whole package's namespace into
 * scope regardless of what NAMESPACE declares as exported — verified during
 * the plan's stress-test round: `pkgA/NAMESPACE` does not export `ResultSet`,
 * yet `require("pkgA")` must still resolve it).
 */
function expandRWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((p) => p.moduleScope === targetModuleScope);
  if (target === undefined) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    const qn = def.qualifiedName;
    if (qn === undefined || qn.length === 0 || qn.includes('.')) continue; // top-level only
    if (seen.has(qn)) continue;
    seen.add(qn);
    names.push(qn);
  }
  return names;
}

export const rScopeResolver: ScopeResolver = {
  language: SupportedLanguages.R,
  languageProvider: rProvider,
  importEdgeReason: 'r-scope: import',

  loadResolutionConfig: (repoPath: string) => loadRPackageConfig(repoPath),

  resolveImportTarget: resolveRImportTarget,

  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandRWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: rMergeBindings,
  arityCompatibility: rArityCompatibility,

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // R has no `super`.
  isSuperReceiver: () => false,

  // R's dynamic-dispatch `self$field$method()` chains and R6/S4 field access
  // benefit from the same heuristic Ruby/Python rely on.
  fieldFallbackOnMethodLookup: true,

  // `source()` is a side-effect import (binds no name) — a cross-file free
  // call into a `source()`d file (e.g. `HelperFunc(x)`) has no lexical or
  // import binding to resolve through, so it resolves via a unique
  // workspace-wide name match instead. `library()`/`require()`'s own
  // wildcard-bound names still resolve through `expandsWildcardTo` above;
  // this only covers what that path cannot reach.
  allowGlobalFreeCallFallback: true,
};
