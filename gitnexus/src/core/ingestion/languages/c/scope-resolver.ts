import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cProvider } from '../c-cpp.js';
import { cArityCompatibility, cMergeBindings, resolveCImportTarget } from './index.js';
import { scanHeaderFiles } from './header-scan.js';
import { expandCWildcardNames, isStaticName, clearStaticNames } from './static-linkage.js';

/**
 * C `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3).
 *
 * C is a structurally simple language for scope resolution:
 * - No classes (structs are value types, no method dispatch)
 * - No inheritance (no MRO needed beyond the shared first-wins default)
 * - No overloading (arity check is simple: variadic detection only)
 * - `#include` is wildcard import (all symbols from header are visible)
 * - `static` functions are file-local (not exported)
 */
export const cScopeResolver: ScopeResolver = {
  language: SupportedLanguages.C,
  languageProvider: cProvider,
  importEdgeReason: 'c-scope: include',

  loadResolutionConfig: (repoPath: string) => {
    // Clear stale static-linkage data from any previous invocation to
    // prevent cross-repo contamination in server-mode scenarios.
    clearStaticNames();
    return scanHeaderFiles(repoPath);
  },

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
    // Augment allFilePaths with .h files discovered via loadResolutionConfig
    // since the phase only passes .c files to the C resolver but #include
    // targets .h files classified as C++ in language detection.
    const headerPaths = resolutionConfig as ReadonlySet<string> | undefined;
    if (headerPaths !== undefined && headerPaths.size > 0) {
      const augmented = new Set(allFilePaths);
      for (const h of headerPaths) augmented.add(h);
      return resolveCImportTarget(targetRaw, fromFile, augmented);
    }
    return resolveCImportTarget(targetRaw, fromFile, allFilePaths);
  },

  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandCWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: (existing, incoming, scopeId) => cMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, def) => cArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: () => false,

  // C is statically typed — disable field fallback heuristic
  fieldFallbackOnMethodLookup: false,
  // C has no method return types to propagate
  propagatesReturnTypesAcrossImports: false,
  // C #include brings in all symbols — enable global free call fallback
  allowGlobalFreeCallFallback: true,
  // C `static` functions have file-local (translation-unit) linkage —
  // exclude them from global free-call fallback cross-file resolution.
  isFileLocalDef: (def: SymbolDefinition) => {
    const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
    return isStaticName(def.filePath, simple);
  },
};
