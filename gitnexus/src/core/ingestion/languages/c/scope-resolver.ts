import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cProvider } from '../c-cpp.js';
import { cArityCompatibility, cMergeBindings, resolveCImportTarget } from './index.js';

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

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) =>
    resolveCImportTarget(targetRaw, fromFile, allFilePaths),

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
};
