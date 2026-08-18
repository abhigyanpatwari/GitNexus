/**
 * Zig `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by the
 * generic `runScopeResolution` orchestrator.
 *
 * Thin wiring: Zig has no inheritance (default MRO linearization over an
 * empty heritage set), no `super`, and is statically typed (field-fallback
 * heuristic off per the contract guidance). Import resolution reuses the
 * same `resolveZigImportInternal` the legacy import-resolver config wraps,
 * with `build.zig.zon` `.path` deps threaded through `loadResolutionConfig`.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { loadZigBuildConfig, type ZigBuildZonConfig } from '../../language-config.js';
import { resolveZigImportInternal } from '../../import-resolvers/zig.js';
import { zigProvider } from '../zig.js';
import { expandZigWildcardNames, zigArityCompatibility, zigMergeBindings } from './index.js';

export const zigScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Zig,
  languageProvider: zigProvider,
  importEdgeReason: 'zig-scope: import',

  loadResolutionConfig: (repoPath: string) => loadZigBuildConfig(repoPath),

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveZigImportInternal(
      fromFile,
      targetRaw,
      allFilePaths,
      (resolutionConfig as ZigBuildZonConfig | null | undefined) ?? null,
    ),

  // `pub usingnamespace @import("x.zig");` — target decls become local decls.
  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandZigWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: zigMergeBindings,
  arityCompatibility: zigArityCompatibility,

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // Zig has no `super`.
  isSuperReceiver: () => false,

  // Statically typed — the field-fallback heuristic over-connects.
  fieldFallbackOnMethodLookup: false,
};
