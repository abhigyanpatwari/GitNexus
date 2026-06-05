import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cProvider } from '../c-cpp.js';
import { cArityCompatibility, cMergeBindings, resolveCImportTarget } from './index.js';
import { scanHeaderFiles } from './header-scan.js';
import { expandCWildcardNames, isStaticName, clearStaticNames } from './static-linkage.js';
import { applyCStaticLinkageSideChannel } from './capture-side-channel.js';

/**
 * Per-pass memo of the augmented `#include`-resolution file set
 * (`allFilePaths` ∪ header `.h` paths), keyed on the two stable source sets.
 *
 * `resolveImportTarget` is called once per C `#include`; the old code rebuilt
 * a fresh ~F-entry `Set` on EVERY call (O(R × (F+H)) inserts + GC churn) and,
 * worse, defeated `resolveCImportTarget`'s own per-set suffix-index memo by
 * handing it a new set identity each time. Both `allFilePaths` (built once in
 * scope-resolution `run.ts`) and the header set (`loadResolutionConfig`
 * result) are stable per pass, so the union is built once and reused.
 * `WeakMap`-keyed → reclaimed with the pass (no cross-pass staleness).
 */
const augmentedPathsByPass = new WeakMap<
  ReadonlySet<string>,
  WeakMap<ReadonlySet<string>, ReadonlySet<string>>
>();

function augmentedFilePaths(
  allFilePaths: ReadonlySet<string>,
  headerPaths: ReadonlySet<string>,
): ReadonlySet<string> {
  let byHeaders = augmentedPathsByPass.get(allFilePaths);
  if (byHeaders === undefined) {
    byHeaders = new WeakMap();
    augmentedPathsByPass.set(allFilePaths, byHeaders);
  }
  let augmented = byHeaders.get(headerPaths);
  if (augmented === undefined) {
    const set = new Set(allFilePaths);
    for (const h of headerPaths) set.add(h);
    augmented = set;
    byHeaders.set(headerPaths, augmented);
  }
  return augmented;
}

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

  // Worker-boundary restore (see `ScopeResolver.applyCaptureSideChannel`).
  // `emitCScopeCaptures` records per-file `static`-linkage names
  // (`markStaticName` → `staticNames`) as a SIDE EFFECT — that state is NOT
  // serialized onto the returned ParsedFile's scopes/defs. On the worker path
  // those marks are populated in the worker process and lost across the
  // MessageChannel / disk store; the main thread reuses the serialized
  // ParsedFile and skips `extractParsedFile`, so `isStaticName` (read by
  // `isFileLocalDef` and `expandCWildcardNames`) sees an empty map and C
  // `static` functions leak into cross-file global free-call resolution
  // (false CALLS edges) and `#include` wildcard imports. The worker stashed a
  // plain-data snapshot on `parsed.captureSideChannel` via
  // `cProvider.collectCaptureSideChannel`; this restores it into the module
  // map WITHOUT any tree-sitter re-parse (the #1983 fix). The
  // freshly-extracted leg never calls this — its marks were just populated in
  // this process. Runs BEFORE `populateOwners`.
  applyCaptureSideChannel: applyCStaticLinkageSideChannel,

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
    // Augment allFilePaths with .h files discovered via loadResolutionConfig
    // since the phase only passes .c files to the C resolver but #include
    // targets .h files classified as C++ in language detection.
    const headerPaths = resolutionConfig as ReadonlySet<string> | undefined;
    if (headerPaths !== undefined && headerPaths.size > 0) {
      return resolveCImportTarget(
        targetRaw,
        fromFile,
        augmentedFilePaths(allFilePaths, headerPaths),
      );
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
